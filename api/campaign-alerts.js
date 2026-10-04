// Posts to Slack when a campaign is switched on or off in Meta Ads Manager:
//   "Campaign: ZNZ-BL-202609-02C has been switched off at 3:42 PM on Sat 4 Oct
//    (Muscat), by Maryem Sayed. Please review the changes: <dashboard>"
//
// Meta has no push notification for this. Its ad-account webhooks cover
// creative fatigue, ads with issues, ads in review and a few others, but not
// a campaign's on/off status. What it does have is the account's activity log
// (the Ads Manager "History" page), which records every switch with its exact
// time and who made it. So this reads that log, and cron-job.org calls it
// every 2 minutes (Vercel's Hobby plan only allows daily crons, and GitHub
// Actions' schedule never started at all for this repo, 4 Oct 2026). The
// time in the message is the switch's own time from the log, not when it
// was noticed.
//
// "Already posted" lives in Upstash Redis (lib/kv.js): each alert is
// claimed with SET NX before it's posted, so two overlapping calls can't
// both post it, and a claim whose Slack post fails is released to retry on
// the next call. Every call looks back LOOKBACK_MIN minutes, so a missed
// call catches up. Until the store has been initialised (its first call, or
// after it's wiped), a call claims everything in the window without
// posting, rather than replaying old switches into the channel.
//
// Only campaigns, not ad sets or ads: those change far more often (Meta
// itself moves ads through review states) and would bury the channel.
//
// New campaigns get their own message too ("has been created ... and is
// currently on"). Meta logs a creation as "Campaign created" with no status
// in it, and a campaign created live never gets a status-change row, so the
// current status is looked up when the message is posted.

const { graphGet, graphGetAll, AD_ACCOUNTS } = require('../lib/meta-ads');
const kv = require('../lib/kv');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://bookingprogress.vercel.app';
const ALERT_SECRET = (process.env.CAMPAIGN_ALERT_SECRET || '').trim();
const LOOKBACK_MIN = Number(process.env.CAMPAIGN_ALERT_LOOKBACK_MIN || 60);
// A claim outlives the lookback window comfortably, then expires.
const CLAIM_TTL_S = 2 * 24 * 3600;
const READY_KEY = 'campaign-alerts:ready';
const claimKey = (s) => `campaign-alerts:${s.key}`;

const parseExtra = (v) => {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}'); } catch (e) { return {}; }
};

// Meta's raw names for a campaign being created; the translated label
// ("Campaign created") is what Ads Manager shows and is checked as well.
const CREATED = /^create_campaign(_group|_legacy)?$/;

