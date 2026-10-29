const {
  graphGetAll, getAccountMeta, toReportCurrency, budgetToReportCurrency,
  AD_ACCOUNTS, REPORT_CURRENCY, USD_SAR,
} = require('../lib/meta-ads');
const { mapWithConcurrency } = require('../lib/wetravel');
const budgetPlan = require('../lib/budget-plan');
const { fetchWorkbook } = require('../lib/sheet');
const leadsTab = require('../lib/tabs/leads');
const manychat = require('../lib/manychat');
const { leadProject } = require('./booking-report');

const CACHE_TTL_MS = Number(process.env.META_CACHE_TTL_MS || 300000);

// The sheet this replaces is "2026 figures only". Year is overridable so the
// board rolls into 2027 without a code change.
const YEAR = Number(process.env.META_YEAR || new Date().getUTCFullYear());

// Cost-per-result limit, in the report currency (SAR). Muatasam first said
// "not more than 20 per result" (taken as USD), then on 8 Oct 2026: "Alarm
// should be 25 SAR". Applies to running campaigns only, and only once a
// campaign has CPR_MIN_RESULTS results, so one early result on a fresh
// campaign can't trip it. The board flags it and api/campaign-alerts.js posts
// to Slack when a campaign crosses it; both read cprOver from here.
const CPR_LIMIT = Number(process.env.CPR_ALERT_LIMIT || 25);
const CPR_MIN_RESULTS = Number(process.env.CPR_ALERT_MIN_RESULTS || 5);

let cache = { at: 0, payload: null };

// Both the legacy objective names and the newer ODAX ones land on the same
// six labels the spreadsheet's "Performance by Campaign Objective" table uses.
const OBJECTIVE_LABEL = {
  MESSAGES: 'Messages',
  OUTCOME_ENGAGEMENT: 'Messages',
  CONVERSIONS: 'Purchases',
  OUTCOME_SALES: 'Purchases',
  PRODUCT_CATALOG_SALES: 'Purchases',
  LEAD_GENERATION: 'Leads',
  OUTCOME_LEADS: 'Leads',
  LINK_CLICKS: 'Link Clicks',
  OUTCOME_TRAFFIC: 'Link Clicks',
  REACH: 'Reach',
  BRAND_AWARENESS: 'Reach',
  OUTCOME_AWARENESS: 'Reach',
};

// "Results" means a different action per objective — the same way Ads Manager
// shows one Results column whose meaning shifts with the campaign.
const RESULT_ACTIONS = {
  Messages: ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.messaging_first_reply'],
  Purchases: ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'],
  // A Leads campaign can be set to get its leads as WhatsApp / Messenger
  // conversations; Meta then reports its results as conversations started
  // (the five campaigns launched 28 Oct 2026 do). Form leads first, then that.
  Leads: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.messaging_conversation_started_7d'],
  'Link Clicks': ['link_click'],
};

const PURCHASE_ACTIONS = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Meta returns actions as an array of {action_type, value}. Take the first
// listed type that's present rather than summing, since the fallbacks are
// alternative spellings of the same event, not additional ones.
function actionValue(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const type of types) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit) return num(hit.value);
  }
  return 0;
}

