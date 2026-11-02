// WeTravel bookings -> the trip's Project Sheet (Travellers Data tab).
//
// Anton, 1 Nov 2026: every traveller who books on WeTravel should land in the
// trip's Project Sheet on SharePoint without anyone retyping their checkout
// answers, and never twice. Operations still edits the sheet by hand, so the
// sheet is treated as theirs: this only ever ADDS a row into an empty row of
// the right week block, fills EMPTY cells of a row it added itself, and turns
// a cancelled traveller's row red (their own rule: cancelled stay, in red).
// It never deletes a row, never overwrites a cell that has anything in it,
// and when it can't tell whether someone is already there it reports instead
// of adding.
//
// How it runs:
//   - WeTravel webhook (booking.created / booking.updated, delivered by Svix)
//     -> POST /hooks/wetravel. The event only says WHICH trip changed; the
//     whole trip is then reconciled from the API, so a retried, duplicated
//     or out-of-order event can't add anyone twice.
//   - Daily Vercel cron -> every upcoming trip, as a safety net for missed
//     events and for checkout answers filled in after booking.
//   - Manually: GET /api/traveller-sync?trip=<uuid> with the Bearer secret.
//
// Safety switches (Vercel env):
//   TRAVELLER_SYNC_MODE   off | dry | live   (default dry: plans, writes nothing)
//   TRAVELLER_SYNC_TRIPS  comma list of WeTravel trip ids to limit it to
//
// Personal data: traveller details go from WeTravel to the sheet and nowhere
// else. The site is public, so nothing this returns or logs carries a name,
// email, phone or answer; a dry run shows initials, the week and the row.
//
// WeTravel side: the existing WETRAVEL_API_KEY (lib/wetravel.js), unchanged.
// WeTravel offers no second key, and a new one would revoke the dashboard's.

const crypto = require('crypto');
const { apiGet, mapWithConcurrency } = require('./wetravel');
const { buildCode } = require('./trip-code');
const kv = require('./kv');

const MODE = () => (process.env.TRAVELLER_SYNC_MODE || 'dry').trim().toLowerCase();
const ONLY_TRIPS = () => new Set((process.env.TRAVELLER_SYNC_TRIPS || '').split(',').map((s) => s.trim()).filter(Boolean));
const SKIP_TRIPS = () => new Set((process.env.TRAVELLER_SYNC_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));
const TRIPS_ROOT = () => (process.env.TRAVELLER_SYNC_ROOT || '03. Operations/01 Trips').replace(/^\/+|\/+$/g, '');
const SHEET_NAME = () => process.env.TRAVELLER_SYNC_SHEET || 'Travellers Data';
const SCAN_ROWS = 600; // rows read from the sheet; blocks are a few dozen rows each
const COLS = 'ABCDEFGHIJKLMNOPQRST'.split(''); // A..T, the Travellers Data columns
const TIME_BUDGET_MS = 250 * 1000; // advisor.js has maxDuration 300

// ---------------------------------------------------------------------------
// Pure helpers (no I/O), exported for the tests.

