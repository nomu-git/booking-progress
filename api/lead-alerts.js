// Daily leads alert to Slack (living-room), asked for by Anton, 6 Oct 2026:
// when a day's leads miss the daily targets (20 leads, 10 high-potential
// leads), post one alert for that day; when both are met, post nothing.
//
//   🚨 Leads alert · Tue 6 Oct
//   Overall leads: 21 (target 20) ✅
//   High potential: 1 (target 10) ❌
//   High potential leads did not meet the target. Please review the Leads
//   tab: https://crm.nomuhub.com/#leads
//
// cron-job.org calls this at 11:30 PM Muscat (Anton's time) and again at
// 10:00 AM. Marina logs a day in the leads sheet by the next afternoon, so it
// may not be in yet at 11:30 PM; a day that isn't logged is skipped and
// judged on the morning run instead. Each day is judged once: a claim in
// Upstash (lib/kv.js) records it, pass or fail, so nothing is posted twice.
// Only days from LEAD_ALERTS_FROM on are judged, so switching it on doesn't
// replay past days into the channel.
//
// The numbers are the Leads tab's own (lib/tabs/leads.js), so the alert and
// the tab always agree.

const { fetchWorkbook } = require('../lib/sheet');
const leadsTab = require('../lib/tabs/leads');
const kv = require('../lib/kv');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const SECRET = (process.env.CAMPAIGN_ALERT_SECRET || '').trim();
const LEADS_TARGET = Number(process.env.LEADS_DAILY_TARGET || 20);
const HP_TARGET = Number(process.env.HP_DAILY_TARGET || 10);
const FROM = process.env.LEAD_ALERTS_FROM || '2026-10-06';
const LINK = process.env.LEADS_ALERT_LINK || 'https://crm.nomuhub.com/#leads';
const CLAIM_TTL_S = 30 * 24 * 3600;

const OMAN_MS = 4 * 3600 * 1000;
const omanNow = () => new Date(Date.now() + OMAN_MS);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};

// Which days to look at now: yesterday always (the morning catch-up), and
// today from 11 PM Muscat (the 11:30 PM check).
function candidateDays(now = omanNow()) {
  const today = now.toISOString().slice(0, 10);
  const days = [addDays(today, -1)];
  if (now.getUTCHours() >= 23) days.push(today);
  return days.filter((d) => d >= FROM);
}

function judge(day) {
  const leadsMet = day.total >= LEADS_TARGET;
  // No HP recorded for the day: judged on leads alone, and the message says so.
  const hpMet = day.hp == null ? true : day.hp >= HP_TARGET;
  return { leadsMet, hpMet, met: leadsMet && hpMet };
}

function message(day, j) {
  const tick = (ok) => (ok ? '✅' : '❌');
  const verdict = !j.leadsMet && !j.hpMet ? 'Both targets were missed.'
    : !j.leadsMet ? 'Overall leads did not meet the target.'
      : 'High potential leads did not meet the target.';
  const hpLine = day.hp == null
    ? `High potential: not recorded in the sheet (target ${HP_TARGET})`
    : `High potential: *${day.hp}* (target ${HP_TARGET}) ${tick(j.hpMet)}`;
  const text = [
    `🚨 *Leads alert · ${dayLabel(day.date)}*`,
    `Overall leads: *${day.total}* (target ${LEADS_TARGET}) ${tick(j.leadsMet)}`,
    hpLine,
    `${verdict} Please review the Leads tab: ${LINK}`,
  ].join('\n');
  return { text: text.replace(/\*/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

async function loadDays() {
  const payload = leadsTab.build(await fetchWorkbook(leadsTab.envVar));
  const byDate = new Map();
  for (const w of payload.weeks) for (const d of w.days || []) byDate.set(d.date, d);
  return byDate;
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!SECRET) return res.status(500).json({ error: 'CAMPAIGN_ALERT_SECRET is not set' });
  if (auth !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'unauthorized' });

  try {
    const byDate = await loadDays();

    // ?preview=1&date=YYYY-MM-DD shows what a day would post, posting nothing.
    if (req.query && req.query.preview === '1') {
      const dates = req.query.date ? [String(req.query.date)] : candidateDays();
      return res.status(200).json({
        preview: true,
        now: omanNow().toISOString().slice(0, 16).replace('T', ' ') + ' Muscat',
        days: dates.map((date) => {
          const d = byDate.get(date);
          if (!d || !d.recorded || d.total == null) return { date, logged: false };
          const j = judge(d);
          return { date, logged: true, leads: d.total, hp: d.hp, met: j.met, wouldPost: j.met ? null : message(d, j).text };
        }),
      });
    }

    const judged = [];
    const posted = [];
    const waiting = [];
    const errors = [];
    for (const date of candidateDays()) {
      const d = byDate.get(date);
      // Not in the sheet yet: left for the next run.
      if (!d || !d.recorded || d.total == null) { waiting.push(date); continue; }
      const key = `lead-alerts:${date}`;
      if ((await kv.command('SET', key, '1', 'NX', 'EX', CLAIM_TTL_S)) !== 'OK') continue; // already judged
      const j = judge(d);
      judged.push({ date, leads: d.total, hp: d.hp, met: j.met });
      if (j.met) continue;
      if (!SLACK_WEBHOOK_URL) { await kv.command('DEL', key); errors.push('SLACK_WEBHOOK_URL is not set'); continue; }
      const r = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message(d, j)),
      }).catch((err) => ({ ok: false, status: err.message }));
      if (r.ok) posted.push(date);
      else { await kv.command('DEL', key); errors.push(`${date}: Slack ${r.status}`); }
    }
    res.status(200).json({ judged, posted, waiting, errors });
  } catch (err) {
    console.error('lead-alerts failed:', err);
    res.status(500).json({ error: err.message });
  }
};

module.exports.judge = judge;
module.exports.message = message;
module.exports.candidateDays = candidateDays;