function customConversionValue(actions) {
  if (!Array.isArray(actions)) return 0;
  return actions
    .filter((a) => String(a.action_type || '').startsWith('offsite_conversion.custom.'))
    .reduce((sum, a) => sum + num(a.value), 0);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

async function loadAccount(accountId, since, until) {
  const timeRange = JSON.stringify({ since, until });
  const account = await getAccountMeta(accountId);

  // Campaign records carry status and start date; insights carry the numbers.
  // They're separate edges, so both are fetched and joined on campaign id.
  const [campaigns, insights, monthly, adsets] = await Promise.all([
    graphGetAll(`/${accountId}/campaigns`, {
      fields: 'id,name,objective,status,effective_status,start_time,stop_time,daily_budget,lifetime_budget',
    }).catch((err) => {
      console.error(`campaigns failed for ${accountId}: ${err.message}`);
      return [];
    }),
    graphGetAll(`/${accountId}/insights`, {
      level: 'campaign',
      time_range: timeRange,
      fields: 'campaign_id,campaign_name,objective,spend,impressions,reach,actions,clicks,inline_link_clicks',
    }).catch((err) => {
      console.error(`insights failed for ${accountId}: ${err.message}`);
      return [];
    }),
    // Month-by-month, so "first month / last month / months live" are the real
    // delivery months rather than a guess off the campaign's start date.
    graphGetAll(`/${accountId}/insights`, {
      level: 'campaign',
      time_range: timeRange,
      time_increment: 'monthly',
      fields: 'campaign_id,campaign_name,objective,spend,impressions,actions,inline_link_clicks,date_start',
    }).catch(() => []),
    // Campaign Budget Optimization is off on these accounts, so the campaign's
    // own budget field comes back empty and the real numbers sit on the ad sets.
    graphGetAll(`/${accountId}/adsets`, {
      fields: 'id,campaign_id,name,daily_budget,lifetime_budget,effective_status',
    }).catch((err) => {
      console.error(`adsets failed for ${accountId}: ${err.message}`);
      return [];
    }),
  ]);

  return { accountId, account, campaigns, insights, monthly, adsets };
}

// ---- Lead quality per running campaign (Muatasam, 8 Oct 2026: link high
// potential leads to campaigns, beside cost per result, to see which running
// campaigns perform best). Meta can't tell which lead came from which ad, so
// the link is by PROJECT: a campaign named EB-ZNZ-EX-... is matched to the
// ZNZ|EX leads in Marina's sheet, counted from the campaign's start to today.
// That includes the project's leads from any source, not only this ad, and
// two running campaigns on one project share the same leads (flagged).
// Running campaigns only: older ones fall in the late Jul - Sep stretch the
// sheet has no daily entries for, so their figures would be short.
//
// Status (rules agreed with Anton, 8 Oct 2026; 10% and "the average" stand in
// until Muatasam sets a cost per high potential lead target):
//   Watch  fewer than LQ_MIN_LEADS (5) leads: too early to judge
//   Bad    no high potential leads, or a high potential rate under 10%
//   Good   cost per high potential lead at or below the running average
//   Watch  otherwise (has high potential leads, but costs more than average)
const LQ_MIN_LEADS = Number(process.env.LQ_MIN_LEADS || 5);
const LQ_MIN_HP_RATE = Number(process.env.LQ_MIN_HP_RATE || 0.1);

const LEAD_DEST_ALIAS = { SALALAH: 'SAL', KENYA: 'KN', 'SRI LANKA': 'SL' };
function leadCodeParts(code) {
  const [d, g] = String(code || '').split('|');
  const dest = (LEAD_DEST_ALIAS[d] || d || '').trim();
  return { dest, prog: g ? g.trim().split(' ')[0] : null };
}

async function addLeadQuality(campaigns) {
  const running = campaigns.filter((c) => c.status === 'Active');
  // Leads per day and project: ManyChat's automatic count from the day it
  // started (21 Oct 2026), Marina's sheet for every day before (Anton, 25 Oct
  // 2026). ManyChat ties a lead to a project through its Trip tag, so an
  // untagged lead (NA) can't be credited to any campaign. Either source can
  // fail on its own; the other still counts.
  let days = null;
  let error = null;
  const [sheetRes, mcRes] = await Promise.all([
    fetchWorkbook(leadsTab.envVar).then((wb) => ({ v: leadsTab.build(wb) }), (e) => ({ e: e.message })),
    manychat.load().then((v) => ({ v }), (e) => ({ e: e.message })),
  ]);
  const mc = mcRes.v && mcRes.v.first && Array.isArray(mcRes.v.days) ? mcRes.v : null;
  const mcFirst = mc ? mc.first : null;
  if (sheetRes.v || mc) {
    days = [];
    if (sheetRes.v) {
      for (const w of sheetRes.v.weeks || []) for (const d of w.days || []) {
        if (d.recorded && !d.future && (!mcFirst || d.date < mcFirst)) days.push(d);
      }
    }
    if (mc) {
      for (const d of mc.days) {
        days.push({ date: d.date, projects: Object.entries(d.projects || {}).map(([code, x]) => ({ code, total: x.leads || 0, hp: x.hp || 0 })) });
      }
    }
  }
  error = [sheetRes.e && `Leads sheet: ${sheetRes.e}`, mcRes.e && `ManyChat: ${mcRes.e}`].filter(Boolean).join(' · ') || null;
  const today = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);

  for (const c of running) {
    const { pd, pg } = leadProject({ title: c.name });
    if (!pd || !days) {
      c.leadQuality = { linked: false, reason: !days ? 'Leads unavailable' : 'No project in the campaign name' };
      continue;
    }
    const since = c.startDate ? new Date(Date.parse(c.startDate) + 4 * 3600 * 1000).toISOString().slice(0, 10) : today;
    let total = 0;
    let hp = 0;
    let hpKnown = false;
    for (const d of days) {
      if (d.date < since || d.date > today) continue;
      for (const p of d.projects || []) {
        const { dest, prog } = leadCodeParts(p.code);
        // "SL" / "KN" carry no programme in Marina's codes: destination alone.
        if (dest !== pd || (prog && pg && prog !== pg)) continue;
        total += p.total || 0;
        if (p.hp != null) { hp += p.hp; hpKnown = true; }
      }
    }
    c.leadQuality = {
      linked: true,
      project: pg ? `${pd}|${pg}` : pd,
      since,
      leads: total,
      hp: hpKnown ? hp : null,
      hpRate: hpKnown && total ? hp / total : null,
      costPerHp: hpKnown && hp ? c.spend / hp : null,
    };
  }

  // Two running campaigns on one project read the same leads.
  const byProject = new Map();
  for (const c of running) if (c.leadQuality.linked) {
    byProject.set(c.leadQuality.project, [...(byProject.get(c.leadQuality.project) || []), c.name]);
  }
  for (const c of running) if (c.leadQuality.linked) {
    c.leadQuality.sharedWith = byProject.get(c.leadQuality.project).filter((n) => n !== c.name);
  }

  const withHp = running.filter((c) => c.leadQuality.costPerHp != null);
  const avgCostPerHp = withHp.length ? withHp.reduce((s, c) => s + c.leadQuality.costPerHp, 0) / withHp.length : null;
  for (const c of running) {
    const q = c.leadQuality;
    if (!q.linked) { q.status = null; continue; }
    if (q.leads < LQ_MIN_LEADS) { q.status = 'Watch'; q.why = `Too early to judge: ${q.leads} lead${q.leads === 1 ? '' : 's'} so far`; }
    else if (q.hp == null) { q.status = null; q.why = 'No high potential recorded for these days'; }
    else if (q.hp === 0) { q.status = 'Bad'; q.why = `No high potential from ${q.leads} leads`; }
    else if (q.hpRate < LQ_MIN_HP_RATE) { q.status = 'Bad'; q.why = `High potential rate under ${Math.round(LQ_MIN_HP_RATE * 100)}%`; }
    else if (q.costPerHp <= avgCostPerHp) { q.status = 'Good'; q.why = 'Cost per high potential lead at or below the running average'; }
    else { q.status = 'Watch'; q.why = 'Cost per high potential lead above the running average'; }
  }
  return { avgCostPerHp, minLeads: LQ_MIN_LEADS, minHpRate: LQ_MIN_HP_RATE, error, manychatFrom: mcFirst };
}

