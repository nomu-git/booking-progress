// Cost-per-result alert (Muatasam, 8 Oct 2026: "Add alert for higher cost per
// result for campaigns ... not more than 20 per result", in USD). Posts to
// living-room when a running campaign's cost per result goes over the limit:
//
//   🚨 Campaign: EB-SL-EX-202612-01C is over the cost per result limit.
//   Cost per result is $21.30 (SAR 79.88), limit $20, after 12 results on
//   SAR 958.50 spent. Please review: <dashboard>/#campaigns
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

function message(c, p, dashboard) {
  const cur = p.currency || 'SAR';
  const lim = p.cprLimit;
  const usd = c.costPerResult / (p.usdSar || 3.75);
  const text = `🚨 Campaign: *${c.name}* is over the cost per result limit. Cost per result is *$${fmt(usd)}* (${cur} ${fmt(c.costPerResult)}), limit $${lim.usd}, after ${c.results} results on ${cur} ${fmt(c.spend)} spent. Please review: ${dashboard}/#campaigns`;
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
      wouldPost: over.map((c) => message(c, p, dashboard).text),
    };
  }

  // Re-arm everything that isn't over any more.
  const notOver = p.campaigns.filter((c) => !c.cprOver);
  if (notOver.length) await kv.pipeline(notOver.map((c) => ['DEL', overKey(c)]));

  const claims = await kv.pipeline(over.map((c) => ['SET', overKey(c), '1', 'NX']));
  const fresh = over.filter((c, k) => claims[k] === 'OK');
  const posted = [];
  const failed = [];
  for (const c of fresh) {
    if (posted.length || failed.length) await new Promise((r) => setTimeout(r, 1100));
    let ok = false;
    try {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message(c, p, dashboard)),
      });
      ok = r.ok;
      if (!ok) failed.push(`${c.name}: Slack ${r.status}`);
    } catch (err) {
      failed.push(`${c.name}: ${err.message}`);
    }
    if (ok) posted.push(c.name); else await kv.command('DEL', overKey(c));
  }
  return { over: over.map((c) => c.name), posted, errors: failed };
}

module.exports = { check, message };
