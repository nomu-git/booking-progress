// Daily campaign audit (Anton, 28 Oct 2026): for every running Meta campaign,
// a status (Healthy / Medium / Unhealthy), what is happening, and the one next
// step (keep running, wait, add funds, fix the creative ...). Shown on
// Marketing › Campaigns only; nothing goes to Slack (Anton's call).
//
// How it's made:
//   - The STATUS comes from fixed rules over Meta's numbers (below), so it is
//     stable and explainable: the same figures always give the same status.
//   - Claude (Sonnet) reads those figures and writes the two texts: "What's
//     happening" and "Next step". It gets numbers only and no tools, so it
//     can't change anything in Meta. If Claude can't be reached (no key, no
//     credit), the same two texts are written by rules instead, so the panel
//     never goes blank.
//   - It runs once a day and is stored in Upstash (`campaign-audit:latest`).
//     Opening the tab only reads the stored audit, so it costs nothing and
//     never waits on Claude. A Vercel cron (vercel.json) refreshes it every
//     morning; if that ever misses, the first visit after 24 hours refreshes
//     it instead. One Claude call a day, a few cents.
//
// Served by api/advisor.js?route=campaign-audit (rewritten from
// /api/campaign-audit), since all 12 Vercel function slots are used.

const sdk = require('@anthropic-ai/sdk');
const kv = require('./kv');
const { graphGetAll, getAccountMeta, toReportCurrency, AD_ACCOUNTS, REPORT_CURRENCY } = require('./meta-ads');
const campaignsApi = require('../api/campaigns');

const Anthropic = sdk.default || sdk;
const MODEL = process.env.AUDIT_MODEL || 'claude-sonnet-5-5';
const KEY = 'campaign-audit:latest';
const LOCK = 'campaign-audit:lock';
// A page visit refreshes an audit older than this; the morning cron, a bit
// earlier, so its own drift can't make it skip a day.
const MAX_AGE_MS = 24 * 3600 * 1000;
const CRON_AGE_MS = 20 * 3600 * 1000;

const LIMIT = campaignsApi.CPR_LIMIT; // SAR 25 per result (Muatasam)
const MIN_RESULTS = campaignsApi.CPR_MIN_RESULTS; // 5
const MIN_DAYS = Number(process.env.AUDIT_MIN_DAYS || 5); // Meta's learning phase
const FREQ_HIGH = Number(process.env.AUDIT_FREQ_HIGH || 3); // same people seeing it 3+ times a week

const ACTIONS = ['Keep running', 'Wait', 'Add funds', 'Reduce budget', 'Fix creative', 'Fix targeting', 'Pause'];

