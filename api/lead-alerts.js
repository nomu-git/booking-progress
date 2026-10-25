// Daily leads alert to Slack (living-room), asked for by Anton, 6 Oct 2026:
// when a day's leads miss the daily targets (20 leads, 10 high-potential
// leads), post one alert for that day; when both are met, post nothing.
//
//   🚨 Leads alert · Tue 6 Oct
//   Overall leads: 21 (target 20) ✅
//   High potential: 1 (target 5) ❌
//   High potential leads did not meet the target. Please review the Leads
//   tab: https://crm.nomuhub.com/#leads
//
// cron-job.org calls this once a day at 11:30 PM Muscat. Marina fills in the
// day around 6 PM Oman time (she told Anton, 6 Oct 2026), so it's in by then.
// A day she logs after the check is judged by the next night's run, which
// also looks at yesterday. Each day is judged once: a claim in Upstash
// (lib/kv.js) records it, pass or fail, so nothing is posted twice.
// Only days from LEAD_ALERTS_FROM on are judged, so switching it on doesn't
// replay past days into the channel.
//
// Since 25 Oct 2026 (Anton: "refer to the manychats auto moving forward
// since it only shows up to date leads status") the numbers are ManyChat's
// automatic count (lib/manychat.js), the same the Leads tab shows from 21 Oct:
// new contacts, and contacts tagged HP that day. Nothing waits for Marina's
// sheet any more; the 11:30 PM run judges the day with what ManyChat has
// counted by then (a lead after 11:30 PM still shows on the tab, not in that
// night's alert). Days before ManyChat started aren't judged.

const manychat = require('../lib/manychat');
const kv = require('../lib/kv');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const SECRET = (process.env.CAMPAIGN_ALERT_SECRET || '').trim();
const LEADS_TARGET = Number(process.env.LEADS_DAILY_TARGET || 20);
const HP_TARGET = Number(process.env.HP_DAILY_TARGET || 5);
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

// Which days to look at now: yesterday always (catches a day logged late),
// and today from 11 PM Muscat (the 11:30 PM check).
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
    ? `High potential: not recorded (target ${HP_TARGET})`
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
  const mc = await manychat.load();
  const byDate = new Map();
  for (const d of (mc && mc.days) || []) byDate.set(d.date, { date: d.date, recorded: true, total: d.leads || 0, hp: d.hp || 0 });
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
      // Before ManyChat started counting: nothing to judge.
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
