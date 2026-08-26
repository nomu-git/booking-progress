// Shared helper for Meta's Marketing API (Graph API).
//
// Unlike WeTravel there's no token exchange here — the System User token from
// Business Settings is already long-lived (generated with no expiry), so it's
// carried straight on each call.

const crypto = require('crypto');

const API_VERSION = process.env.META_API_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;

// The two NomuHub ad accounts. Kept as a default so the board keeps working if
// the env var is ever dropped, same pattern as the WeTravel trip lists.
const AD_ACCOUNTS = (
  process.env.META_AD_ACCOUNT_IDS || 'act_477109619020477,act_102558343888994'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  // Meta wants the act_ prefix; tolerate a bare numeric id being pasted in.
  .map((id) => (/^act_/.test(id) ? id : `act_${id}`));

// Which env var actually holds the token has bitten this project once already,
// so accept the obvious spellings and name all of them if none is present.
const TOKEN_VARS = ['META_ACCESS_TOKEN', 'META_ACCESS_KEY', 'META_API_KEY'];

function getToken() {
  for (const name of TOKEN_VARS) {
    const value = (process.env[name] || '').trim();
    if (value) return value;
  }
  throw new Error(`Meta access token is not set (looked for ${TOKEN_VARS.join(', ')})`);
}

// Some Meta apps are configured to require a proof-of-secret alongside the
// token. Only sent when the secret is available, since apps without the
// setting reject unexpected parameters.
function appSecretProof(token) {
  const secret = (process.env.META_APP_SECRET || '').trim();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

async function graphGet(path, params = {}, attempt = 0) {
  const token = getToken();
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }
  url.searchParams.set('access_token', token);
  const proof = appSecretProof(token);
  if (proof) url.searchParams.set('appsecret_proof', proof);

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const err = (body && body.error) || {};
    // Code 17 / 613 are Meta's rate limits, 613 also covers transient throttling.
    if ((err.code === 17 || err.code === 613 || res.status === 429) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 3000));
      return graphGet(path, params, attempt + 1);
    }
    const detail = err.message || `HTTP ${res.status}`;
    throw new Error(`Meta ${path} failed: ${detail}`);
  }

  return body;
}

// Graph paginates with an opaque `next` URL rather than page numbers.
async function graphGetAll(path, params = {}, cap = 20) {
  const first = await graphGet(path, { ...params, limit: params.limit || 500 });
  const rows = [...((first && first.data) || [])];
  let next = first && first.paging && first.paging.next;

  for (let page = 1; page < cap && next; page++) {
    const res = await fetch(next, { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok) break;
    rows.push(...((body && body.data) || []));
    next = body && body.paging && body.paging.next;
  }
  return rows;
}

module.exports = { graphGet, graphGetAll, AD_ACCOUNTS, API_VERSION, TOKEN_VARS };
