// Automatic lead counting from ManyChat (Anton, 21 Oct 2026: "Lets do first
// with Marina the leads tab ... make sure the high potential and leads are
// accurately fetched"). Runs IN PARALLEL with Marina's sheet: the Leads tab
// shows both side by side per day until they agree, then the tab can switch.
//
// ManyChat's API can't list "new contacts per day", so ManyChat pushes each
// event here the moment it happens (Automation rules with an External
// Request), to POST /hooks/manychat (vercel.json routes it into
// api/advisor.js; all 12 function slots are used):
//
//   headers: X-NomuHub-Key: <MANYCHAT_SECRET>
//   body:    { "event": "lead" | "message" | "hp" | "hp_removed" | "trip",
//              "contact": "<ManyChat contact id>",
//              "channel": "whatsapp" | "instagram",
//              "trip": "<trip tag or field, e.g. ZNZ|BL>" }
//
// New vs returning (Anton, 25 Oct 2026: "most of our customers are come back
// customers ... separate the count of new lead and the repeated customer"):
//   - lead = ManyChat's "New contact created": a NEW lead (first-time contact).
//   - message = an EXISTING contact writing again: a RETURNING lead, if they
//     haven't been counted in the last 30 days. Contacts from before the rules
//     went live count as returning the first time they write.
//   - A brand-new contact's first message can arrive before its "new contact"
//     event; the lead is then counted as returning and turned into new when
//     the "new contact" event follows the same or next day.
//   Every lead (new + returning) counts in the totals; returning is a subset
//   (counter ret|<channel>|<project>), so new = leads - returning.
// Rules, so the counts match how Marina counts:
//   - lead: a contact counts once per 30 days (someone writing again next
//     week is the same lead), on the Muscat day it first arrived.
//   - hp: the HP tag, applied by whoever is chatting, counted on the day it's
//     applied; a contact is HP once. hp_removed takes it back off that day.
//     An HP or trip event for a contact we haven't seen (someone who wrote
//     before the rules went live, or over 30 days ago) counts the HP but NOT
//     a new lead: they weren't a new contact that day, and counting them
//     would push the automatic leads above Marina's.
//   - trip: moves the contact's lead (and HP) to that project, on the days
//     they were counted; untagged leads sit under NA, like Marina's sheet.
// Only counts are kept: the contact id is hashed before it's stored, and no
// names, numbers or messages ever reach the dashboard.

const crypto = require('crypto');
const kv = require('./kv');
const { classify } = require('./trip-code');

const DEDUP_DAYS = Number(process.env.MANYCHAT_DEDUP_DAYS || 30);
const KEEP_DAYS = 400;
const muscatToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function channelOf(v) {
  const s = String(v || '').toLowerCase();
  if (/whats|^wa$|wa_|phone/.test(s)) return 'wa';
  if (/insta|^ig$|ig_/.test(s)) return 'ig';
  return 'unknown';
}

// "ZNZ|BL", "Trip: ZNZ|BL", "ZNZ-BL", "znz bl" or "Zanzibar Building" -> "ZNZ|BL".
// Destination-only codes ("SL", "KN") stay as they are; anything else is NA.
function projectOf(v) {
  let s = String(v || '').replace(/^\s*trip\s*[:\-]\s*/i, '').trim();
  if (!s) return null;
  const code = s.toUpperCase().replace(/\s*[|/\-\s]\s*/g, '|');
  if (/^[A-Z]{2,6}(\|[A-Z]{2,3})?$/.test(code)) return code;
  const c = classify({ title: s });
  if (c.destination) return c.programme ? `${c.destination}|${c.programme}` : c.destination;
  return 'NA';
}

const hashOf = (contact) => crypto.createHmac('sha256', `${process.env.MANYCHAT_SECRET || ''}|mc`).update(String(contact)).digest('hex').slice(0, 24);
const recKey = (h) => `mc:c:${h}`;
const dayKey = (d) => `mc:d:${d}`;

