// NomuHub CRM as a Claude connector (Anton, 19 Oct 2026: "an API ... with
// access to read the data on all tabs ... connected to Claude as a connector,
// like the Meta connector"). This is a remote MCP server (Model Context
// Protocol, Streamable HTTP, stateless JSON) at /mcp, with its own OAuth so
// only someone who knows the dashboard password can connect.
//
// READ-ONLY by construction: every tool reads one of the dashboard's own
// endpoints over HTTP (the same data the tabs show, already sanitised: Trip
// Revenue in percentages only, leads as counts), and there is no tool that
// writes anything.
//
// It runs inside api/advisor.js (vercel.json rewrites /mcp, /oauth/* and the
// /.well-known OAuth documents there), because all 12 Vercel function slots
// are used. middleware.js lets these paths past the login gate: they check
// their own tokens.
//
// OAuth, stateless (nothing stored): dynamic client registration hands back a
// signed client_id that carries its redirect URIs; /oauth/authorize asks for
// the dashboard password; codes and tokens are HMAC-signed, expire, and are
// keyed with the password, so changing DASHBOARD_PASSWORD disconnects every
// connector, like it signs every browser out.

const crypto = require('crypto');
const kv = require('./kv');
const { buildContext } = require('./advisor-context');

const VERSION = '1.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ACCESS_TTL = 30 * 24 * 3600; // 30 days
const REFRESH_TTL = 180 * 24 * 3600; // 180 days
const CODE_TTL = 300; // 5 minutes

const muscatToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const now = () => Math.floor(Date.now() / 1000);

function secretKey() {
  const password = (process.env.DASHBOARD_PASSWORD || '').trim();
  const secret = (process.env.SESSION_SECRET || process.env.CAMPAIGN_ALERT_SECRET || '').trim();
  return `${secret}|${password}|mcp-v1`;
}
// A signed, expiring blob: "<payload>.<hmac>".
function seal(obj) {
  const body = b64u(JSON.stringify(obj));
  const sig = b64u(crypto.createHmac('sha256', secretKey()).update(body).digest());
  return `${body}.${sig}`;
}
function unseal(token, typ) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = b64u(crypto.createHmac('sha256', secretKey()).update(body).digest());
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  let obj;
  try { obj = JSON.parse(fromB64u(body)); } catch (e) { return null; }
  if (typ && obj.typ !== typ) return null;
  if (obj.exp && obj.exp < now()) return null;
  return obj;
}

function origin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}
function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (body === undefined) return res.end();
  if (typeof body === 'string') return res.end(body);
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify(body));
}
function form(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return Object.fromEntries(new URLSearchParams(req.body)); }
  }
  return {};
}
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- OAuth ---------------- */

function protectedResource(req, res) {
  const o = origin(req);
  return send(res, 200, { resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ['header'], resource_name: 'NomuHub CRM' });
}
function authServer(req, res) {
  const o = origin(req);
  return send(res, 200, {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['crm.read'],
  });
}

