// Cost-per-result alert (Muatasam, 8 Oct 2026: "Add alert for higher cost per
// result for campaigns"; limit SAR 25, CPR_ALERT_LIMIT in api/campaigns.js). Posts to
// living-room when a running campaign's cost per result goes over the limit:
//
//   🚨 Campaign: EB-SL-EX-202612-01C is over the cost per result limit.
//   Cost per result is SAR 41.98 (limit SAR 25), after 12 results on
//   SAR 503.73 spent. Please review: <dashboard>/#campaigns
//
// The limit was $20 at first, then Muatasam set it at SAR 25 (8 Oct 2026).
//
// Meta can't push this either, so it rides on the campaign on/off job that
// cron-job.org already calls every 2 minutes, and runs at most every
// CHECK_EVERY_S (the year's insights are heavier than the activity log, and
// Meta's figures lag by minutes anyway). The numbers and the over/under
// rule are api/campaigns.js's own (cprOver), so Slack and the board agree.
//
// One alert per crossing: going over claims cpr-alerts:over:<id> in Upstash
// and posts; it stays claimed while the campaign stays over, so it isn't
// repeated; once the campaign is back at or under the limit (or no longer
// counts, e.g. paused) the claim is cleared and the next crossing alerts again.

const kv = require('./kv');

const CHECK_EVERY_S = Number(process.env.CPR_ALERT_EVERY_S || 600);
const TICK_KEY = 'cpr-alerts:tick';
const overKey = (c) => `cpr-alerts:over:${c.account}:${c.id}`;

const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// One campaign gets the full sentence; several crossing in the same check
// (e.g. the first check after the limit changes) share one message, so the
// channel isn't flooded.
function message(list, p, dashboard) {
  const cur = p.currency || 'SAR';
  const limit = `limit ${cur} ${p.cprLimit.report}`;
  const line = (c) => `*${c.name}*: ${cur} ${fmt(c.costPerResult)} per result (${c.results} results, ${cur} ${fmt(c.spend)} spent)`;
  const text = list.length === 1
    ? `🚨 Campaign: *${list[0].name}* is over the cost per result limit. Cost per result is *${cur} ${fmt(list[0].costPerResult)}* (${limit}), after ${list[0].results} results on ${cur} ${fmt(list[0].spend)} spent. Please review: ${dashboard}/#campaigns`
    : `🚨 ${list.length} campaigns are over the cost per result ${limit}:\n${list.map((c) => `• ${line(c)}`).join('\n')}\nPlease review: ${dashboard}/#campaigns`;
  return { text: text.replace(/\*/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

// Preview skips the every-10-minutes gate and posts nothing.
async function check({ build, webhook, dashboard, preview = false }) {
  if (!preview) {
    const tick = await kv.command('SET', TICK_KEY, '1', 'NX', 'EX', CHECK_EVERY_S);
    if (tick !== 'OK') return { skipped: true };
  }
  const p = await build();
  if (!p.cprLimit) return { error: 'no cprLimit in campaigns payload' };
  const over = p.campaigns.filter((c) => c.cprOver);
  if (preview) {
    return {
      limit: p.cprLimit,
      running: p.campaigns.filter((c) => c.status === 'Active').map((c) => ({ name: c.name, results: c.results, costPerResult: c.costPerResult, over: c.cprOver })),
      wouldPost: over.length ? message(over, p, dashboard).text : null,
    };
  }

  // Re-arm everything that isn't over any more.
  const notOver = p.campaigns.filter((c) => !c.cprOver);
  if (notOver.length) await kv.pipeline(notOver.map((c) => ['DEL', overKey(c)]));

  const claims = await kv.pipeline(over.map((c) => ['SET', overKey(c), '1', 'NX']));
  const fresh = over.filter((c, k) => claims[k] === 'OK');
  const posted = [];
  const failed = [];
  if (fresh.length) {
    let ok = false;
    try {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message(fresh, p, dashboard)),
      });
      ok = r.ok;
      if (!ok) failed.push(`Slack ${r.status}`);
    } catch (err) {
      failed.push(err.message);
    }
    // Not posted: release the claims so the next check tries again.
    if (ok) posted.push(...fresh.map((c) => c.name));
    else await kv.pipeline(fresh.map((c) => ['DEL', overKey(c)]));
  }
  return { over: over.map((c) => c.name), posted, errors: failed };
}

module.exports = { check, message };