const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const lower = (v) => clean(v).toLowerCase();
// Names compared without case, spaces, dots or hyphens, so "Al-Akkad" and
// "al akkad" meet; Arabic letters pass through unchanged.
const normName = (v) => lower(v).replace(/[\s.\-_'’]+/g, '');

const weekNo = (label) => {
  const m = /\bweek\s*0*(\d+)/i.exec(String(label || ''));
  return m ? Number(m[1]) : null;
};

// A survey answer may come as a string, a list, or {value}/{label} objects.
function answerText(a) {
  if (a == null) return '';
  if (Array.isArray(a)) return a.map(answerText).filter(Boolean).join(', ');
  if (typeof a === 'object') return answerText(a.value ?? a.label ?? a.text ?? a.answer ?? '');
  return clean(a);
}

// The checkout questions, matched by their wording (WeTravel's question ids
// differ per trip). Phone before name for the emergency pair: "Emergency
// contact Hand-phone Number" must not read as the name question.
const QUESTIONS = [
  ['birthdate', (q) => /birth|\bdob\b/.test(q)],
  ['age', (q) => /^\s*age\b/.test(q)],
  ['gender', (q) => /\bgender\b|\bsex\b/.test(q)],
  ['nationality', (q) => /nationality/.test(q)],
  ['residence', (q) => /residence/.test(q)],
  ['emPhone', (q) => /emergency/.test(q) && /phone|number|mobile/.test(q)],
  ['emName', (q) => /emergency/.test(q) && /name|relation/.test(q)],
  ['whatsapp', (q) => /whats\s?app|mobile|phone/.test(q)],
  ['medical', (q) => /medical/.test(q)],
  ['dietary', (q) => /dietary|\bdiet\b/.test(q)],
];

function readSurvey(survey) {
  const out = {};
  for (const s of survey || []) {
    if (!s || s.type === 'file') continue;
    const q = lower(s.question);
    const hit = QUESTIONS.find(([, test]) => test(q));
    if (!hit || out[hit[0]]) continue;
    const text = answerText(s.answers ?? s.answer);
    if (text) out[hit[0]] = text;
  }
  return out;
}

// "1980/12/11", "1980-12-11T00:00:00Z" -> "1980-12-11"; anything else as typed.
function isoDate(text) {
  const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(text || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Age on the day the trip starts: it's the trip's sheet.
function ageOn(birthIso, dayIso) {
  if (!birthIso || !dayIso) return null;
  const [by, bm, bd] = birthIso.split('-').map(Number);
  const [y, m, d] = dayIso.slice(0, 10).split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

// Extra nights, star hotels and single rooms go in Accommodation; safari,
// dolphins, quad bikes etc. in Activity (Operations' rule for this sheet).
const isAccommodation = (name) => /hotel|room|night|accommodation|\bstay\b|upgrade|★|\bstar\b/i.test(name);

// Every traveller on an order, one entry per booked week, with their answers
// and add-ons. Add-on options list the same people as the package options;
// they're joined by participant id, else by email + name.
function participantsFromOrder(order) {
  const options = order.options || [];
  const isPkg = (o) => String(o.type || '').toLowerCase() === 'package';
  const pkgs = options.filter(isPkg);
  const addons = options.filter((o) => !isPkg(o));
  const personKey = (p) => (p.id != null ? `id:${p.id}` : `n:${lower(p.email)}|${normName(p.first_name)}|${normName(p.last_name)}`);
  const altKey = (p) => `n:${lower(p.email)}|${normName(p.first_name)}|${normName(p.last_name)}`;

  const addonsOf = new Map();
  for (const o of addons) {
    for (const p of o.participants || []) {
      if (p.cancelled) continue;
      for (const k of [personKey(p), altKey(p)]) {
        if (!addonsOf.has(k)) addonsOf.set(k, []);
        if (!addonsOf.get(k).includes(clean(o.name))) addonsOf.get(k).push(clean(o.name));
      }
    }
  }

  const out = [];
  for (const o of pkgs) {
    for (const p of o.participants || []) {
      const names = addonsOf.get(personKey(p)) || addonsOf.get(altKey(p)) || [];
      out.push({
        pid: p.id != null ? String(p.id) : crypto.createHash('sha256').update(altKey(p)).digest('hex').slice(0, 16),
        orderId: String(order.id || ''),
        first: clean(p.first_name),
        last: clean(p.last_name),
        email: clean(p.email),
        weekLabel: clean(o.name),
        week: weekNo(o.name),
        cancelled: !!p.cancelled,
        answers: readSurvey(p.survey),
        accommodation: names.filter(isAccommodation),
        activity: names.filter((n) => !isAccommodation(n)),
      });
    }
  }
  return out;
}

// The row as Operations writes it (columns A..T). L Room Type and the flight
// columns N..S stay empty: WeTravel doesn't collect them.
function rowValues(p, { tripStart, weeksBooked }) {
  const a = p.answers;
  const birth = isoDate(a.birthdate);
  const age = ageOn(birth, tripStart);
  const notes = [];
  if (weeksBooked && weeksBooked.length > 1) {
    notes.push(`Booked ${weeksBooked.map((w) => `Week ${w}`).join(' and ')}.`);
  }
  if (a.residence) notes.push(`Residence: ${a.residence}.`);
  const em = [a.emName, a.emPhone].filter(Boolean).join(' ');
  if (em) notes.push(`Emergency contact: ${em}`);
  return {
    A: p.first, B: p.last,
    C: birth || a.birthdate || '',
    D: a.gender || '', E: a.nationality || '',
    F: age != null ? age : (a.age && /^\d{1,3}$/.test(a.age) ? Number(a.age) : ''),
    G: a.whatsapp || '', H: p.email,
    I: a.medical || '', J: a.dietary || '',
    K: p.accommodation.join(', '),
    M: notes.join(' '),
    T: p.activity.join(', '),
  };
}

// The sheet as read through Graph (`formulas` of A1:T600, row 1 first). Week
// blocks start at a "Week N ..." cell in column A; the header row is the one
// whose A says First Name. A row is empty only if all 20 cells are.
function parseSheet(grid) {
  const rows = grid.map((cells, i) => ({ row: i + 1, cells: COLS.map((_, c) => (cells && cells[c] != null ? cells[c] : '')) }));
  const headerIdx = rows.findIndex((r) => /first\s*name/i.test(clean(r.cells[0])));
  const blocks = [];
  for (const r of rows) {
    if (r.row <= headerIdx + 1) continue;
    const w = /^\s*week\s*0*(\d+)/i.exec(clean(r.cells[0]));
    if (w) blocks.push({ week: Number(w[1]), header: r.row });
  }
  const firstData = headerIdx + 2; // the row under the header
  if (!blocks.length) blocks.push({ week: null, header: firstData - 1 });
  blocks.forEach((b, i) => { b.end = i + 1 < blocks.length ? blocks[i + 1].header - 1 : rows.length; });

  const people = [];
  const empty = new Set();
  for (const b of blocks) {
    for (let r = b.header + 1; r <= b.end; r++) {
      const cells = rows[r - 1] ? rows[r - 1].cells : COLS.map(() => '');
      if (cells.every((v) => clean(v) === '')) { empty.add(r); continue; }
      people.push({ row: r, week: b.week, first: clean(cells[0]), last: clean(cells[1]), email: clean(cells[7]), cells });
    }
  }
  return { blocks, people, empty, rows: rows.length };
}

// Is this traveller already in the sheet? Same week block, same email; if the
// email is shared by several travellers on the trip (a parent booking for a
// child), the first name has to match too. No email match -> same full name.
// 'ambiguous' = can't tell, so nothing is added.
function findInSheet(p, sheet, sharedEmail) {
  const inWeek = sheet.people.filter((r) => (sheet.blocks.length === 1 && sheet.blocks[0].week == null) || r.week === p.week);
  const email = lower(p.email);
  const fullName = normName(p.first) + normName(p.last);
  let hits = email ? inWeek.filter((r) => lower(r.email) === email) : [];
  if (hits.length && sharedEmail) hits = hits.filter((r) => normName(r.first) === normName(p.first));
  if (!hits.length && fullName) hits = inWeek.filter((r) => normName(r.first) + normName(r.last) === fullName);
  if (hits.length === 1) return { found: hits[0] };
  if (hits.length > 1) return { ambiguous: `${hits.length} rows match in Week ${p.week}` };
  // Placed by hand in another week? Then don't add a second row; say so.
  const elsewhere = sheet.people.filter((r) => r.week !== p.week &&
    ((email && lower(r.email) === email && (!sharedEmail || normName(r.first) === normName(p.first))) ||
     (fullName && normName(r.first) + normName(r.last) === fullName)));
  return { elsewhere: elsewhere.map((r) => r.week) };
}

// Where a new traveller for `week` goes: the first empty row of that week's
// block, or (block full) a new row inserted above the next week's heading.
function targetRow(sheet, week) {
  const block = sheet.blocks.find((b) => b.week === week) || (sheet.blocks.length === 1 && sheet.blocks[0].week == null ? sheet.blocks[0] : null);
  if (!block) return null;
  for (let r = block.header + 1; r <= block.end; r++) if (sheet.empty.has(r)) return { row: r };
  return { insertAt: block.end + 1 };
}

const initials = (p) => [p.first, p.last].map((s) => (s ? `${Array.from(s)[0]}.` : '')).join(' ').trim();

// ---------------------------------------------------------------------------
// Microsoft Graph (app-only, client credentials). The Entra app needs write
// access to the SharePoint site holding the trip folders: Sites.Selected with
// a "write" grant on that one site is enough and is what we recommend.

const GRAPH = 'https://graph.microsoft.com/v1.0';
let msToken = { token: null, exp: 0 };

async function graphToken() {
  if (msToken.token && Date.now() < msToken.exp) return msToken.token;
  const tenant = (process.env.MS_TENANT_ID || '').trim();
  const id = (process.env.MS_CLIENT_ID || '').trim();
  const secret = (process.env.MS_CLIENT_SECRET || '').trim();
  if (!tenant || !id || !secret) throw new Error('MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET are not set');
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'https://graph.microsoft.com/.default' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Microsoft sign-in failed (${res.status}): ${body.error_description || body.error || 'no token'}`);
  msToken = { token: body.access_token, exp: Date.now() + Math.max(60, (body.expires_in || 3600) - 300) * 1000 };
  return msToken.token;
}

async function graph(method, path, body, extraHeaders = {}, attempt = 0) {
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await graphToken()}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if ([429, 503, 504].includes(res.status) && attempt < 4) {
    const wait = Number(res.headers.get('retry-after') || 2 ** attempt) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));
    return graph(method, path, body, extraHeaders, attempt + 1);
  }
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Graph ${method} ${path.replace(/\?.*/, '')} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

let driveIdCache = null;
async function driveId() {
  if (driveIdCache) return driveIdCache;
  const given = (process.env.TRAVELLER_SYNC_DRIVE_ID || '').trim();
  if (given) return (driveIdCache = given);
  const site = (process.env.TRAVELLER_SYNC_SITE || 'root').trim();
  const d = await graph('GET', `/sites/${site}/drive?$select=id`);
  if (!d || !d.id) throw new Error(`SharePoint document library not found for site ${site}`);
  return (driveIdCache = d.id);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Operations files a trip as <root>/<YYYY>/<MM Month>/<code>/<code>.xlsx
// (e.g. 03. Operations/01 Trips/2026/11 November/ZNZ-BL-202611-03C). The
// week count in the code isn't certain from WeTravel (its package list said
// 2 for a trip Operations filed as 03C), so several candidate codes are
// tried: exactly one must exist at its usual place. None there: a search
// that must find exactly one workbook named after one of the codes. Two or
// none = report, never guess; a failing search is reported, not thrown.
async function findWorkbook(codes, start) {
  const drive = await driveId();
  const y = start.slice(0, 4);
  const m = Number(start.slice(5, 7));
  const hits = [];
  for (const code of codes) {
    const expected = `${TRIPS_ROOT()}/${y}/${String(m).padStart(2, '0')} ${MONTH_NAMES[m - 1]}/${code}/${code}.xlsx`;
    const hit = await graph('GET', `/drives/${drive}/root:/${encPath(expected)}?$select=id,name`);
    if (hit && hit.id) hits.push({ id: hit.id, drive, code });
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { problem: `${hits.length} workbooks match (${hits.map((h) => h.code).join(', ')}); not guessing` };
  const names = new Map(codes.map((c) => [`${lower(c)}.xlsx`, c]));
  let found;
  try {
    found = await graph('GET', `/drives/${drive}/root:/${encPath(TRIPS_ROOT())}:/search(q='${encodeURIComponent(codes[0].replace(/-\d+[BC]$/, ''))}')?$select=id,name,file`);
  } catch (err) {
    return { problem: `no workbook ${codes.join(' / ')} at its usual place, and the search failed (${String(err.message || err).slice(0, 160)})` };
  }
  const files = ((found && found.value) || []).filter((f) => f.file && names.has(lower(f.name)));
  if (files.length === 1) return { id: files[0].id, drive, code: names.get(lower(files[0].name)) };
  return { problem: files.length ? `${files.length} workbooks named ${files.map((f) => f.name).join(', ')}; not guessing` : `no workbook ${codes.join(' / ')} under ${TRIPS_ROOT()}` };
}

function workbookApi(drive, itemId, session) {
  const base = `/drives/${drive}/items/${itemId}/workbook`;
  const h = session ? { 'workbook-session-id': session } : {};
  const ws = `${base}/worksheets('${encodeURIComponent(SHEET_NAME())}')`;
  return {
    read: async () => {
      const r = await graph('GET', `${ws}/range(address='A1:T${SCAN_ROWS}')?$select=formulas`, null, h);
      if (!r) throw new Error(`no "${SHEET_NAME()}" tab`);
      return r.formulas || [];
    },
    // Text format first (C birthdate, G phone, and every text cell, so a
    // "+966…" or a "=…" typed at checkout stays text, never a formula).
    // A new row (onlyEmpty unset) is known to be empty in all of A..T, so
    // its values go in one call; filling blanks writes cell by cell.
    writeRow: async (row, values, onlyEmpty) => {
      const cols = COLS.filter((c) => values[c] !== '' && values[c] != null && (!onlyEmpty || onlyEmpty.includes(c)));
      for (const col of cols) {
        if (typeof values[col] === 'string') await graph('PATCH', `${ws}/range(address='${col}${row}')`, { numberFormat: [['@']] }, h);
      }
      if (!onlyEmpty) {
        await graph('PATCH', `${ws}/range(address='A${row}:T${row}')`, { values: [COLS.map((c) => (values[c] == null ? '' : values[c]))] }, h);
        return;
      }
      for (const col of cols) await graph('PATCH', `${ws}/range(address='${col}${row}')`, { values: [[values[col]]] }, h);
    },
    insertRowAbove: async (row) => graph('POST', `${ws}/range(address='A${row}:T${row}')/insert`, { shift: 'Down' }, h),
    red: async (row) => graph('PATCH', `${ws}/range(address='A${row}:T${row}')/format/font`, { color: '#FF0000' }, h),
    open: async () => {
      const s = await graph('POST', `${base}/createSession`, { persistChanges: true });
      return s && s.id;
    },
    close: async () => { if (session) await graph('POST', `${base}/closeSession`, {}, h).catch(() => {}); },
  };
}

// ---------------------------------------------------------------------------
// WeTravel

let tripsCache = { at: 0, list: null };
async function listTrips() {
  if (tripsCache.list && Date.now() - tripsCache.at < 5 * 60 * 1000) return tripsCache.list;
  const trips = [];
  for (let page = 1; page <= 10; page++) {
    const body = await apiGet(`/draft_trips?per_page=1000&page=${page}&exclude_payment_links=true`);
    trips.push(...(body.data || []));
    if (!(body.pagination && body.pagination.has_next)) break;
  }
  tripsCache = { at: Date.now(), list: trips };
  return trips;
}

async function tripOrders(uuid) {
  const ids = [];
  for (let page = 1; page <= 20; page++) {
    const body = await apiGet(`/bookings/trips/${uuid}/bookings?page=${page}`);
    for (const o of body.data || []) if (o.id != null) ids.push(String(o.id));
    if (!(body.pagination && body.pagination.has_next)) break;
  }
  return mapWithConcurrency(ids, 3, (id) => apiGet(`/bookings/trips/${uuid}/orders/${id}`).then((b) => b.data || b));
}

// ---------------------------------------------------------------------------
// One trip, end to end.

const memKey = (trip, p) => `tsync:p:${trip}:${p.pid}:${p.week == null ? 'x' : p.week}`;

async function syncTrip(trip, { mode }) {
  const uuid = String(trip.uuid);
  const start = String(trip.start_date || '').slice(0, 10);
  const packages = (await apiGet(`/draft_trips/${uuid}/packages`).catch(() => ({ data: [] }))).data || [];
  const { code } = buildCode({ title: trip.title, destination: trip.destination }, start, packages.length || 1);
  const report = { trip: uuid, code: code || null, title: trip.title, added: [], filled: 0, red: 0, alreadyThere: 0, problems: [] };
  if (!code) { report.problems.push('no project code from the trip title, so no sheet to write to'); return report; }

  const orders = await tripOrders(uuid);
  const people = orders.flatMap(participantsFromOrder);
  if (!people.length) return report;

  // Week count candidates: the package count, the trip's span in weeks, and
  // the highest week anyone booked. Exactly one code must have a workbook.
  const counts = new Set([packages.length || 1]);
  const end = String(trip.end_date || '').slice(0, 10);
  if (end) counts.add(Math.round(((Date.parse(end) - Date.parse(start)) / 86400000 + 1) / 7));
  const maxWeek = Math.max(0, ...people.map((p) => p.week || 0));
  if (maxWeek) counts.add(maxWeek);
  const codes = [...new Set([...counts].filter((n) => n >= 1).sort((a, b) => a - b)
    .map((n) => buildCode({ title: trip.title, destination: trip.destination }, start, n).code).filter(Boolean))];
  const wb = await findWorkbook(codes, start);
  if (wb.problem) { report.code = null; report.problems.push(wb.problem); return report; }
  report.code = wb.code;

  const lock = `tsync:lock:${uuid}`;
  if ((await kv.command('SET', lock, '1', 'NX', 'EX', 280)) !== 'OK') { report.problems.push('another sync of this trip is running; it will be picked up next time'); report.busy = true; return report; }
  const session = mode === 'live' ? await workbookApi(wb.drive, wb.id).open().catch(() => null) : null;
  const api = workbookApi(wb.drive, wb.id, session);
  try {
    let sheet = parseSheet(await api.read());
    const emailCount = new Map();
    const weeksOf = new Map();
    for (const p of people) {
      const k = `${p.week}|${lower(p.email)}`;
      emailCount.set(k, (emailCount.get(k) || 0) + 1);
      const who = p.pid;
      if (!p.cancelled && p.week != null) weeksOf.set(who, [...new Set([...(weeksOf.get(who) || []), p.week])].sort((a, b) => a - b));
    }
    // Same person in two weeks is often two participant ids under one email.
    const weeksByEmail = new Map();
    for (const p of people) if (!p.cancelled && p.week != null && p.email) {
      const k = `${lower(p.email)}|${normName(p.first)}`;
      weeksByEmail.set(k, [...new Set([...(weeksByEmail.get(k) || []), p.week])].sort((a, b) => a - b));
    }

    // A cancelled entry for someone who still has an active one in the same
    // week (cancelled and rebooked) shares their row: that row stays black.
    const activeKey = (p) => `${p.week}|${lower(p.email)}|${normName(p.first)}`;
    const active = new Set(people.filter((p) => !p.cancelled).map(activeKey));

    const ordered = people.slice().sort((a, b) => (a.week ?? 99) - (b.week ?? 99));
    for (const p of ordered) {
      const shared = (emailCount.get(`${p.week}|${lower(p.email)}`) || 0) > 1;
      const match = findInSheet(p, sheet, shared);
      const mem = await kv.command('GET', memKey(uuid, p));
      const memo = mem ? JSON.parse(mem) : null;
      const label = `${initials(p)} · Week ${p.week ?? '?'}`;

      if (p.cancelled) {
        if (match.found && !active.has(activeKey(p)) && !(memo && memo.red)) {
          if (mode === 'live') {
            await api.red(match.found.row);
            await kv.command('SET', memKey(uuid, p), JSON.stringify({ ...(memo || {}), red: 1, at: Date.now() }));
          }
          report.red++;
        }
        continue;
      }
      if (match.ambiguous) { report.problems.push(`${label}: ${match.ambiguous}, left as it is`); continue; }

      const weeksBooked = weeksByEmail.get(`${lower(p.email)}|${normName(p.first)}`) || weeksOf.get(p.pid) || [p.week];
      const values = rowValues(p, { tripStart: start, weeksBooked });

      if (match.found) {
        report.alreadyThere++;
        if (!memo && mode === 'live') await kv.command('SET', memKey(uuid, p), JSON.stringify({ seen: 1, at: Date.now() }));
        // Answers given after booking: fill the blanks, only in rows we added.
        if (memo && memo.added) {
          const blanks = COLS.filter((c, i) => clean(match.found.cells[i]) === '' && values[c] !== '' && values[c] != null);
          if (blanks.length) {
            if (mode === 'live') await api.writeRow(match.found.row, values, blanks);
            report.filled += blanks.length;
          }
        }
        continue;
      }
      if (match.elsewhere && match.elsewhere.length) { report.problems.push(`${label}: in the sheet under Week ${match.elsewhere.join(', ')} instead, not added again`); continue; }
      if (memo) { report.problems.push(`${label}: was in the sheet before but isn't now (renamed or removed?), not added again`); continue; }
      if (p.week == null && !(sheet.blocks.length === 1 && sheet.blocks[0].week == null)) { report.problems.push(`${label}: WeTravel package "${p.weekLabel}" names no week`); continue; }

      let target = targetRow(sheet, p.week);
      if (!target) { report.problems.push(`${label}: the sheet has no Week ${p.week} heading`); continue; }
      if (target.insertAt) {
        if (mode === 'live') { await api.insertRowAbove(target.insertAt); sheet = parseSheet(await api.read()); target = { ...targetRow(sheet, p.week), inserted: true }; }
        else target = { row: target.insertAt, inserted: true };
      }
      if (mode === 'live') {
        await api.writeRow(target.row, values);
        await kv.command('SET', memKey(uuid, p), JSON.stringify({ added: 1, at: Date.now() }));
      }
      sheet.empty.delete(target.row);
      sheet.people.push({ row: target.row, week: p.week, first: p.first, last: p.last, email: p.email, cells: COLS.map((c) => values[c] ?? '') });
      report.added.push({ who: label, row: target.row, inserted: !!target.inserted, columns: COLS.filter((c) => values[c] !== '' && values[c] != null).join('') });
    }
  } finally {
    await api.close();
    await kv.command('DEL', lock).catch(() => {});
  }
  return report;
}

const omanToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);

async function run({ tripIds, mode }) {
  const t0 = Date.now();
  const all = await listTrips();
  const only = ONLY_TRIPS();
  const skip = SKIP_TRIPS();
  const today = omanToday();
  let trips = tripIds && tripIds.length
    ? all.filter((t) => tripIds.includes(String(t.uuid)))
    : all.filter((t) => String(t.end_date || t.start_date || '').slice(0, 10) >= today);
  if (only.size) trips = trips.filter((t) => only.has(String(t.uuid)));
  trips = trips.filter((t) => !skip.has(String(t.uuid)));

  const results = [];
  for (const trip of trips) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { results.push({ trip: String(trip.uuid), problems: ['out of time this run; next run continues'] }); continue; }
    try {
      let r = await syncTrip(trip, { mode });
      // Two booking events for one trip close together: the second waits for
      // the first instead of being dropped until the daily run.
      for (let i = 0; r.busy && tripIds && i < 4 && Date.now() - t0 < TIME_BUDGET_MS - 30000; i++) {
        await new Promise((ok) => setTimeout(ok, 15000));
        r = await syncTrip(trip, { mode });
      }
      results.push(r);
    } catch (err) {
      results.push({ trip: String(trip.uuid), title: trip.title, problems: [String(err.message || err).slice(0, 300)] });
    }
  }
  const summary = {
    mode,
    at: new Date().toISOString(),
    trips: results.length,
    added: results.reduce((s, r) => s + ((r.added && r.added.length) || 0), 0),
    red: results.reduce((s, r) => s + (r.red || 0), 0),
    filled: results.reduce((s, r) => s + (r.filled || 0), 0),
    results: results.filter((r) => (r.added && r.added.length) || r.red || r.filled || (r.problems && r.problems.length)),
  };
  await kv.command('SET', 'tsync:last', JSON.stringify(summary), 'EX', 30 * 86400).catch(() => {});
  // Readable in Vercel > Logs (search "traveller-sync"): initials, weeks,
  // rows and reasons only, never a name, email, phone or answer.
  console.log('traveller-sync', JSON.stringify(summary));
  return summary;
}

// ---------------------------------------------------------------------------
// HTTP: the Svix webhook, the cron and manual runs.

function trusted(req) {
  const auth = String(req.headers.authorization || '');
  return [process.env.CRON_SECRET, process.env.CAMPAIGN_ALERT_SECRET]
    .map((s) => (s || '').trim()).filter(Boolean)
    .some((s) => auth.length === s.length + 7 && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(`Bearer ${s}`)));
}