// Dynamic client registration: the client_id itself carries the allowed
// redirect URIs, signed, so nothing has to be stored.
function register(req, res) {
  const b = form(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) : [];
  if (!uris.length) return send(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs' });
  const clientId = seal({ typ: 'client', uris, name: String(b.client_name || 'Claude').slice(0, 80) });
  const method = ['client_secret_post', 'client_secret_basic'].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : 'none';
  const out = {
    client_id: clientId,
    client_id_issued_at: now(),
    client_name: String(b.client_name || 'Claude').slice(0, 80),
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
  };
  if (method !== 'none') { out.client_secret = seal({ typ: 'secret', cid: clientId.slice(-16) }); out.client_secret_expires_at = 0; }
  return send(res, 201, out);
}

function authorizePage(q, error) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map((k) => (q[k] ? `<input type="hidden" name="${k}" value="${escHtml(q[k])}">` : '')).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Claude to NomuHub CRM</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; background: linear-gradient(160deg, #1f97aa, #116a78); color: #0f2f38; }
  .card { width: 100%; max-width: 400px; background: #fff; border-radius: 18px; padding: 28px 26px 24px; box-shadow: 0 24px 60px rgba(0,0,0,.25); }
  img { width: 64px; height: 64px; border-radius: 14px; display: block; margin-bottom: 14px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #3e5d68; }
  ul { margin: 0 0 18px; padding-left: 18px; font-size: 13px; line-height: 1.6; color: #3e5d68; }
  label { display: block; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #527079; margin-bottom: 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; font: inherit; font-size: 15px; padding: 11px 12px; border-radius: 10px; border: 1px solid #cfe2e7; }
  button { margin-top: 14px; width: 100%; font: inherit; font-size: 15px; font-weight: 700; padding: 12px; border: 0; border-radius: 10px; background: #137483; color: #fff; cursor: pointer; }
  .err { margin-bottom: 12px; padding: 9px 12px; border-radius: 9px; background: #fbe3e1; color: #9a2f27; font-size: 13.5px; }
</style></head><body><form class="card" method="post" action="/oauth/authorize">
<img src="/brand/icon-192.png" alt="">
<h1>Connect Claude to NomuHub CRM</h1>
<p>Claude will be able to <b>read</b> the dashboard: bookings, leads, campaigns, engagements, trips, feedback, trip revenue (percentages), KPIs and tasks. It can't change anything.</p>
${error ? `<div class="err">${escHtml(error)}</div>` : ''}
<label for="pw">Dashboard password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
${hidden}
<button type="submit">Allow read access</button>
</form></body></html>`;
}

async function authorize(req, res) {
  const q = req.method === 'POST' ? form(req) : req.query;
  const client = unseal(q.client_id, 'client');
  if (!client) return send(res, 400, 'Unknown client. Remove the connector in Claude and add it again.', { 'Content-Type': 'text/plain' });
  if (!q.redirect_uri || !client.uris.includes(q.redirect_uri)) return send(res, 400, 'This redirect address is not registered for the client.', { 'Content-Type': 'text/plain' });
  if (!q.code_challenge || (q.code_challenge_method && q.code_challenge_method !== 'S256')) return send(res, 400, 'PKCE (S256) is required.', { 'Content-Type': 'text/plain' });
  if (req.method !== 'POST') return send(res, 200, authorizePage(q), { 'Content-Type': 'text/html; charset=utf-8' });

  // Same wrong-password limit as the dashboard's login page.
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const failKey = `login-fail:${ip}`;
  let fails = 0;
  try { fails = kv.configured() ? Number((await kv.command('GET', failKey)) || 0) : 0; } catch (e) { fails = 0; }
  if (fails >= 10) return send(res, 429, authorizePage(q, 'Too many tries. Wait 15 minutes and try again.'), { 'Content-Type': 'text/html; charset=utf-8' });
  const password = (process.env.DASHBOARD_PASSWORD || '').trim();
  const given = String(q.password || '');
  const ok = password && given.length === password.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(password));
  if (!ok) {
    try { if (kv.configured()) await kv.pipeline([['INCR', failKey], ['EXPIRE', failKey, 900]]); } catch (e) { /* not counted */ }
    return send(res, 401, authorizePage(q, 'That password is not right.'), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  const code = seal({ typ: 'code', cid: q.client_id.slice(-24), ru: q.redirect_uri, cc: q.code_challenge, exp: now() + CODE_TTL });
  const to = new URL(q.redirect_uri);
  to.searchParams.set('code', code);
  if (q.state) to.searchParams.set('state', q.state);
  return send(res, 302, undefined, { Location: to.toString() });
}

function issue(res) {
  return send(res, 200, {
    access_token: seal({ typ: 'access', exp: now() + ACCESS_TTL }),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: seal({ typ: 'refresh', exp: now() + REFRESH_TTL }),
    scope: 'crm.read',
  });
}

function token(req, res) {
  const b = form(req);
  if (b.grant_type === 'authorization_code') {
    const c = unseal(b.code, 'code');
    if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'code expired or invalid' });
    if (b.redirect_uri && b.redirect_uri !== c.ru) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    if (b.client_id && b.client_id.slice(-24) !== c.cid) return send(res, 400, { error: 'invalid_grant', error_description: 'client mismatch' });
    const verifier = String(b.code_verifier || '');
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    if (!verifier || challenge !== c.cc) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE check failed' });
    return issue(res);
  }
  if (b.grant_type === 'refresh_token') {
    if (!unseal(b.refresh_token, 'refresh')) return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token expired or invalid' });
    return issue(res);
  }
  return send(res, 400, { error: 'unsupported_grant_type' });
}

/* ---------------- the CRM's data ---------------- */

// Each tool reads one of the dashboard's endpoints, as the tabs do.
async function readEndpoint(base, path) {
  const secret = (process.env.CAMPAIGN_ALERT_SECRET || '').trim();
  const r = await fetch(base + path, { signal: AbortSignal.timeout(60000), headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return j;
}
const json = (x) => JSON.stringify(x);
const inRange = (day, from, to) => (!from || day >= from) && (!to || day <= to);
const muscatDay = (at) => new Date(Date.parse(at) + 4 * 3600 * 1000).toISOString().slice(0, 10);

const TOOLS = [
  {
    name: 'get_crm_overview',
    title: 'Whole CRM overview',
    description: 'One compact text summary of every part of the NomuHub CRM: bookings (upcoming departures, recent weeks and months), leads and high potential leads, conversion, Meta ad campaigns and budget, Instagram engagement, trip products and R&D, guest feedback, trip margins, KPIs passed or failed, and pending monday.com tasks, with the targets. Start here for any broad question, then use the specific tools for detail.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (base) => buildContext(base, muscatToday()),
  },
  {
    name: 'get_upcoming_departures',
    title: 'Upcoming departures (Booking)',
    description: 'Every upcoming trip on sale in WeTravel with its departure weeks: seats booked, capacity, cancelled or unavailable weeks, and the per-week target (Sales › Booking). Optional filters: destination code (e.g. TH, ZNZ, BA, VN, SL, KN) and month (YYYY-MM).',
    inputSchema: { type: 'object', properties: { destination: { type: 'string', description: 'Destination code, e.g. TH, ZNZ, BA' }, month: { type: 'string', description: 'Departure month, YYYY-MM' } }, additionalProperties: false },
    run: async (base, a) => {
      const p = await readEndpoint(base, '/api/trips-progress');
      if (p.trips) p.trips = p.trips.filter((t) => (!a.destination || String(t.pd || '').toUpperCase() === String(a.destination).toUpperCase()) && (!a.month || String(t.start).startsWith(a.month)));
      return json(p);
    },
  },
  {
    name: 'get_bookings_taken',
    title: 'Bookings taken (Report)',
    description: 'Bookings taken, one entry per WeTravel order with when it was placed (Muscat time), trip, travellers (n), cancelled (c) and destination / programme codes (pd / pg); x marks charters, which the targets leave out. Covers about the last 300 days (Sales › Report). Target: 12 bookings a week, Sunday to Saturday. Optional from / to dates (YYYY-MM-DD).',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } }, additionalProperties: false },
    run: async (base, a) => {
      const p = await readEndpoint(base, '/api/booking-report');
      if (p.events) p.events = p.events.filter((e) => inRange(muscatDay(e.at), a.from, a.to));
      return json(p);
    },
  },
  {
    name: 'get_sales_history',
    title: 'Previous sales and bookings by month',
    description: 'Bookings taken per month since 2019 across all trips (charters out), split by project (destination|programme), plus every past departure with its project code and seats (Sales › Previous Sales). Optional year (YYYY) limits the departures list.',
    inputSchema: { type: 'object', properties: { year: { type: 'string', description: 'YYYY, limits the past departures list' } }, additionalProperties: false },
    run: async (base, a) => {
      const p = await readEndpoint(base, '/api/previous-trips');
      if (p.sales && p.sales.months) for (const m of Object.values(p.sales.months)) delete m.byDay;
      if (a.year && p.trips) p.trips = p.trips.filter((t) => String(t.start || '').startsWith(a.year));
      return json(p);
    },
  },
  {
    name: 'get_leads',
    title: 'Leads and high potential leads',
    description: "Leads per week and per day from Marina's sheet (counts only, no personal details): WhatsApp / Instagram split, high potential (HP) leads, and per project. Data starts 1 Jul 2026. Targets: 20 leads and 5 HP a day; conversion (bookings ÷ leads, weekly) 10%.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (base) => json(await readEndpoint(base, '/api/sheets?name=leads')),
  },
  {
    name: 'get_ad_campaigns',
    title: 'Meta ad campaigns (this year)',
    description: 'Every Meta (Facebook / Instagram) ad campaign this year: status, spend, results, cost per result, budget from the media plan, daily budget, and lead quality for running campaigns. Money in SAR. Cost per result limit: SAR 25 (Marketing › Campaign Ads).',
    inputSchema: { type: 'object', properties: { running_only: { type: 'boolean', description: 'Only campaigns running now' } }, additionalProperties: false },
    run: async (base, a) => {
      const p = await readEndpoint(base, '/api/campaigns');
      if (a.running_only && p.campaigns) p.campaigns = p.campaigns.filter((c) => c.status === 'Active');
      return json(p);
    },
  },
  {
    name: 'get_campaign_history',
    title: 'Past years of ad campaigns',
    description: 'Meta ad campaigns for one past calendar year (Marketing › Campaign History). Meta keeps about 37 months.',
    inputSchema: { type: 'object', properties: { year: { type: 'string', description: 'YYYY, a past year' } }, required: ['year'], additionalProperties: false },
    run: async (base, a) => json(await readEndpoint(base, `/api/campaign-history?year=${encodeURIComponent(a.year)}`)),
  },
  {
    name: 'get_social_engagement',
    title: 'Instagram posts and stories',
    description: "Instagram posts (views, likes, comments, shares, saves, engagement rate, content type, CTA) and stories (views, responses, poll results) from Maryam's sheet (Marketing › Engagements).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (base) => json(await readEndpoint(base, '/api/sheets?name=engagements')),
  },
  {
    name: 'get_trip_products',
    title: 'Trip products and R&D',
    description: 'Every trip product with region, destination, weeks, price, quality rating (High / Medium / Low), product and R&D status, analysis and corrective actions (Operations › Trips & R&D).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (base) => json(await readEndpoint(base, '/api/sheets?name=trips')),
  },
  {
    name: 'get_guest_feedback',
    title: 'Guest feedback',
    description: 'Trip survey results: satisfaction, per-question scores (1 to 5), hotel and activity scores, and verbatim comments, with escalations flagged (Operations › Feedback).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (base) => json(await readEndpoint(base, '/api/sheets?name=feedback')),
  },
  {
    name: 'get_trip_margins',
    title: 'Trip revenue (margins only)',
    description: 'Profit margin per trip, month and programme, and rule-based suggestions. Percentages only: amounts are never shared (Operations › Trip Revenue).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (base) => json(await readEndpoint(base, '/api/sheets?name=revenue')),
  },
  {
    name: 'get_kpis',
    title: 'KPIs passed and failed',
    description: 'Every sales and marketing KPI checked today, Passed / Failed, with why and what to do (Corporate › KPIs).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (base) => json(await readEndpoint(base, '/api/sheets?name=kpis')),
  },
  {
    name: 'get_pending_tasks',
    title: 'Pending monday.com tasks',
    description: 'Every monday.com task not marked Done on the Operations, Marketing and Sales boards: name, status, assignees, due date, overdue (Corporate › Monday Tasks).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (base) => json(await readEndpoint(base, '/api/sheets?name=pending')),
  },
];

const listTools = () => TOOLS.map(({ name, title, description, inputSchema }) => ({
  name, title, description, inputSchema,
  annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

async function rpc(msg, base) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    return ok({
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'nomuhub-crm', title: 'NomuHub CRM', version: VERSION },
      instructions: "NomuHub's CRM dashboard, read-only. NomuHub runs volunteering, wellness and explore trips. Start with get_crm_overview for the whole picture, then the specific tools. Times are Muscat (UTC+4); weeks run Sunday to Saturday; money in SAR; trip revenue is percentages only.",
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: listTools() });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === (params && params.name));
    if (!tool) return fail(-32602, `Unknown tool: ${params && params.name}`);
    try {
      const text = await tool.run(base, (params && params.arguments) || {});
      return ok({ content: [{ type: 'text', text }] });
    } catch (err) {
      return ok({ content: [{ type: 'text', text: `Could not read the dashboard: ${err.message}` }], isError: true });
    }
  }
  if (method === 'resources/list') return ok({ resources: [] });
  if (method === 'prompts/list') return ok({ prompts: [] });
  if (id === undefined || id === null) return null; // a notification: no reply
  return fail(-32601, `Method not found: ${method}`);
}

async function mcp(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204);
  const o = origin(req);
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!unseal(tok, 'access')) {
    return send(res, 401, { error: 'invalid_token', error_description: 'Connect through Claude to sign in.' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource"`,
    });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { Allow: 'POST, OPTIONS' });
  const body = form(req);
  const base = (process.env.DASHBOARD_URL || o).replace(/\/$/, '');
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => rpc(m, base)))).filter(Boolean);
    return out.length ? send(res, 200, out) : send(res, 202);
  }
  const out = await rpc(body, base);
  return out ? send(res, 200, out) : send(res, 202);
}

// Entry point, from api/advisor.js. `route` comes from the vercel.json rewrite.
module.exports = async function handle(req, res, route) {
  if (!(process.env.DASHBOARD_PASSWORD || '').trim()) return send(res, 503, { error: 'Set DASHBOARD_PASSWORD in Vercel first.' });
  if (req.method === 'OPTIONS') return send(res, 204);
  switch (route) {
    case 'mcp': return mcp(req, res);
    case 'protected-resource': return protectedResource(req, res);
    case 'authorization-server': return authServer(req, res);
    case 'register': return register(req, res);
    case 'authorize': return authorize(req, res);
    case 'token': return token(req, res);
    default: return send(res, 404, { error: 'not found' });
  }
};
module.exports.TOOLS = TOOLS;
module.exports.rpc = rpc;
module.exports.seal = seal;
module.exports.unseal = unseal;
