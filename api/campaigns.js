const {
  graphGetAll, getAccountMeta, toReportCurrency, budgetToReportCurrency,
  AD_ACCOUNTS, REPORT_CURRENCY, USD_SAR,
} = require('./meta-ads');
const { mapWithConcurrency } = require('./wetravel');
const { build: buildMediaPlan } = require('./media-plan');

const CACHE_TTL_MS = Number(process.env.META_CACHE_TTL_MS || 300000);

// How far back the weekly view looks. Twelve weeks is enough to see a trend
// turn without dragging a year of daily rows through the Graph API.
const WEEKLY_DAYS = Number(process.env.META_WEEKLY_DAYS || 84);

// A campaign spending less than this in a week isn't sending a signal, it's
// sending noise — one stray result swings its cost-per-result by 100%.
const MIN_SIGNAL_SPEND = Number(process.env.META_MIN_SIGNAL_SPEND || 50);

// The sheet this replaces is "2026 figures only". Year is overridable so the
// board rolls into 2027 without a code change.
const YEAR = Number(process.env.META_YEAR || new Date().getUTCFullYear());

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
  Leads: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'],
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

async function loadAccount(accountId, since, until, recentSince) {
  const timeRange = JSON.stringify({ since, until });
  const account = await getAccountMeta(accountId);

  // Campaign records carry status and start date; insights carry the numbers.
  // They're separate edges, so both are fetched and joined on campaign id.
  const [campaigns, insights, monthly, daily, adsets] = await Promise.all([
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
      // actions/inline_link_clicks/objective added so this one call can also
      // feed the per-month budget-vs-actual adjuster — otherwise it would
      // need a second Graph call to get results per calendar month.
      fields: 'campaign_id,campaign_name,objective,spend,impressions,actions,inline_link_clicks,date_start',
    }).catch(() => []),
    // Daily rows for the recent window, bucketed into weeks below. Daily
    // rather than time_increment:7 so the week boundary is ours to choose and
    // matches the Sunday start the booking report already uses.
    graphGetAll(`/${accountId}/insights`, {
      level: 'campaign',
      time_range: JSON.stringify({ since: recentSince, until }),
      time_increment: 1,
      fields: 'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,objective,date_start',
    }).catch((err) => {
      console.error(`daily insights failed for ${accountId}: ${err.message}`);
      return [];
    }),
    // Campaign Budget Optimization is off on these accounts, so the campaign's
    // own budget field comes back empty and the real numbers sit on the ad sets.
    graphGetAll(`/${accountId}/adsets`, {
      fields: 'id,campaign_id,name,daily_budget,lifetime_budget,effective_status',
    }).catch((err) => {
      console.error(`adsets failed for ${accountId}: ${err.message}`);
      return [];
    }),
  ]);

  return { accountId, account, campaigns, insights, monthly, daily, adsets };
}

// Weeks run Sunday to Saturday, the same boundary the booking report uses, so
// "this week" means one thing across the whole dashboard.
function weekStartOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