async function handleHook(req, res) {
  const secret = (process.env.MANYCHAT_SECRET || '').trim();
  const given = String(req.headers['x-nomuhub-key'] || (req.query && req.query.key) || '').trim();
  if (!secret) return res.status(503).json({ error: 'MANYCHAT_SECRET is not set in Vercel' });
  if (given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return res.status(401).json({ error: 'bad key' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!kv.configured()) return res.status(500).json({ error: 'store not configured' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const event = String(b.event || '').toLowerCase().trim();
  const contact = String(b.contact || b.contact_id || b.subscriber_id || '').trim();
  if (!['lead', 'message', 'hp', 'hp_removed', 'trip'].includes(event)) return res.status(400).json({ error: 'event must be lead, message, hp, hp_removed or trip' });
  if (!contact || /^\{\{.*\}\}$/.test(contact)) return res.status(400).json({ error: 'contact id missing (the {{...}} variable was not filled in)' });

  const today = muscatToday();
  const h = hashOf(contact);
  const raw = await kv.command('GET', recKey(h));
  let rec = raw ? JSON.parse(raw) : null;
  // An old record (outside the 30 days) means this is a new lead again.
  if (rec && daysBetween(rec.d || rec.t, today) >= DEDUP_DAYS && event !== 'hp_removed') rec = null;
  const ch = channelOf(b.channel) !== 'unknown' ? channelOf(b.channel) : (rec && rec.ch) || 'unknown';
  const tripGiven = projectOf(b.trip);
  const cmds = [];
  let did = 'nothing';

  // Counts a lead today; `returning` adds it to the returning subset too. A
  // contact we only knew from a tag keeps its trip and HP.
  const newLead = (p, returning) => {
    const keep = rec && !rec.d ? rec : null;
    rec = { d: today, t: today, ch, p: p || (keep && keep.p) || 'NA', hp: keep ? keep.hp : null, r: !!returning };
    cmds.push(['HINCRBY', dayKey(today), `lead|${rec.ch}|${rec.p}`, 1], ['EXPIRE', dayKey(today), KEEP_DAYS * 86400]);
    if (returning) cmds.push(['HINCRBY', dayKey(today), `ret|${rec.ch}|${rec.p}`, 1]);
  };
  // A contact we only learn about from a tag: remembered, but no lead counted.
  const known = (p) => { rec = { d: null, t: today, ch, p: p || 'NA', hp: null }; };
  // Moving a counted lead between projects (only if a lead was counted).
  const moveLead = (from, to) => {
    if (!rec.d) return;
    cmds.push(['HINCRBY', dayKey(rec.d), `lead|${rec.ch}|${from}`, -1], ['HINCRBY', dayKey(rec.d), `lead|${rec.ch}|${to}`, 1]);
    if (rec.r) cmds.push(['HINCRBY', dayKey(rec.d), `ret|${rec.ch}|${from}`, -1], ['HINCRBY', dayKey(rec.d), `ret|${rec.ch}|${to}`, 1]);
  };

  if (event === 'lead') {
    if (!rec || !rec.d) { newLead(tripGiven, false); did = 'new lead counted'; } else if (rec.r && daysBetween(rec.d, today) <= 1) {
      // Its first message got here first and counted it as returning.
      cmds.push(['HINCRBY', dayKey(rec.d), `ret|${rec.ch}|${rec.p}`, -1]);
      rec.r = false;
      did = 'changed from returning to new';
    } else did = 'already counted in the last 30 days';
  } else if (event === 'message') {
    if (!rec || !rec.d) { newLead(tripGiven, true); did = 'returning lead counted'; } else did = 'already counted in the last 30 days';
  } else if (event === 'trip') {
    if (!rec) { known(tripGiven); did = 'trip noted (contact from before, not a new lead)'; } else if (tripGiven && tripGiven !== rec.p) {
      moveLead(rec.p, tripGiven);
      if (rec.hp) cmds.push(['HINCRBY', dayKey(rec.hp), `hp|${rec.ch}|${rec.p}`, -1], ['HINCRBY', dayKey(rec.hp), `hp|${rec.ch}|${tripGiven}`, 1]);
      rec.p = tripGiven;
      did = 'moved to its trip';
    } else did = 'trip unchanged';
  } else if (event === 'hp') {
    if (!rec) known(tripGiven);
    else if (tripGiven && rec.p === 'NA') {
      moveLead('NA', tripGiven);
      rec.p = tripGiven;
    }
    if (!rec.hp) {
      rec.hp = today;
      cmds.push(['HINCRBY', dayKey(today), `hp|${rec.ch}|${rec.p}`, 1], ['EXPIRE', dayKey(today), KEEP_DAYS * 86400]);
      did = 'HP counted';
    } else did = 'already HP';
  } else if (event === 'hp_removed') {
    if (rec && rec.hp) {
      cmds.push(['HINCRBY', dayKey(rec.hp), `hp|${rec.ch}|${rec.p}`, -1]);
      rec.hp = null;
      did = 'HP taken off';
    } else did = 'was not HP';
  }
  if (rec && ch !== 'unknown' && rec.ch === 'unknown') rec.ch = ch;
  if (rec) cmds.push(['SET', recKey(h), JSON.stringify(rec), 'EX', (DEDUP_DAYS + 400) * 86400]);
  cmds.push(['SET', 'mc:first', today, 'NX'], ['SET', 'mc:last', new Date().toISOString()], ['INCR', `mc:events:${today}`], ['EXPIRE', `mc:events:${today}`, 30 * 86400]);
  await kv.pipeline(cmds);
  return res.status(200).json({ ok: true, did });
}

// For the Leads tab: per-day counts since the first event, split by channel
// and project. Counts only.
async function load() {
  if (!kv.configured()) return { configured: false, days: [] };
  const [first, last] = await kv.pipeline([['GET', 'mc:first'], ['GET', 'mc:last']]);
  if (!first) return { configured: !!(process.env.MANYCHAT_SECRET || '').trim(), first: null, last: null, days: [] };
  const today = muscatToday();
  const start = daysBetween(first, today) > 120 ? addDays(today, -120) : first;
  const list = [];
  for (let d = start; d <= today; d = addDays(d, 1)) list.push(d);
  const rows = await kv.pipeline(list.map((d) => ['HGETALL', dayKey(d)]));
  const days = list.map((date, i) => {
    const flat = rows[i] || [];
    const out = { date, leads: 0, hp: 0, wa: 0, ig: 0, unknown: 0, hpWa: 0, hpIg: 0, ret: 0, retWa: 0, retIg: 0, projects: {} };
    for (let j = 0; j < flat.length; j += 2) {
      // Keys are kind|channel|project, and a project code has its own | (ZNZ|BL).
      const [kind, ch, ...rest] = String(flat[j]).split('|');
      const p = rest.join('|');
      const n = Number(flat[j + 1]) || 0;
      if (!n) continue;
      const pr = out.projects[p] || (out.projects[p] = { leads: 0, hp: 0, wa: 0, ig: 0, hpWa: 0, hpIg: 0, ret: 0 });
      if (kind === 'ret') { out.ret += n; if (ch === 'wa') out.retWa += n; if (ch === 'ig') out.retIg += n; pr.ret += n; continue; }
      if (kind === 'lead') { out.leads += n; out[ch === 'wa' ? 'wa' : ch === 'ig' ? 'ig' : 'unknown'] += n; pr.leads += n; if (ch === 'wa') pr.wa += n; if (ch === 'ig') pr.ig += n; }
      if (kind === 'hp') { out.hp += n; if (ch === 'wa') { out.hpWa += n; pr.hpWa += n; } if (ch === 'ig') { out.hpIg += n; pr.hpIg += n; } pr.hp += n; }
    }
    return out;
  });
  return { configured: true, first, last, dedupDays: DEDUP_DAYS, days };
}

module.exports = { handleHook, load, projectOf, channelOf };