async function build() {
  const since = `${YEAR}-01-01`;
  const until = `${YEAR}-12-31`;

  const loaded = await mapWithConcurrency(AD_ACCOUNTS, 2, (id) => loadAccount(id, since, until));

  // Months with actual spend, per campaign, across every account — and the
  // same rows rolled up per month for the spend-over-time chart.
  const monthsByCampaign = new Map();
  const monthTotals = new Map();
  for (const { monthly, account } of loaded) {
    for (const row of monthly) {
      const spend = toReportCurrency(row.spend, account.currency);
      if (spend <= 0) continue;
      const key = row.campaign_id;
      if (!monthsByCampaign.has(key)) monthsByCampaign.set(key, new Set());
      monthsByCampaign.get(key).add(row.date_start);

      const mk = String(row.date_start || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(mk)) continue;
      if (!monthTotals.has(mk)) monthTotals.set(mk, { month: mk, spend: 0, impressions: 0 });
      const m = monthTotals.get(mk);
      m.spend += spend;
      m.impressions += num(row.impressions);
    }
  }
  const months = [...monthTotals.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, label: MONTHS[Number(m.month.slice(5, 7)) - 1] }));

  // Only ad sets that are actually live carry a budget worth reporting — a
  // paused ad set still has a daily_budget on it, but it isn't spending, so
  // counting it would overstate the campaign's real daily commitment.
  const budgetByCampaign = new Map();
  for (const { account, adsets } of loaded) {
    for (const set of adsets || []) {
      if (set.effective_status !== 'ACTIVE') continue;
      const key = set.campaign_id;
      if (!budgetByCampaign.has(key)) budgetByCampaign.set(key, { daily: 0, lifetime: 0, adsets: 0 });
      const b = budgetByCampaign.get(key);
      b.daily += budgetToReportCurrency(set.daily_budget, account);
      b.lifetime += budgetToReportCurrency(set.lifetime_budget, account);
      b.adsets += 1;
    }
  }

  const campaigns = [];
  for (const { accountId, account, campaigns: meta, insights } of loaded) {
    const byId = new Map(meta.map((c) => [c.id, c]));

    for (const row of insights) {
      const spend = toReportCurrency(row.spend, account.currency);
      const impressions = num(row.impressions);
      const reach = num(row.reach);
      const clicks = num(row.clicks);
      // For click-to-Messenger/WhatsApp ads the click that matters registers as
      // a link click, so link CTR is the honest read of creative pull — plain
      // CTR counts reactions and profile taps too.
      const linkClicks = num(row.inline_link_clicks);

      // A campaign that never delivered in this window isn't part of the year's
      // reporting — it would only pad the table with zero rows.
      if (spend === 0 && impressions === 0) continue;

      const record = byId.get(row.campaign_id) || {};
      const objective = record.objective || row.objective || '';
      const label = OBJECTIVE_LABEL[objective] || 'Custom Conversion';

      const resultTypes = RESULT_ACTIONS[label];
      let results;
      if (label === 'Reach') results = reach;
      else if (resultTypes) results = actionValue(row.actions, resultTypes);
      else results = customConversionValue(row.actions);

      const monthKeys = [...(monthsByCampaign.get(row.campaign_id) || [])].sort();

      // With CBO on, the campaign owns the budget; with it off, the ad sets do.
      // Prefer whichever one actually carries a figure.
      const cboDaily = budgetToReportCurrency(record.daily_budget, account);
      const cboLifetime = budgetToReportCurrency(record.lifetime_budget, account);
      const fromSets = budgetByCampaign.get(row.campaign_id) || { daily: 0, lifetime: 0, adsets: 0 };
      const dailyBudget = cboDaily || fromSets.daily || null;
      const lifetimeBudget = cboLifetime || fromSets.lifetime || null;

      campaigns.push({
        id: row.campaign_id,
        account: accountId,
        name: row.campaign_name || record.name || '(unnamed)',
        objective: label,
        rawObjective: objective,
        // Ads Manager's effective status is what the team sees in the UI, so
        // it wins over the campaign's own configured status.
        status: (record.effective_status || record.status) === 'ACTIVE' ? 'Active' : 'Inactive',
        startDate: record.start_time || null,
        firstMonth: monthKeys.length ? monthLabel(monthKeys[0]) : null,
        lastMonth: monthKeys.length ? monthLabel(monthKeys[monthKeys.length - 1]) : null,
        monthsLive: monthKeys.length,
        dailyBudget,
        lifetimeBudget,
        budgetSource: cboDaily || cboLifetime ? 'campaign' : (fromSets.adsets ? 'adsets' : null),
        activeAdSets: fromSets.adsets,
        spend,
        results,
        impressions,
        reach,
        clicks,
        linkClicks,
        purchases: actionValue(row.actions, PURCHASE_ACTIONS),
        // Money went out but nothing came back. Almost always a gap in
        // RESULT_ACTIONS rather than a genuinely fruitless campaign, so it's
        // surfaced on the board instead of quietly reading as a zero.
        noResults: spend > 0 && results === 0,
      });
    }
  }

  // Highest spend first — the same order the spreadsheet is sorted in.
  campaigns.sort((a, b) => b.spend - a.spend);

  const sum = (key) => campaigns.reduce((total, c) => total + (c[key] || 0), 0);
  const totalSpend = sum('spend');
  const active = campaigns.filter((c) => c.status === 'Active');

  const totals = {
    campaigns: campaigns.length,
    active: active.length,
    spend: totalSpend,
    // What the account is committed to spending per day right now, across
    // live ad sets only — the closest thing to a budget these accounts have,
    // since nothing here runs on a lifetime cap.
    dailyBudget: active.reduce((total, c) => total + (c.dailyBudget || 0), 0) || null,
    results: sum('results'),
    impressions: sum('impressions'),
    reach: sum('reach'),
    clicks: sum('clicks'),
    linkClicks: sum('linkClicks'),
    purchases: sum('purchases'),
  };

  // Named so the board can say which campaigns are affected, not just how many.
  const noResultCampaigns = campaigns.filter((c) => c.noResults).map((c) => c.name);

  /* ---------------- budget per campaign ----------------
     Budgets come from the Budget Plan set on the dashboard (lib/budget-plan.js,
     Anton, 29 Oct 2026), which replaced the media plan (Updated Budget.xlsx)
     and its assumed $500 default. A campaign in the plan is measured on its
     spend inside its planned dates against the planned amount; a campaign not
     in the plan has no budget (shown as a dash), and its spend still counts
     against the plan period it falls in. */
  // Every campaign Meta has switched on, delivered or not, for the plan's
  // "running in Meta" picker and to tie typed names to campaigns.
  const liveCampaigns = [];
  for (const { accountId, campaigns: meta } of loaded) {
    for (const c of meta || []) {
      if ((c.effective_status || c.status) === 'ACTIVE') liveCampaigns.push({ id: c.id, name: c.name, account: accountId, status: 'Active' });
    }
  }
  const known = [...campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })), ...liveCampaigns.filter((l) => !campaigns.some((c) => c.id === l.id))];
  const plan = await budgetPlan.load();
  const planEval = await budgetPlan.evaluate(plan, known);

  for (const c of campaigns) {
    const b = planEval.byCampaign[c.id];
    c.inPlan = !!b;
    c.budgetSar = b ? b.budget : null;
    c.budgetSource = b ? 'plan' : null;
    c.planSpend = b ? b.spent : null;
    c.remaining = b ? b.remaining : null;
    c.usedPct = b ? b.usedPct : null;
    c.planPace = b ? b.pace : null;
    c.planFrom = b ? b.start : null;
    c.planTo = b ? b.end : null;
    c.planToday = b ? b.todayBudget : null;
    c.costPerResult = c.results ? c.spend / c.results : null;
    c.cprOver = c.status === 'Active' && c.results >= CPR_MIN_RESULTS && c.costPerResult > CPR_LIMIT;
  }

  // The year's own spend stays in totals.spend; the budget figures are the
  // plan's: its periods' money against all Meta spend on those days.
  const pt = planEval.totals;
  totals.budget = pt.budget;
  totals.planSpend = pt.spent;
  totals.remaining = pt.remaining;
  totals.usedPct = pt.usedPct;
  totals.planFrom = pt.from;
  totals.planTo = pt.to;
  totals.planTimeGone = pt.timeGone;
  totals.costPerResult = totals.results ? totals.spend / totals.results : null;
  totals.inPlan = campaigns.filter((c) => c.inPlan).length;

  const leadQuality = await addLeadQuality(campaigns);


  return {
    asOf: new Date().toISOString(),
    year: YEAR,
    since,
    until,
    accounts: AD_ACCOUNTS,
    // Each account bills in its own currency; everything above is already
    // converted, so the whole payload reads in one comparable unit.
    currency: REPORT_CURRENCY,
    totals,
    budgetSource: 'Budget Plan',
    usdSar: USD_SAR,
    budgetPlan: { plan, ...planEval },
    liveCampaigns,
    cprLimit: { report: CPR_LIMIT, minResults: CPR_MIN_RESULTS },
    leadQuality,
    campaigns,
  };
}

module.exports = async (req, res) => {
  try {
    const fresh = req.query && req.query.refresh === '1';
    if (!fresh && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cache.payload);
    }
    const payload = await build();
    cache = { at: Date.now(), payload };
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    // Same rule as the booking board: stale numbers beat a blank wall display.
    if (cache.payload) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ ...cache.payload, stale: true, error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
};

module.exports.build = build;

// The same "Results" reading for any insights row, so the daily campaign
// audit (lib/campaign-audit.js) counts a week's results exactly as the board
// counts the year's.
module.exports.resultsOf = (row, label) => {
  if (label === 'Reach') return num(row.reach);
  const types = RESULT_ACTIONS[label];
  return types ? actionValue(row.actions, types) : customConversionValue(row.actions);
};
module.exports.CPR_LIMIT = CPR_LIMIT;
module.exports.CPR_MIN_RESULTS = CPR_MIN_RESULTS;