// One activity-log row -> a switch or a creation, or null if it's neither.
// The raw event_type for a switch is update_campaign_run_status; the
// translated labels are checked too in case Meta renames the raw ones.
function toSwitch(a, account) {
  const label = String(a.translated_event_type || '');
  const at = Date.parse(String(a.event_time || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(at)) return null;
  const base = {
    account,
    id: String(a.object_id || ''),
    name: String(a.object_name || a.object_id || 'Unnamed campaign'),
    at,
    by: a.actor_name ? String(a.actor_name) : null,
  };
  if (CREATED.test(String(a.event_type || '')) || /^campaign created$/i.test(label)) {
    return { ...base, key: `${account}:${base.id}:${at}:created`, state: 'created', from: '', to: '' };
  }
  const isCampaign = a.event_type === 'update_campaign_run_status'
    || /^campaign status updated$/i.test(label);
  if (!isCampaign) return null;
  const extra = parseExtra(a.extra_data);
  const from = String(extra.old_value || '');
  const to = String(extra.new_value || '');
  // On means it became Active; off means it stopped being Active (paused,
  // switched off, or deleted while running). Anything else, e.g. a paused
  // campaign being deleted, isn't an on/off switch.
  let state = null;
  if (/^active$/i.test(to) && !/^active$/i.test(from)) state = 'on';
  else if (/^active$/i.test(from) && !/^active$/i.test(to)) state = 'off';
  if (!state) return null;
  return { ...base, key: `${account}:${base.id}:${at}:${state}`, state, from, to };
}

// What a new campaign is doing now, in the words the on/off alerts use.
// Paused and in-review campaigns aren't running, so they read as off.
const NOW_STATE = {
  ACTIVE: 'on', PAUSED: 'off', CAMPAIGN_PAUSED: 'off', ADSET_PAUSED: 'off',
  IN_PROCESS: 'off (processing)', PENDING_REVIEW: 'off (in review)', WITH_ISSUES: 'on, with issues',
  DELETED: 'deleted', ARCHIVED: 'archived',
};
async function currentState(id) {
  try {
    const c = await graphGet(`/${id}`, { fields: 'effective_status' });
    const st = String((c && c.effective_status) || '');
    return NOW_STATE[st] || (st ? st.toLowerCase().replace(/_/g, ' ') : null);
  } catch (err) {
    return null;
  }
}

const muscat = (ms) => {
  const time = new Date(ms).toLocaleTimeString('en-US', { timeZone: 'Asia/Muscat', hour: 'numeric', minute: '2-digit', hour12: true });
  // en-GB spells September "Sept"; "Sep" like every other month.
  const day = new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Asia/Muscat', weekday: 'short', day: 'numeric', month: 'short' }).replace('Sept', 'Sep');
  return `${time} on ${day}`;
};

function message(s) {
  const by = s.by ? `, by ${s.by}` : '';
  const when = `${muscat(s.at)} (Muscat)${by}`;
  const text = s.state === 'created'
    ? `Campaign: *${s.name}* has been created at ${when}${s.now ? `, and is currently *${s.now}*` : ''}. Please review the changes: ${DASHBOARD_URL}/#campaigns`
    : `Campaign: *${s.name}* has been switched *${s.state}* at ${when}. Please review the changes: ${DASHBOARD_URL}/#campaigns`;
  const icon = s.state === 'created' ? ':new:' : s.state === 'on' ? ':large_green_circle:' : ':red_circle:';
  return { text: text.replace(/\*/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${icon} ${text}` } }] };
}

// Creations need their current status before they're posted (one small
// call each, only for the ones about to go out).
async function withStatus(list) {
  await Promise.all(list.filter((s) => s.state === 'created').map(async (s) => { s.now = await currentState(s.id); }));
  return list;
}


async function fetchSwitches(nowMs, lookbackMin = LOOKBACK_MIN) {
  const since = Math.floor((nowMs - lookbackMin * 60 * 1000) / 1000);
  const switches = [];
  const errors = [];
  const types = {};
  for (const account of AD_ACCOUNTS) {
    try {
      const rows = await graphGetAll(`/${account}/activities`, {
        fields: 'event_type,translated_event_type,event_time,object_id,object_name,object_type,actor_name,extra_data',
        since,
        until: Math.floor(nowMs / 1000) + 60,
        limit: 200,
      }, 10);
      for (const a of rows) {
        const t = `${a.event_type} (${a.translated_event_type || ''})`;
        types[t] = (types[t] || 0) + 1;
        const s = toSwitch(a, account);
        if (s) switches.push(s);
      }
    } catch (err) {
      errors.push(`${account}: ${err.message}`);
    }
  }
  return { switches, errors, types };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const nowMs = Date.now();
  const preview = req.query && req.query.preview === '1';

  // Posting needs the secret, so only the scheduler can trigger it. Preview
  // only reads, and is open until a secret is set.
  if (!preview || ALERT_SECRET) {
    const auth = req.headers.authorization || '';
    if (!ALERT_SECRET) return res.status(500).json({ error: 'CAMPAIGN_ALERT_SECRET is not set' });
    if (auth !== `Bearer ${ALERT_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // Preview can look further back (?hours=, up to 10 days) to check the
    // reading against real switches when there's been none lately.
    const hours = Math.min(240, Number(req.query && req.query.hours) || 0);
    const lookback = preview && hours > 0 ? hours * 60 : LOOKBACK_MIN;
    const { switches, errors, types } = await fetchSwitches(nowMs, lookback);

    if (preview) {
      await withStatus(switches);
      return res.status(200).json({
        preview: true,
        lookbackMinutes: lookback,
        errors,
        // Meta's raw event names seen in the window, to check the matching.
        eventTypes: types,
        switches: switches.sort((a, b) => a.at - b.at).map((s) => ({ ...s, wouldPost: message(s).text })),
      });
    }

    const floor = nowMs - LOOKBACK_MIN * 60 * 1000;
    const inWindow = switches.filter((s) => s.at >= floor).sort((a, b) => a.at - b.at);
    const posted = [];
    const failed = [];

    // First call against an empty store: claim what's there, post nothing.
    const ready = await kv.command('GET', READY_KEY);
    if (!ready) {
      await kv.pipeline([
        ...inWindow.map((s) => ['SET', claimKey(s), '1', 'NX', 'EX', CLAIM_TTL_S]),
        ['SET', READY_KEY, String(nowMs)],
      ]);
      return res.status(200).json({ bootstrap: true, recorded: inWindow.length, posted, errors });
    }

    // Claim every alert in the window in one round trip; "OK" means this call
    // got it first and should post it, null means it was already handled.
    const claims = await kv.pipeline(inWindow.map((s) => ['SET', claimKey(s), '1', 'NX', 'EX', CLAIM_TTL_S]));
    const fresh = inWindow.filter((s, k) => claims[k] === 'OK');
    if (fresh.length && !SLACK_WEBHOOK_URL) {
      await kv.pipeline(fresh.map((s) => ['DEL', claimKey(s)]));
      return res.status(500).json({ error: 'SLACK_WEBHOOK_URL is not set' });
    }
    await withStatus(fresh);
    for (const s of fresh) {
      // Slack's webhooks allow about one message a second.
      if (posted.length || failed.length) await sleep(1100);
      let ok = false;
      try {
        const r = await fetch(SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message(s)),
        });
        ok = r.ok;
        if (!ok) failed.push(`${s.name}: Slack ${r.status}`);
      } catch (err) {
        failed.push(`${s.name}: ${err.message}`);
      }
      // Not posted: give the claim back so the next call tries again.
      if (ok) posted.push(s.name); else await kv.command('DEL', claimKey(s));
    }

    res.status(200).json({ bootstrap: false, posted, errors: [...errors, ...failed] });
  } catch (err) {
    console.error('campaign-alerts failed:', err);
    res.status(500).json({ error: err.message });
  }
};

module.exports.toSwitch = toSwitch;
module.exports.message = message;