async function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

// Svix signs `${id}.${timestamp}.${body}` with the endpoint's whsec_ secret.
function svixValid(headers, body, secret) {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigs = String(headers['svix-signature'] || '').split(' ');
  if (!id || !ts || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return sigs.some((s) => {
    const v = s.split(',')[1] || '';
    return v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected));
  });
}

// The trip id somewhere in the event (its exact shape isn't documented).
function tripIdOf(event) {
  const d = (event && (event.data || event.payload)) || event || {};
  const cands = [d.trip_uuid, d.trip_id, d.trip && (d.trip.uuid || d.trip.id), d.booking && d.booking.trip_uuid, d.order && d.order.trip_uuid];
  const hit = cands.find((v) => v != null && /^\d+$/.test(String(v)));
  return hit != null ? String(hit) : null;
}

async function handle(req, res) {
  const mode = MODE();
  if (req.query && req.query.hook) {
    const secret = (process.env.WETRAVEL_WEBHOOK_SECRET || '').trim();
    if (!secret) return res.status(503).json({ error: 'WETRAVEL_WEBHOOK_SECRET is not set' });
    const body = await rawBody(req);
    if (!svixValid(req.headers, body, secret)) return res.status(401).json({ error: 'bad signature' });
    let event = {};
    try { event = JSON.parse(body); } catch (e) { /* not JSON */ }
    const type = String(event.type || event.event_type || '');
    if (!/^booking\./.test(type)) return res.status(200).json({ ignored: type || 'unknown' });
    if (mode === 'off') return res.status(200).json({ off: true });
    const trip = tripIdOf(event);
    // Svix waits ~15 s for an answer; a trip can take longer, so answer first
    // and finish in the background. Missed work is caught by the daily run.
    const work = run({ tripIds: trip ? [trip] : null, mode }).catch((err) => console.error('traveller-sync:', err.message));
    try { require('@vercel/functions').waitUntil(work); } catch (e) { await work; }
    return res.status(202).json({ accepted: true, trip: trip || 'all upcoming' });
  }

  if (!trusted(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.query && req.query.last) {
    const last = await kv.command('GET', 'tsync:last');
    return res.status(200).json(last ? JSON.parse(last) : { none: true });
  }
  if (mode === 'off') return res.status(200).json({ off: true });
  // ?dry=1 forces a dry run even when live, to preview before a real one.
  const runMode = req.query && req.query.dry ? 'dry' : mode;
  const tripIds = req.query && req.query.trip ? String(req.query.trip).split(',').map((s) => s.trim()) : null;
  try {
    return res.status(200).json(await run({ tripIds, mode: runMode }));
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
}

module.exports = {
  handle, run, syncTrip,
  // for tests
  participantsFromOrder, rowValues, parseSheet, findInSheet, targetRow, readSurvey, isoDate, ageOn, weekNo, svixValid, tripIdOf,
};
