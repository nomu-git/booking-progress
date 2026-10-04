// Posts to Slack when a campaign is switched on or off in Meta Ads Manager:
//   "Campaign: ZNZ-BL-202609-02C has been switched off at 3:42 PM on Sat 4 Oct
//    (Muscat), by Maryem Sayed. Please review the changes: <dashboard>"
//
// Meta has no push notification for this. Its ad-account webhooks cover
// creative fatigue, ads with issues, ads in review and a few others, but not
// a campaign's on/off status. What it does have is the account's activity log
// (the Ads Manager "History" page), which records every switch with its exact
// time and who made it. So this reads that log, and a GitHub Actions workflow
// (.github/workflows/campaign-alerts.yml) calls it every 5 minutes. The time
// in the message is the switch's own time from the log, not when it was
// noticed.
//
// No database here, so "already posted" travels with the caller: the
// workflow POSTs { seen: [...] } (the keys this endpoint returned last time,
// kept in the Actions cache) and stores the `seen` that comes back. Every
// run looks back LOOKBACK_MIN minutes, so a late or skipped run still
// catches up, and a key that's already in `seen` is never posted twice. With
// no `seen` at all (first run, or the cache expired after a week of nothing
// running), it records what's there without posting, rather than replaying
// hours of old switches into the channel.
//
// Only campaigns, not ad sets or ads: those change far more often (Meta
// itself moves ads through review states) and would bury the channel.

const { graphGetAll, AD_ACCOUNTS } = require('../lib/meta-ads');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://bookingprogress.vercel.app';
const ALERT_SECRET = (process.env.CAMPAIGN_ALERT_SECRET || '').trim();
const LOOKBACK_MIN = Number(process.env.CAMPAIGN_ALERT_LOOKBACK_MIN || 180);

const parseExtra = (v) => {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}'); } catch (e) { return {}; }
};

// One activity-log row -> a switch, or null if it isn't a campaign going on
// or off. The raw event_type is update_campaign_run_status; the translated
// label ("Campaign status updated") is checked too in case Meta renames it.
function toSwitch(a, account) {
  const isCampaign = a.event_type === 'update_campaign_run_status'
    || /^campaign status updated$/i.test(String(a.translated_event_type || ''));
  if (!isCampaign) return null;
  const extra = parseExtra(a.extra_data);
  const from = String(extra.old_value || '');
  const to = String(extra.new_value || '');
  const at = Date.parse(String(a.event_time || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(at)) return null;
  // On means it became Active; off means it stopped being Active (paused,
  // switched off, or deleted while running). Anything else, e.g. a paused
  // campaign being deleted, isn't an on/off switch.
  let state = null;
  if (/^active$/i.test(to) && !/^active$/i.test(from)) state = 'on';
  else if (/^active$/i.test(from) && !/^active$/i.test(to)) state = 'off';
  if (!state) return null;
  return {
    key: `${account}:${a.object_id}:${at}:${state}`,
    account,
    id: String(a.object_id || ''),
    name: String(a.object_name || a.object_id || 'Unnamed campaign'),
    state,
    at,
    by: a.actor_name ? String(a.actor_name) : null,
    from,
    to,
  };
}

const muscat = (ms) => {
  const time = new Date(ms).toLocaleTimeString('en-US', { timeZone: 'Asia/Muscat', hour: 'numeric', minute: '2-digit', hour12: true });
  const day = new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Asia/Muscat', weekday: 'short', day: 'numeric', month: 'short' });
  return `${time} on ${day}`;
};

function message(s) {
  const by = s.by ? `, by ${s.by}` : '';
  const text = `Campaign: *${s.name}* has been switched *${s.state}* at ${muscat(s.at)} (Muscat)${by}. Please review the changes: ${DASHBOARD_URL}/#campaigns`;
  return { text: text.replace(/\*/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${s.state === 'on' ? ':large_green_circle:' : ':red_circle:'} ${text}` } }] };
}

// Which switches to post, given what's in the log and what was posted before.
// A key's time is its third part, so `seen` can be pruned to the window
// without storing anything else.
function plan(switches, seen, nowMs) {
  const floor = nowMs - LOOKBACK_MIN * 60 * 1000;
  const keyTime = (k) => Number(String(k).split(':')[2]);
  const kept = new Set((seen || []).filter((k) => keyTime(k) >= floor));
  const fresh = switches
    .filter((s) => s.at >= floor && !kept.has(s.key))
    .sort((a, b) => a.at - b.at);
  return { kept, fresh, bootstrap: !Array.isArray(seen) };
}

async function fetchSwitches(nowMs) {
  const since = Math.floor((nowMs - LOOKBACK_MIN * 60 * 1000) / 1000);
  const switches = [];
  const errors = [];
  for (const account of AD_ACCOUNTS) {
    try {
      const rows = await graphGetAll(`/${account}/activities`, {
        fields: 'event_type,translated_event_type,event_time,object_id,object_name,object_type,actor_name,extra_data',
        since,
        until: Math.floor(nowMs / 1000) + 60,
        limit: 200,
      }, 10);
      for (const a of rows) {
        const s = toSwitch(a, account);
        if (s) switches.push(s);
      }
    } catch (err) {
      errors.push(`${account}: ${err.message}`);
    }
  }
  return { switches, errors };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const nowMs = Date.now();
  const preview = req.query && req.query.preview === '1';

  // Posting needs the secret, or anyone could make the channel replay old
  // switches by sending an empty `seen`. Preview only reads, and is open
  // until a secret is set so the Meta access can be checked first.
  if (!preview || ALERT_SECRET) {
    const auth = req.headers.authorization || '';
    if (!ALERT_SECRET) return res.status(500).json({ error: 'CAMPAIGN_ALERT_SECRET is not set' });
    if (auth !== `Bearer ${ALERT_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const { switches, errors } = await fetchSwitches(nowMs);

    if (preview) {
      return res.status(200).json({
        preview: true,
        lookbackMinutes: LOOKBACK_MIN,
        errors,
        switches: switches.sort((a, b) => a.at - b.at).map((s) => ({ ...s, wouldPost: message(s).text })),
      });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { kept, fresh, bootstrap } = plan(switches, body && body.seen, nowMs);

    const posted = [];
    const failed = [];
    if (bootstrap) {
      for (const s of fresh) kept.add(s.key);
    } else {
      if (fresh.length && !SLACK_WEBHOOK_URL) return res.status(500).json({ error: 'SLACK_WEBHOOK_URL is not set' });
      for (const s of fresh) {
        // Slack's webhooks allow about one message a second.
        if (posted.length || failed.length) await sleep(1100);
        const r = await fetch(SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message(s)),
        });
        // Only what Slack accepted counts as posted; the rest is retried on
        // the next run, since it stays out of `seen`.
        if (r.ok) { kept.add(s.key); posted.push(s.name); } else { failed.push(`${s.name}: Slack ${r.status}`); }
      }
    }

    res.status(200).json({
      bootstrap,
      posted,
      errors: [...errors, ...failed],
      seen: [...kept],
    });
  } catch (err) {
    console.error('campaign-alerts failed:', err);
    res.status(500).json({ error: err.message });
  }
};

module.exports.toSwitch = toSwitch;
module.exports.plan = plan;
module.exports.message = message;
