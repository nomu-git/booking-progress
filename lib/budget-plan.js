// Budget Plan (Anton, 29 Oct 2026): the ad budget the team sets on the
// dashboard itself, replacing the old media plan (Updated Budget.xlsx), which
// had stopped matching what actually runs. Everything budget-related reads it:
// Campaigns (budget per campaign, budget vs actual), the KPI "Campaign spend
// within budget", the Dashboard's "Ad budget used" card and the daily
// campaign audit.
//
// A plan has two parts:
//   periods  the money available: "28 Oct to 30 Nov: USD 2,000",
//            "December: USD 1,000". Spend against a period is ALL Meta spend
//            on those days, planned campaign or not, since it's one ad budget.
//   lines    what each campaign is set to spend: SAR per day between two
//            dates, or SAR per week over a run of Sunday-Saturday weeks. A
//            line is tied to a Meta campaign by its id (picked from the
//            running campaigns) or, when typed, by its exact name, so a line
//            can be planned before the campaign exists in Meta.
//
// Stored in Upstash (`budget-plan`). Until the first save, SEED below is the
// plan. Saving is open, like the rest of the site (Anton, 29 Oct 2026: no
// password; the page asks "Are you sure?" before every save instead), with a
// cap on saves per IP so a script can't hammer it.
// Served by api/advisor.js?route=budget-plan (rewritten from /api/budget-plan).

const crypto = require('crypto');
const kv = require('./kv');
const { graphGetAll, getAccountMeta, toReportCurrency, AD_ACCOUNTS, USD_SAR } = require('./meta-ads');

const KEY = 'budget-plan';
const DAY = 86400000;
const muscatToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The plan as set out on 28-29 Oct 2026 (Anton): USD 2,000 from 28 Oct to the
// end of November and USD 1,000 for December; the five campaigns live in Meta
// since 28 Oct at SAR 200 a day each until their review dates (Slack table);
// the always-on engagement post at SAR 30 a day to 30 Nov and SAR 20 a day in
// December, and the January trips ad set at SAR 100 a day in December ("What
// we run"). The last two weren't in Meta yet, so they're typed names.
const SEED = {
  currency: 'SAR',
  periods: [
    { id: 'p-nov', name: '28 Oct to 30 Nov', start: '2026-10-28', end: '2026-11-30', amount: 2000, currency: 'USD' },
    { id: 'p-dec', name: 'December', start: '2026-12-01', end: '2026-12-31', amount: 1000, currency: 'USD' },
  ],
  lines: [
    { id: 'l-bali-ta', campaignId: '52536622278326', name: 'Bali Teaching November New', mode: 'daily', amount: 200, start: '2026-10-28', end: '2026-11-04' },
    { id: 'l-bali-wl', campaignId: '52536631908526', name: 'BALI-WL-202611-01', mode: 'daily', amount: 200, start: '2026-10-28', end: '2026-11-04' },
    { id: 'l-znz-bl', campaignId: '52536313946726', name: 'ZNZ-BL-202611-01', mode: 'daily', amount: 200, start: '2026-10-28', end: '2026-11-04' },
    { id: 'l-znz-ta', campaignId: '52536623080326', name: 'Zanzibar Teaching New', mode: 'daily', amount: 200, start: '2026-10-28', end: '2026-11-04' },
    { id: 'l-sl-ex', campaignId: '52536623506326', name: 'Srilanka Explore', mode: 'daily', amount: 200, start: '2026-10-28', end: '2026-11-10' },
    { id: 'l-eng-nov', campaignId: null, name: 'Engagement post (always on)', mode: 'daily', amount: 30, start: '2026-10-28', end: '2026-11-30' },
    { id: 'l-eng-dec', campaignId: null, name: 'Engagement post (always on)', mode: 'daily', amount: 20, start: '2026-12-01', end: '2026-12-31' },
    { id: 'l-jan', campaignId: null, name: 'January trips', mode: 'daily', amount: 100, start: '2026-12-01', end: '2026-12-31' },
  ],
  updatedAt: null,
};

// ---- reading and writing