const DAY = 86400000;
const muscatDate = (ms) => new Date(ms + 4 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const n0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Two 7-day windows (last 7 finished Muscat days, and the 7 before) plus each
// active ad set's learning stage, for the running campaigns only.
async function loadWeekly(running) {
  const today = muscatDate(Date.now());
  const windows = {
    last: { since: addDays(today, -7), until: addDays(today, -1) },
    prev: { since: addDays(today, -14), until: addDays(today, -8) },
  };
  const ids = new Set(running.map((c) => c.id));
  const week = { last: new Map(), prev: new Map() };
  const learning = new Map();
  await Promise.all(AD_ACCOUNTS.map(async (acc) => {
    const account = await getAccountMeta(acc);
    const [last, prev, sets] = await Promise.all([
      ...['last', 'prev'].map((w) => graphGetAll(`/${acc}/insights`, {
        level: 'campaign',
        time_range: JSON.stringify(windows[w]),
        fields: 'campaign_id,spend,impressions,reach,actions,inline_link_clicks',
      }).catch((e) => { console.error(`audit ${w} insights ${acc}: ${e.message}`); return []; })),
      graphGetAll(`/${acc}/adsets`, { fields: 'campaign_id,effective_status,learning_stage_info' })
        .catch((e) => { console.error(`audit adsets ${acc}: ${e.message}`); return []; }),
    ]);
    for (const [w, rows] of [['last', last], ['prev', prev]]) {
      for (const row of rows) {
        if (!ids.has(row.campaign_id)) continue;
        week[w].set(row.campaign_id, { ...row, spend: toReportCurrency(row.spend, account.currency) });
      }
    }
    for (const s of sets) {
      if (!ids.has(s.campaign_id) || s.effective_status !== 'ACTIVE') continue;
      const st = (s.learning_stage_info && s.learning_stage_info.status) || null;
      const l = learning.get(s.campaign_id) || { learning: 0, limited: 0, done: 0 };
      if (st === 'LEARNING') l.learning += 1;
      else if (st === 'FAIL') l.limited += 1;
      else if (st === 'SUCCESS') l.done += 1;
      learning.set(s.campaign_id, l);
    }
  }));
  return { windows, week, learning };
}

function weekFacts(row, label) {
  if (!row) return { spend: 0, results: 0, costPerResult: null, linkCtr: null, frequency: null, impressions: 0 };
  const spend = n0(row.spend);
  const impressions = n0(row.impressions);
  const reach = n0(row.reach);
  const results = campaignsApi.resultsOf(row, label);
  return {
    spend: r2(spend),
    results,
    costPerResult: results ? r2(spend / results) : null,
    linkCtr: impressions ? r2((n0(row.inline_link_clicks) / impressions) * 100) : null,
    frequency: reach ? r2(impressions / reach) : null,
    impressions,
  };
}

// ---- The status rules. Every reason says which way it pushes.
function judge(f) {
  const bad = [];
  const mid = [];
  const early = f.daysRunning < MIN_DAYS || f.results < MIN_RESULTS;
  if (f.costPerResult != null && f.results >= MIN_RESULTS && f.costPerResult > LIMIT) {
    bad.push(`Cost per result ${REPORT_CURRENCY} ${f.costPerResult} is over the ${REPORT_CURRENCY} ${LIMIT} limit`);
  }
  // Over a real plan budget is Unhealthy; over the assumed $500 (no plan line)
  // only Medium, since that budget was never actually set.
  if (f.budgetUsedPct != null && f.budgetUsedPct > 1) {
    if (f.budgetAssumed) mid.push(`Over the assumed budget (${Math.round(f.budgetUsedPct * 100)}% used; it has no line in the media plan)`);
    else bad.push(`Over its budget (${Math.round(f.budgetUsedPct * 100)}% used)`);
  }
  if (!early && f.last7.results === 0 && f.last7.spend >= 2 * LIMIT) {
    bad.push(`${REPORT_CURRENCY} ${f.last7.spend} spent in the last 7 days with no results`);
  }
  if (f.leadQuality && f.leadQuality.status === 'Bad') bad.push(`Lead quality is Bad (${f.leadQuality.why})`);

  if (early) mid.push(`Too early to judge: ${f.daysRunning} day${f.daysRunning === 1 ? '' : 's'} running, ${f.results} result${f.results === 1 ? '' : 's'} (needs ${MIN_DAYS} days and ${MIN_RESULTS} results)`);
  if (f.learning && f.learning.learning) mid.push('Still in Meta\'s learning phase');
  if (f.learning && f.learning.limited) mid.push('Meta reports "learning limited" (not enough results to optimise)');
  if (f.last7.costPerResult != null && f.last7.results >= 3 && f.last7.costPerResult > LIMIT && !(f.costPerResult > LIMIT)) {
    mid.push(`Last 7 days cost ${REPORT_CURRENCY} ${f.last7.costPerResult} per result, over the limit`);
  }
  if (f.costPerResult != null && f.results >= MIN_RESULTS && f.costPerResult > 0.8 * LIMIT && f.costPerResult <= LIMIT) {
    mid.push(`Cost per result ${REPORT_CURRENCY} ${f.costPerResult} is close to the ${REPORT_CURRENCY} ${LIMIT} limit`);
  }
  if (f.budgetUsedPct != null && f.budgetUsedPct >= 0.9 && f.budgetUsedPct <= 1) mid.push(`${Math.round(f.budgetUsedPct * 100)}% of its budget used`);
  if (f.last7.frequency != null && f.last7.frequency > FREQ_HIGH) mid.push(`Frequency ${f.last7.frequency} in the last 7 days: the same people keep seeing it`);
  if (f.prev7.results >= 5 && f.last7.results < f.prev7.results / 2) mid.push(`Results fell from ${f.prev7.results} to ${f.last7.results} week on week`);
  if (f.leadQuality && f.leadQuality.status === 'Watch') mid.push(`Lead quality is Watch (${f.leadQuality.why})`);

  const status = bad.length ? 'Unhealthy' : mid.length ? 'Medium' : 'Healthy';
  const good = [];
  if (status === 'Healthy') {
    if (f.costPerResult != null) good.push(`Cost per result ${REPORT_CURRENCY} ${f.costPerResult}, under the ${REPORT_CURRENCY} ${LIMIT} limit`);
    if (f.last7.results) good.push(`${f.last7.results} results in the last 7 days`);
  }
  // "Add funds" only for a proven, healthy campaign with money and pace to use it.
  const canAddFunds = status === 'Healthy' && !early && f.last7.results >= MIN_RESULTS;
  return { status, reasons: [...bad, ...mid, ...good], early, canAddFunds };
}

// Written by rules, used when Claude isn't available.
function ruleText(f, j) {
  const cur = REPORT_CURRENCY;
  const week = f.last7.spend
    ? `${cur} ${f.last7.spend} spent in the last 7 days for ${f.last7.results} result${f.last7.results === 1 ? '' : 's'}${f.last7.costPerResult != null ? ` (${cur} ${f.last7.costPerResult} each)` : ''}.`
    : 'No spend in the last 7 days.';
  const happening = `${j.reasons[0] ? `${j.reasons[0]}.` : 'Running within its limits.'} ${week}`;
  let action = 'Keep running';
  let step = 'Keep it running and check again tomorrow.';
  if (j.early) { action = 'Wait'; step = `Leave it unchanged until it has ${MIN_DAYS} days and ${MIN_RESULTS} results, then judge it.`; }
  else if (f.budgetUsedPct > 1 && !f.budgetAssumed) { action = 'Reduce budget'; step = 'It is over its budget: lower the daily budget or pause it until the budget is agreed.'; }
  else if (f.costPerResult > LIMIT) { action = 'Fix creative'; step = `Refresh the creative or narrow the audience to bring cost per result under ${cur} ${LIMIT}.`; }
  else if (f.leadQuality && f.leadQuality.status === 'Bad') { action = 'Fix targeting'; step = 'Leads are low quality: tighten the audience and the message so it reaches people ready to book.'; }
  else if (f.last7.results === 0 && f.last7.spend >= 2 * LIMIT) { action = 'Fix targeting'; step = 'It is spending without results: check the ad, the audience and the result setup.'; }
  else if (f.last7.frequency > FREQ_HIGH) { action = 'Fix creative'; step = 'Add a new creative: the same people are seeing this one too often.'; }
  else if (j.canAddFunds && f.costPerResult != null && f.costPerResult < 0.6 * LIMIT && (f.budgetRemaining == null || f.budgetRemaining > 0)) {
    action = 'Add funds'; step = `Cost per result is well under the limit: raise the daily budget by about 20% and watch it for 3 days.`;
  }
  return { happening, action, step };
}

const SYSTEM = `You audit NomuHub's running Meta (Facebook / Instagram) ad campaigns once a day. NomuHub sells volunteering, wellness and explore trips (Zanzibar, Bali, Thailand, Sri Lanka, Vietnam, Kenya and more); most campaigns aim for WhatsApp / Instagram message conversations (a "result").

For each campaign you get its figures and a status already decided by fixed rules (Healthy, Medium or Unhealthy) with the reasons. Do not change or argue with the status. Write two things per campaign, for a busy manager deciding what to do today:
1. happening: what is happening with this campaign, in 1 or 2 short sentences, quoting the key numbers (cost per result, results, last 7 days against the 7 before, budget used). Plain English.
2. action and step: the ONE next step. action is exactly one of: ${ACTIONS.join(', ')}. step is one concrete sentence saying what to do and when to check again, with numbers where they help (for example "Raise the daily budget from SAR 50 to SAR 60 and check again on Sunday").

Rules for the step:
- A campaign marked early (too early to judge) gets Wait: Meta needs about ${MIN_DAYS} days and ${MIN_RESULTS} results to learn. Say until when.
- "Add funds" only when canAddFunds is true. Never suggest more budget otherwise.
- Unhealthy: the step must fix the main reason (cost, budget, no results, lead quality, ad fatigue).
- Cost per result limit is ${REPORT_CURRENCY} ${LIMIT}. Money is in ${REPORT_CURRENCY}.
- Lead quality figures match leads to a campaign by project, so they include organic leads of that project. Treat them as a signal, not proof.
- Use only the figures given. Don't invent numbers. No em dashes. Keep each text under 40 words.

Reply with JSON only, no other text: {"campaigns":[{"id":"...","happening":"...","action":"...","step":"..."}]}`;

async function claudeTexts(facts) {
  if (!(process.env.ANTHROPIC_API_KEY || '').trim()) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic();
  const input = facts.map((f) => ({
    id: f.id, name: f.name, objective: f.objective, status: f.status, reasons: f.reasons,
    early: f.early, canAddFunds: f.canAddFunds, daysRunning: f.daysRunning,
    yearToDate: { spend: f.spend, results: f.results, costPerResult: f.costPerResult },
    last7Days: f.last7, previous7Days: f.prev7,
    dailyBudget: f.dailyBudget, budget: f.budget, budgetUsedPct: f.budgetUsedPct, budgetRemaining: f.budgetRemaining,
    budgetIsAssumed: f.budgetAssumed, learning: f.learning, leadQuality: f.leadQuality,
  }));
  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Today is ${muscatDate(Date.now())} (Muscat). Running campaigns:\n${JSON.stringify(input, null, 1)}` }],
  }, { timeout: 150000, maxRetries: 1 });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const out = new Map();
  for (const c of json.campaigns || []) out.set(String(c.id), c);
  return { out, usage: msg.usage && { in: msg.usage.input_tokens, out: msg.usage.output_tokens } };
}

async function generate() {
  const board = await campaignsApi.build();
  const running = (board.campaigns || []).filter((c) => c.status === 'Active');
  const { windows, week, learning } = running.length ? await loadWeekly(running) : { windows: null, week: null, learning: null };
  const now = Date.now();

  const facts = running.map((c) => {
    const start = c.startDate ? Date.parse(c.startDate) : NaN;
    const lq = c.leadQuality && c.leadQuality.linked
      ? { project: c.leadQuality.project, leads: c.leadQuality.leads, hp: c.leadQuality.hp, hpRate: r2(c.leadQuality.hpRate), costPerHp: r2(c.leadQuality.costPerHp), status: c.leadQuality.status, why: c.leadQuality.why }
      : null;
    const f = {
      id: c.id,
      name: c.name,
      objective: c.objective,
      daysRunning: Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / DAY)) : null,
      spend: r2(c.spend),
      results: c.results,
      costPerResult: r2(c.costPerResult),
      dailyBudget: r2(c.dailyBudget),
      budget: r2(c.budgetSar),
      budgetAssumed: c.budgetSource !== 'plan',
      budgetUsedPct: r2(c.usedPct),
      budgetRemaining: r2(c.remaining),
      last7: weekFacts(week.last.get(c.id), c.objective),
      prev7: weekFacts(week.prev.get(c.id), c.objective),
      learning: learning.get(c.id) || null,
      leadQuality: lq,
    };
    if (f.daysRunning == null) f.daysRunning = 0;
    return Object.assign(f, judge(f));
  });

  let source = 'rules';
  let error = null;
  let usage = null;
  let texts = new Map();
  if (facts.length) {
    try {
      const r = await claudeTexts(facts);
      texts = r.out;
      usage = r.usage;
      source = 'claude';
    } catch (e) {
      console.error('campaign audit: Claude failed, rules used:', e);
      error = /credit|balance|billing/i.test(String(e.message)) ? 'Claude is out of credit, so the notes are written by rules today.' : 'Claude could not be reached, so the notes are written by rules today.';
    }
  }

  const ORDER = { Unhealthy: 0, Medium: 1, Healthy: 2 };
  const campaigns = facts.map((f) => {
    const rule = ruleText(f, f);
    const ai = texts.get(String(f.id));
    let { happening, action, step } = rule;
    let by = 'rules';
    if (ai && ai.happening && ai.step && ACTIONS.includes(ai.action)) {
      // Claude's suggestion stands unless it breaks the money rule.
      if (ai.action !== 'Add funds' || f.canAddFunds) {
        ({ happening, action, step } = ai);
        by = 'claude';
      }
    }
    const strip = (s) => String(s).replace(/\s*—\s*/g, ', ').trim();
    return { ...f, happening: strip(happening), action, step: strip(step), by };
  }).sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.spend - a.spend);

  const count = (s) => campaigns.filter((c) => c.status === s).length;
  return {
    generatedAt: new Date(now).toISOString(),
    date: muscatDate(now),
    currency: REPORT_CURRENCY,
    source,
    model: source === 'claude' ? MODEL : null,
    error,
    usage,
    windows,
    rules: { cprLimit: LIMIT, minResults: MIN_RESULTS, minDays: MIN_DAYS, frequencyHigh: FREQ_HIGH },
    summary: { running: campaigns.length, healthy: count('Healthy'), medium: count('Medium'), unhealthy: count('Unhealthy') },
    campaigns,
  };
}

async function stored() {
  try {
    const raw = await kv.command('GET', KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('campaign audit store read failed:', e.message);
    return null;
  }
}

// Refresh if the stored audit is older than maxAge; one refresh at a time.
async function refreshIfOld(maxAge, force) {
  const have = await stored();
  const age = have ? Date.now() - Date.parse(have.generatedAt) : Infinity;
  if (!force && age < maxAge) return { audit: have, refreshed: false };
  const got = await kv.command('SET', LOCK, '1', 'NX', 'EX', '280').catch(() => 'OK');
  if (got !== 'OK') return { audit: have, refreshed: false, busy: true };
  try {
    const audit = await generate();
    await kv.command('SET', KEY, JSON.stringify(audit)).catch((e) => console.error('campaign audit store write failed:', e.message));
    return { audit, refreshed: true };
  } finally {
    await kv.command('DEL', LOCK).catch(() => {});
  }
}

async function handle(req, res) {
  try {
    const auth = req.headers.authorization || '';
    const secrets = [process.env.CRON_SECRET, process.env.CAMPAIGN_ALERT_SECRET].map((s) => (s || '').trim()).filter(Boolean);
    const trusted = secrets.some((s) => auth === `Bearer ${s}`);
    const cron = trusted || /vercel-cron/i.test(req.headers['user-agent'] || '');
    // Only the secret can force a new one (each costs a Claude call).
    const force = trusted && req.query && req.query.force === '1';
    const { audit, refreshed, busy } = await refreshIfOld(cron ? CRON_AGE_MS : MAX_AGE_MS, force);
    if (!audit) return res.status(busy ? 202 : 500).json({ pending: !!busy, error: busy ? 'The audit is being prepared. Check back in a minute.' : 'No audit yet.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ...audit, refreshed });
  } catch (err) {
    console.error('campaign audit failed:', err);
    const have = await stored();
    if (have) return res.status(200).json({ ...have, stale: true, staleError: err.message });
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handle, generate, judge, ruleText };