const WEEK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function weekLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${WEEK_MONTHS[d.getUTCMonth()]}`;
}

const blankBucket = () => ({ spend: 0, results: 0, impressions: 0, clicks: 0, linkClicks: 0 });

// Change expressed as a signed ratio. Null when there's no prior figure to
// compare against — an "infinite improvement" from zero is not information.
function change(now, before) {
  if (!Number.isFinite(before) || before === 0) return null;
  if (!Number.isFinite(now)) return null;
  return (now - before) / before;
}

async function build() {
  const since = `${YEAR}-01-01`;
  const until = `${YEAR}-12-31`;

  // The weekly window is its own range: it has to reach back past 1 January
  // in early in the year, or the first weeks of a new year would show nothing.
  const recentSince = new Date(Date.now() - WEEKLY_DAYS * 864e5).toISOString().slice(0, 10);
  const todayIso = new Date().toISOString().slice(0, 10);

  const loaded = await mapWithConcurrency(AD_ACCOUNTS, 2,
    (id) => loadAccount(id, since, until, recentSince));

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

  /* ---------------- weekly view ---------------- */

  // account-level series, and per-campaign per-week, from the same daily rows
  const weekTotals = new Map();
  const perCampaignWeek = new Map();
  const nameById = new Map(campaigns.map((c) => [c.id, c.name]));

  for (const { daily, account } of loaded) {
    for (const row of daily || []) {
      const wk = weekStartOf(row.date_start);
      if (!wk) continue;
      const spend = toReportCurrency(row.spend, account.currency);
      const impressions = num(row.impressions);
      if (spend === 0 && impressions === 0) continue;

      const label = OBJECTIVE_LABEL[row.objective] || 'Custom Conversion';
      const results = label === 'Reach'
        ? 0
        : (RESULT_ACTIONS[label]
          ? actionValue(row.actions, RESULT_ACTIONS[label])
          : customConversionValue(row.actions));

      if (!weekTotals.has(wk)) weekTotals.set(wk, { week: wk, label: weekLabel(wk), ...blankBucket() });
      const w = weekTotals.get(wk);
      w.spend += spend; w.results += results; w.impressions += impressions;
      w.clicks += num(row.clicks); w.linkClicks += num(row.inline_link_clicks);

      const key = `${row.campaign_id}|${wk}`;
      if (!perCampaignWeek.has(key)) {
        perCampaignWeek.set(key, { id: row.campaign_id, week: wk, ...blankBucket() });
      }
      const c = perCampaignWeek.get(key);
      c.spend += spend; c.results += results; c.impressions += impressions;
      c.clicks += num(row.clicks); c.linkClicks += num(row.inline_link_clicks);
    }
  }

  const weeks = [...weekTotals.values()].sort((a, b) => a.week.localeCompare(b.week));

  // The current week is still running, so it is always a partial figure —
  // flagged rather than left to look like a collapse in spend.
  const thisWeek = weekStartOf(todayIso);
  for (const w of weeks) w.partial = w.week === thisWeek;

  const lastComplete = [...weeks].reverse().find((w) => !w.partial) || null;
  const priorComplete = lastComplete
    ? [...weeks].reverse().find((w) => !w.partial && w.week < lastComplete.week) || null
    : null;

  // Per campaign: the last complete week against the one before it. Comparing
  // a half-finished week to a whole one would read as a crash every Monday.
  const weeklyCampaigns = [];
  if (lastComplete) {
    const ids = new Set([...perCampaignWeek.values()]
      .filter((r) => r.week === lastComplete.week || (priorComplete && r.week === priorComplete.week))
      .map((r) => r.id));

    for (const id of ids) {
      const cur = perCampaignWeek.get(`${id}|${lastComplete.week}`) || blankBucket();
      const prev = priorComplete
        ? perCampaignWeek.get(`${id}|${priorComplete.week}`) || blankBucket()
        : blankBucket();

      const cpr = cur.results ? cur.spend / cur.results : null;
      const prevCpr = prev.results ? prev.spend / prev.results : null;
      const ctr = cur.impressions ? cur.linkClicks / cur.impressions : null;
      const prevCtr = prev.impressions ? prev.linkClicks / prev.impressions : null;

      // Cost per result is the metric being judged, so a *rise* is bad and the
      // sign is flipped to read as "better/worse", not "up/down".
      const cprChange = change(cpr, prevCpr);
      const record = campaigns.find((c) => c.id === id);

      let signal = 'watch';
      const reasons = [];
      if (cur.spend < MIN_SIGNAL_SPEND && prev.spend < MIN_SIGNAL_SPEND) {
        signal = 'idle';
      } else if (cur.spend >= MIN_SIGNAL_SPEND && prev.spend < MIN_SIGNAL_SPEND) {
        signal = 'new';
        reasons.push('first full week of delivery');
      } else if (cur.spend < MIN_SIGNAL_SPEND) {
        // Was running, now isn't. Worth stating plainly — a campaign going
        // dark is either a decision someone made or an accident worth catching.
        signal = 'stopped';
        reasons.push(`no delivery this week (spent ${Math.round(prev.spend)} last week)`);
      } else {
        if (cur.spend > 0 && cur.results === 0) { signal = 'fix'; reasons.push('spend with no results'); }
        else if (cprChange != null && cprChange > 0.25) { signal = 'fix'; reasons.push(`cost per result up ${Math.round(cprChange * 100)}%`); }
        else if (ctr != null && ctr < 0.005) { signal = 'fix'; reasons.push('link CTR under 0.5%'); }
        else if (cprChange != null && cprChange < -0.15) { signal = 'scale'; reasons.push(`cost per result down ${Math.round(-cprChange * 100)}%`); }
        else if (cprChange != null && cprChange > 0.10) { reasons.push(`cost per result up ${Math.round(cprChange * 100)}%`); }
        if (prevCtr != null && ctr != null && ctr < prevCtr * 0.75 && signal !== 'fix') {
          reasons.push('link CTR falling');
        }
      }

      weeklyCampaigns.push({
        id,
        name: nameById.get(id) || (record && record.name) || id,
        objective: record ? record.objective : null,
        status: record ? record.status : null,
        current: { ...cur, costPerResult: cpr, ctr },
        previous: { ...prev, costPerResult: prevCpr, ctr: prevCtr },
        change: {
          spend: change(cur.spend, prev.spend),
          results: change(cur.results, prev.results),
          costPerResult: cprChange,
          ctr: change(ctr, prevCtr),
        },
        signal,
        reasons,
      });
    }
    // Worst first — the point of the panel is what needs attention.
    const ORDER = { fix: 0, stopped: 1, watch: 2, new: 3, scale: 4, idle: 5 };
    weeklyCampaigns.sort((a, b) =>
      ORDER[a.signal] - ORDER[b.signal] || b.current.spend - a.current.spend);
  }

  /* ---------------- reference targets ----------------
     What "good" means has to come from somewhere defensible. Cost per result
     is taken from NomuHub's own Saudi media plan — its blended estimate of
     ~$5.13 per message — rather than an invented number, so the line on the
     chart is the thing the team actually committed to. Weekly cost comes from
     the live daily budget. Link CTR is the published industry band. */
  let targets = { costPerResult: null, costPerResultNote: null, weeklyCost: null, linkCtr: 0.02 };
  try {
    const plan = buildMediaPlan();
    const planned = plan.totals.results
      ? (plan.totals.prospectingUsd / plan.totals.results) * plan.usdSar
      : null;
    if (planned) {
      targets.costPerResult = planned;
      targets.costPerResultNote =
        `SA media plan: $${(plan.totals.prospectingUsd / plan.totals.results).toFixed(2)} per message at ${plan.usdSar}`;
    }
  } catch (err) {
    console.error(`media plan target unavailable: ${err.message}`);
  }
  if (totals.dailyBudget) targets.weeklyCost = totals.dailyBudget * 7;

  /* ---------------- budget vs actual, per period ----------------
     Budgets on these accounts are daily amounts on ad sets, so the only
     honest window to compare them against is a bounded period: an allocation
     is the daily figure times the days in that period, compared with what
     was actually spent inside it. Pairing a period's allocation with a year
     of spend would be meaningless.

     Two kinds of period, built by the same function so they always agree on
     what a column means:
       - calendar months, from the year-long monthly insights call (already
         fetched for the YTD chart, extended with actions/link-clicks so one
         Graph call now serves both)
       - a rolling last-14-days window, from the same daily rows the weekly
         trend uses, for a default that isn't thin on the 1st of a month */
  const perResult = targets.costPerResult || null;

  function buildPeriod({ key, label, daysInPeriod, daysElapsed, totalsByCampaign }) {
    const rows = campaigns.map((c) => {
      const t = totalsByCampaign.get(c.id) || { spend: 0, results: 0, impressions: 0, linkClicks: 0 };
      // Only a live daily budget represents money still allocated. A paused
      // campaign has no allocation to compare against, so it reports none
      // rather than a zero that would read as "budget exhausted" — and past
      // periods necessarily use today's budget as a stand-in, since Meta
      // doesn't expose a history of daily-budget changes.
      const daily = c.status === 'Active' ? c.dailyBudget : null;
      const allocated = daily ? daily * daysInPeriod : null;
      const expectedToDate = daily ? daily * daysElapsed : null;
      const targetResults = allocated && perResult ? allocated / perResult : null;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        dailyBudget: daily,
        allocated,
        expectedToDate,
        spend: t.spend,
        results: t.results,
        impressions: t.impressions,
        linkClicks: t.linkClicks,
        remaining: allocated == null ? null : allocated - t.spend,
        usedPct: allocated ? t.spend / allocated : null,
        // Against pace, not against the whole period — a campaign seven days
        // into a thirty-day month is not "5% spent", it is on or off pace.
        pacePct: expectedToDate ? t.spend / expectedToDate : null,
        targetResults,
        performance: targetResults ? t.results / targetResults : null,
        costPerResult: t.results ? t.spend / t.results : null,
      };
    })
      // Anything with neither an allocation nor spend in this period isn't
      // part of its picture at all.
      .filter((r) => r.allocated != null || r.spend > 0)
      .sort((a, b) => (b.allocated || 0) - (a.allocated || 0) || b.spend - a.spend);

    const sum = (field) => rows.reduce((total, r) => total + (r[field] || 0), 0);
    return {
      key,
      label,
      daysInPeriod,
      daysElapsed,
      periodProgress: daysInPeriod ? daysElapsed / daysInPeriod : null,
      costPerResultTarget: perResult,
      allocated: sum('allocated') || null,
      expectedToDate: sum('expectedToDate') || null,
      spend: sum('spend'),
      results: sum('results'),
      targetResults: sum('targetResults') || null,
      campaigns: rows,
    };
  }

  const resultsFor = (label, actions) => (label === 'Reach'
    ? 0
    : (RESULT_ACTIONS[label] ? actionValue(actions, RESULT_ACTIONS[label]) : customConversionValue(actions)));

  // Last 14 days, from the daily rows already fetched for the weekly trend —
  // no extra Graph call. A rolling window has nothing "partial" about it, so
  // unlike a calendar month it's always fully elapsed.
  const last14Since = new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10);
  const last14ByCampaign = new Map();
  for (const { daily, account } of loaded) {
    for (const row of daily || []) {
      const day = String(row.date_start || '').slice(0, 10);
      if (day < last14Since || day > todayIso) continue;
      const spend = toReportCurrency(row.spend, account.currency);
      const label = OBJECTIVE_LABEL[row.objective] || 'Custom Conversion';
      if (!last14ByCampaign.has(row.campaign_id)) {
        last14ByCampaign.set(row.campaign_id, { spend: 0, results: 0, impressions: 0, linkClicks: 0 });
      }
      const m = last14ByCampaign.get(row.campaign_id);
      m.spend += spend;
      m.results += resultsFor(label, row.actions);
      m.impressions += num(row.impressions);
      m.linkClicks += num(row.inline_link_clicks);
    }
  }

  // Calendar months, from the year-long monthly insights call — covers
  // January through the current month, per campaign.
  const monthlyByCampaign = new Map(); // monthKey -> Map(campaignId -> totals)
  for (const { monthly, account } of loaded) {
    for (const row of monthly) {
      const mk = String(row.date_start || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(mk)) continue;
      const spend = toReportCurrency(row.spend, account.currency);
      const label = OBJECTIVE_LABEL[row.objective] || 'Custom Conversion';
      if (!monthlyByCampaign.has(mk)) monthlyByCampaign.set(mk, new Map());
      const byC = monthlyByCampaign.get(mk);
      if (!byC.has(row.campaign_id)) byC.set(row.campaign_id, { spend: 0, results: 0, impressions: 0, linkClicks: 0 });
      const m = byC.get(row.campaign_id);
      m.spend += spend;
      m.results += resultsFor(label, row.actions);
      m.impressions += num(row.impressions);
      m.linkClicks += num(row.inline_link_clicks);
    }
  }

  const todayMonthKey = todayIso.slice(0, 7);
  const monthPeriods = [...monthlyByCampaign.keys()].sort((a, b) => b.localeCompare(a)).map((mk) => {
    const y = Number(mk.slice(0, 4));
    const mIdx = Number(mk.slice(5, 7));
    const daysInPeriod = new Date(Date.UTC(y, mIdx, 0)).getUTCDate();
    const daysElapsed = mk === todayMonthKey ? Number(todayIso.slice(8, 10)) : daysInPeriod;
    const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    return buildPeriod({
      key: mk,
      label: `${MONTH_FULL[mIdx - 1]} ${y}`,
      daysInPeriod,
      daysElapsed,
      totalsByCampaign: monthlyByCampaign.get(mk),
    });
  });

  const last14Period = buildPeriod({
    key: 'last14',
    label: 'Last 14 days',
    daysInPeriod: 14,
    daysElapsed: 14,
    totalsByCampaign: last14ByCampaign,
  });

  // "Last 14 days" leads — a fresh calendar month is thin on data for days,
  // and this is the one view that's never thin. The month picker covers the
  // rest.
  const budgetPeriods = [last14Period, ...monthPeriods];
  const budget = last14Period;

  /* ---------------- plan vs actual ----------------
     The spreadsheet allocates a budget per trip flight, not per month, and
     its "Date" column is the trip's own window rather than the ad flight's —
     a December trip is advertised months earlier. So a plan line is compared
     against its campaign's whole spend to date, never sliced into a period;
     the period picker above stays with the daily-budget pacing view, which is
     the question it can actually answer.

     Matching leans on the campaign renaming: a plan line matches a campaign
     when every word of the plan's programme appears in the campaign's name,
     disambiguated by the month the campaign name carries when one programme
     runs more than once. Both sides report what didn't match rather than
     quietly dropping it. */
  const MONTH_WORDS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7,
    sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const words = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  // "Novemper" and "Decemper" are how the campaigns are actually spelled, so
  // the first three letters are what's matched on, not the full word.
  const monthOfName = (name) => {
    for (const w of words(name)) {
      const key = w.slice(0, 3);
      if (MONTH_WORDS[key] != null && w.length >= 3 && /^[a-z]+$/.test(w)) return MONTH_WORDS[key];
    }
    return null;
  };

  let planRows = [];
  let planUnmatchedCampaigns = [];
  try {
    const plan = buildMediaPlan();
    // Only campaigns that are live or have spent this year are candidates;
    // a plan line shouldn't bind to a long-dead 2026 campaign by name alone.
    const pool = campaigns.map((c) => ({
      c,
      tokens: new Set(words(c.name)),
      month: monthOfName(c.name),
      taken: false,
    }));

    planRows = plan.lines.map((l) => {
      const need = words(l.program);
      const named = pool.filter((x) => !x.taken && need.every((w) => x.tokens.has(w)));

      // The month in the campaign's own name is what binds it to a flight —
      // several flights share a programme, and the legacy 2026 campaigns
      // ("Bali Explore 10%", "Vietnam explore sales") carry no month at all,
      // so requiring one keeps a plan line from latching onto them. A
      // recurring line has no month to match, so it takes the month-less
      // campaign instead.
      const hit = l.recurring
        ? named.find((x) => x.month == null) || null
        : named.find((x) => x.month != null && x.month === l.startMonth) || null;
      if (hit) hit.taken = true;

      const spend = hit ? hit.c.spend : 0;
      const results = hit ? hit.c.results : 0;
      const plannedSar = l.budgetSar;
      return {
        program: l.program,
        dates: l.dates,
        objective: l.objective,
        cancelled: l.cancelled,
        plannedUsd: l.budgetUsd,
        plannedSar,
        plannedResults: l.resultCount,
        matched: !!hit,
        campaignId: hit ? hit.c.id : null,
        campaignName: hit ? hit.c.name : null,
        status: hit ? hit.c.status : null,
        spend,
        results,
        remaining: plannedSar - spend,
        usedPct: plannedSar ? spend / plannedSar : null,
        performance: l.resultCount ? results / l.resultCount : null,
        costPerResult: results ? spend / results : null,
      };
    });

    planUnmatchedCampaigns = pool
      .filter((x) => !x.taken && (x.c.status === 'Active' || x.c.spend > 0))
      .map((x) => ({ id: x.c.id, name: x.c.name, status: x.c.status, spend: x.c.spend, results: x.c.results }))
      .sort((a, b) => b.spend - a.spend);
  } catch (err) {
    console.error(`plan vs actual unavailable: ${err.message}`);
  }

  const livePlan = planRows.filter((r) => !r.cancelled);
  const pSum = (key) => livePlan.reduce((total, r) => total + (r[key] || 0), 0);
  const planVsActual = {
    source: 'Updated Budget.xlsx',
    currency: REPORT_CURRENCY,
    usdSar: USD_SAR,
    rows: planRows,
    unmatchedCampaigns: planUnmatchedCampaigns,
    totals: {
      lines: livePlan.length,
      cancelled: planRows.length - livePlan.length,
      matched: livePlan.filter((r) => r.matched).length,
      plannedSar: pSum('plannedSar'),
      plannedResults: pSum('plannedResults'),
      spend: pSum('spend'),
      results: pSum('results'),
    },
  };

  const weekly = {
    days: WEEKLY_DAYS,
    targets,
    weeks,
    currentWeek: thisWeek,
    lastCompleteWeek: lastComplete ? lastComplete.week : null,
    priorCompleteWeek: priorComplete ? priorComplete.week : null,
    campaigns: weeklyCampaigns,
  };

  // Grouped exactly like the sheet's "Performance by Campaign Objective" block.
  const byObjective = [];
  for (const label of ['Messages', 'Purchases', 'Leads', 'Link Clicks', 'Reach', 'Custom Conversion']) {
    const group = campaigns.filter((c) => c.objective === label);
    if (!group.length) continue;
    const gSum = (key) => group.reduce((total, c) => total + (c[key] || 0), 0);
    byObjective.push({
      objective: label,
      campaigns: group.length,
      dailyBudget: group.filter((c) => c.status === 'Active')
        .reduce((total, c) => total + (c.dailyBudget || 0), 0) || null,
      spend: gSum('spend'),
      impressions: gSum('impressions'),
      reach: gSum('reach'),
      clicks: gSum('clicks'),
      linkClicks: gSum('linkClicks'),
      purchases: gSum('purchases'),
      results: gSum('results'),
    });
  }

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
    months,
    budget,
    budgetPeriods,
    planVsActual,
    weekly,
    byObjective,
    campaigns,
    noResultCampaigns,
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