async function load() {
  try {
    const raw = await kv.command('GET', KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('budget plan read failed:', e.message);
  }
  return { ...JSON.parse(JSON.stringify(SEED)), seeded: true };
}

function validate(input) {
  const errs = [];
  const p = input && typeof input === 'object' ? input : {};
  const periods = (Array.isArray(p.periods) ? p.periods : []).map((x, i) => ({
    id: String(x.id || `p-${crypto.randomBytes(4).toString('hex')}`).slice(0, 40),
    name: String(x.name || '').trim().slice(0, 60) || `Period ${i + 1}`,
    start: String(x.start || ''), end: String(x.end || ''),
    amount: Number(x.amount), currency: x.currency === 'SAR' ? 'SAR' : 'USD',
  }));
  const lines = (Array.isArray(p.lines) ? p.lines : []).map((x) => ({
    id: String(x.id || `l-${crypto.randomBytes(4).toString('hex')}`).slice(0, 40),
    campaignId: x.campaignId ? String(x.campaignId).replace(/\D/g, '').slice(0, 30) || null : null,
    name: String(x.name || '').trim().slice(0, 120),
    mode: x.mode === 'weekly' ? 'weekly' : 'daily',
    amount: Number(x.amount), start: String(x.start || ''), end: String(x.end || ''),
  }));
  for (const x of [...periods, ...lines]) {
    const what = x.name || 'A line';
    if (!ISO.test(x.start) || !ISO.test(x.end)) errs.push(`${what}: pick a start and an end date.`);
    else if (x.end < x.start) errs.push(`${what}: the end date is before the start date.`);
    else if (daysBetween(x.start, x.end) > 400) errs.push(`${what}: keep it to about a year.`);
    if (!(x.amount > 0) || x.amount > 1e7) errs.push(`${what}: the amount must be more than 0.`);
  }
  for (const l of lines) {
    if (!l.name) errs.push('Every campaign line needs a campaign name.');
    // Weekly budgets run whole Sunday-Saturday weeks.
    if (l.mode === 'weekly' && ISO.test(l.start) && ISO.test(l.end)) {
      if (new Date(`${l.start}T00:00:00Z`).getUTCDay() !== 0 || new Date(`${l.end}T00:00:00Z`).getUTCDay() !== 6) {
        errs.push(`${l.name}: a weekly budget runs from a Sunday to a Saturday.`);
      }
    }
  }
  // One campaign can't have two budgets on the same day: its spend would count twice.
  const key = (l) => (l.campaignId ? `id:${l.campaignId}` : `n:${norm(l.name)}`);
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]; const b = lines[j];
      if (key(a) === key(b) && a.start <= b.end && b.start <= a.end) {
        errs.push(`${a.name}: two budgets overlap (${a.start} to ${a.end} and ${b.start} to ${b.end}). Change the dates so they follow each other.`);
      }
    }
  }
  if (periods.length > 24 || lines.length > 80) errs.push('That is more periods or lines than the plan holds.');
  // A stray or empty save must not wipe the plan.
  if (!periods.length) errs.unshift('Keep at least one budget period.');
  return { errs, plan: { currency: 'SAR', periods, lines } };
}

// ---- the arithmetic

// SAR a line plans for one day.
const perDay = (l) => (l.mode === 'weekly' ? l.amount / 7 : l.amount);
const lineDay = (l, d) => (d >= l.start && d <= l.end ? perDay(l) : 0);
const periodSar = (p) => (p.currency === 'USD' ? p.amount * USD_SAR : p.amount);
function sumDays(from, to, fn) {
  let s = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) s += fn(d);
  return s;
}

// Meta spend per campaign per day (SAR), every account, from `since` to today.
let spendCache = { key: '', at: 0, data: null };
async function spendByDay(since, until) {
  const key = `${since}|${until}`;
  if (spendCache.key === key && Date.now() - spendCache.at < 60000) return spendCache.data;
  const byCampaign = new Map(); // id -> Map(date -> SAR)
  const names = new Map();
  await Promise.all(AD_ACCOUNTS.map(async (acc) => {
    const account = await getAccountMeta(acc);
    const rows = await graphGetAll(`/${acc}/insights`, {
      level: 'campaign',
      time_range: JSON.stringify({ since, until }),
      time_increment: '1',
      fields: 'campaign_id,campaign_name,spend,date_start',
    });
    for (const r of rows) {
      const v = toReportCurrency(r.spend, account.currency);
      if (!v) continue;
      if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, new Map());
      const m = byCampaign.get(r.campaign_id);
      m.set(r.date_start, (m.get(r.date_start) || 0) + v);
      names.set(r.campaign_id, r.campaign_name);
    }
  }));
  const data = { byCampaign, names };
  spendCache = { key, at: Date.now(), data };
  return data;
}

// Everything the pages need, from the plan, Meta's daily spend and the list
// of campaigns Meta knows (to tie typed names and show live status).
// metaCampaigns: [{ id, name, status }] (status 'Active' when running).
async function evaluate(plan, metaCampaigns = []) {
  const today = muscatToday();
  const yesterday = addDays(today, -1);
  const starts = [...plan.periods.map((p) => p.start), ...plan.lines.map((l) => l.start)].filter((d) => d <= today);
  const since = starts.length ? starts.sort()[0] : null;
  let spend = { byCampaign: new Map(), names: new Map() };
  let spendError = null;
  if (since) {
    try { spend = await spendByDay(since, today); } catch (e) { spendError = e.message; console.error('budget plan spend failed:', e.message); }
  }
  const byId = new Map(metaCampaigns.map((c) => [String(c.id), c]));
  const byName = new Map(metaCampaigns.map((c) => [norm(c.name), c]));
  for (const [id, name] of spend.names) if (!byId.has(id)) { byId.set(id, { id, name, status: 'Inactive' }); if (!byName.has(norm(name))) byName.set(norm(name), byId.get(id)); }
  const spentOn = (id, d) => (id && spend.byCampaign.has(id) ? spend.byCampaign.get(id).get(d) || 0 : 0);

  const lines = plan.lines.map((l) => {
    const meta = (l.campaignId && byId.get(l.campaignId)) || byName.get(norm(l.name)) || null;
    const id = meta ? String(meta.id) : null;
    const plannedTotal = sumDays(l.start, l.end, (d) => lineDay(l, d));
    const upTo = (d) => (d < l.start ? null : d > l.end ? l.end : d);
    const yEnd = upTo(yesterday);
    const tEnd = upTo(today);
    const plannedToYesterday = yEnd ? sumDays(l.start, yEnd, (d) => lineDay(l, d)) : 0;
    const spentToYesterday = yEnd ? sumDays(l.start, yEnd, (d) => spentOn(id, d)) : 0;
    const spent = tEnd ? sumDays(l.start, tEnd, (d) => spentOn(id, d)) : 0;
    // Pace leaves out the first day: a campaign switched on mid-afternoon
    // (the 28 Oct ones were) spends only part of its first day's budget.
    const paceFrom = addDays(l.start, 1);
    const paceOk = yEnd && yEnd >= paceFrom;
    const planPace = paceOk ? sumDays(paceFrom, yEnd, (d) => lineDay(l, d)) : 0;
    const spentPace = paceOk ? sumDays(paceFrom, yEnd, (d) => spentOn(id, d)) : 0;
    let status;
    let why;
    if (today < l.start) { status = 'Planned'; why = `Starts ${l.start}`; }
    else if (!meta) { status = 'Not in Meta'; why = 'No Meta campaign has this name yet, so nothing is counted against it'; }
    else if (today > l.end) {
      status = spent > plannedTotal * 1.05 ? 'Over' : 'Ended';
      why = status === 'Over' ? `Spent ${Math.round((spent / plannedTotal - 1) * 100)}% more than planned` : 'Its budget dates are over';
    } else if (spent > plannedTotal) { status = 'Over'; why = 'Already spent more than its whole budget'; }
    else if (!planPace) { status = 'Started'; why = 'Judged from its first full day (the first day may have started part way through)'; }
    else {
      const r = spentPace / planPace;
      if (r > 1.15) { status = 'Fast'; why = `Spending ${Math.round((r - 1) * 100)}% faster than planned`; }
      else if (r < 0.7) { status = 'Slow'; why = `Spending ${Math.round((1 - r) * 100)}% slower than planned`; }
      else { status = 'On track'; why = `${Math.round(r * 100)}% of the planned spend so far`; }
    }
    return {
      ...l,
      perDay: r2(perDay(l)),
      days: daysBetween(l.start, l.end) + 1,
      linked: !!meta,
      metaId: id,
      metaName: meta ? meta.name : null,
      metaStatus: meta ? meta.status : null,
      plannedTotal: r2(plannedTotal),
      plannedToYesterday: r2(plannedToYesterday),
      spentToYesterday: r2(spentToYesterday),
      spent: r2(spent),
      planPace: r2(planPace),
      spentPace: r2(spentPace),
      remaining: r2(plannedTotal - spent),
      todayBudget: r2(lineDay(l, today)),
      status,
      why,
    };
  });

  const plannedIds = new Set(lines.filter((l) => l.metaId).map((l) => l.metaId));
  const periods = plan.periods.map((p) => {
    const amount = periodSar(p);
    const planned = sumDays(p.start, p.end, (d) => plan.lines.reduce((s, l) => s + lineDay(l, d), 0));
    const tEnd = today < p.start ? null : today > p.end ? p.end : today;
    const yEnd = yesterday < p.start ? null : yesterday > p.end ? p.end : yesterday;
    let spent = 0;
    let unplanned = 0;
    let spentToYesterday = 0;
    let spentFull = 0; // from the period's second day, as for lines
    const unplannedBy = new Map();
    for (const [id, m] of spend.byCampaign) {
      for (const [d, v] of m) {
        if (!tEnd || d < p.start || d > tEnd) continue;
        spent += v;
        if (yEnd && d <= yEnd) { spentToYesterday += v; if (d > p.start) spentFull += v; }
        if (!plannedIds.has(id)) { unplanned += v; unplannedBy.set(id, (unplannedBy.get(id) || 0) + v); }
      }
    }
    const days = daysBetween(p.start, p.end) + 1;
    const daysGone = yEnd ? daysBetween(p.start, yEnd) + 1 : 0;
    // Pace from finished days only (today is still spending), leaving out the
    // first day, which is often a part day.
    const fullDays = daysGone - 1;
    const perDayActual = fullDays > 0 ? spentFull / fullDays : null;
    const projected = perDayActual != null ? spentToYesterday + perDayActual * (days - daysGone) : null;
    let runsOut = null;
    if (perDayActual && projected > amount) runsOut = addDays(yEnd, Math.max(1, Math.ceil((amount - spentToYesterday) / perDayActual)));
    return {
      ...p,
      amountSar: r2(amount),
      planned: r2(planned),
      planGap: r2(amount - planned),
      spent: r2(spent),
      remaining: r2(amount - spent),
      unplanned: r2(unplanned),
      unplannedCampaigns: [...unplannedBy].map(([id, v]) => ({ id, name: spend.names.get(id) || id, spent: r2(v) })).sort((a, b) => b.spent - a.spent),
      days,
      daysGone,
      perDayActual: perDayActual == null ? null : r2(perDayActual),
      projected: projected == null ? null : r2(projected),
      runsOut,
      current: today >= p.start && today <= p.end,
      done: today > p.end,
    };
  });

  // Per Meta campaign, for the Campaigns table, the KPI and the audit.
  const byCampaign = {};
  for (const l of lines) {
    if (!l.metaId) continue;
    const c = byCampaign[l.metaId] || (byCampaign[l.metaId] = { budget: 0, spent: 0, plannedToYesterday: 0, spentToYesterday: 0, planPace: 0, spentPace: 0, todayBudget: 0, start: l.start, end: l.end, lines: 0 });
    c.planPace = r2(c.planPace + l.planPace);
    c.spentPace = r2(c.spentPace + l.spentPace);
    c.budget = r2(c.budget + l.plannedTotal);
    c.spent = r2(c.spent + l.spent);
    c.plannedToYesterday = r2(c.plannedToYesterday + l.plannedToYesterday);
    c.spentToYesterday = r2(c.spentToYesterday + l.spentToYesterday);
    c.todayBudget = r2(c.todayBudget + l.todayBudget);
    if (l.start < c.start) c.start = l.start;
    if (l.end > c.end) c.end = l.end;
    c.lines += 1;
  }
  for (const c of Object.values(byCampaign)) {
    c.remaining = r2(c.budget - c.spent);
    c.usedPct = c.budget ? r2(c.spent / c.budget * 1000) / 1000 : null;
    c.pace = c.planPace ? r2(c.spentPace / c.planPace * 1000) / 1000 : null;
  }

  const cur = periods.find((p) => p.current) || null;
  const totals = {
    from: plan.periods.map((p) => p.start).sort()[0] || null,
    to: plan.periods.map((p) => p.end).sort().slice(-1)[0] || null,
    budget: r2(periods.reduce((s, p) => s + p.amountSar, 0)),
    planned: r2(periods.reduce((s, p) => s + p.planned, 0)),
    spent: r2(periods.reduce((s, p) => s + p.spent, 0)),
  };
  totals.remaining = r2(totals.budget - totals.spent);
  totals.usedPct = totals.budget ? totals.spent / totals.budget : null;
  if (totals.from && totals.to) {
    const all = daysBetween(totals.from, totals.to) + 1;
    totals.timeGone = today < totals.from ? 0 : today > totals.to ? 1 : (daysBetween(totals.from, today) + 1) / all;
  }
  return {
    today,
    updatedAt: plan.updatedAt || null,
    seeded: !!plan.seeded,
    usdSar: USD_SAR,
    periods,
    lines,
    byCampaign,
    current: cur ? cur.id : null,
    totals,
    spendError,
  };
}

// ---- the endpoint

async function handle(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await load());
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    // At most 60 saves an hour per IP: plenty for people, not for a script.
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const rk = `plan-saves:${ip}`;
    const [n] = await kv.pipeline([['INCR', rk], ['EXPIRE', rk, 3600]]).catch(() => [0]);
    if (Number(n) > 60) return res.status(429).json({ error: 'Too many saves from here in the last hour. Try again later.' });
    const current = await load();
    // Two people editing at once: the second save would wipe the first.
    if (body.baseUpdatedAt !== undefined && (current.updatedAt || null) !== (body.baseUpdatedAt || null)) {
      return res.status(409).json({ code: 'stale', error: 'Someone else changed the plan a moment ago. The page has reloaded it; make your change again.', plan: current });
    }
    const { errs, plan } = validate(body.plan);
    if (errs.length) return res.status(400).json({ error: errs[0], errors: errs });
    plan.updatedAt = new Date().toISOString();
    await kv.command('SET', KEY, JSON.stringify(plan));
    return res.status(200).json(plan);
  } catch (err) {
    console.error('budget plan failed:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { load, evaluate, validate, handle, SEED, perDay };
