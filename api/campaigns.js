const {
  graphGetAll, getAccountMeta, toReportCurrency, budgetToReportCurrency,
  AD_ACCOUNTS, REPORT_CURRENCY, USD_SAR,
} = require('./meta-ads');
const { mapWithConcurrency } = require('./wetravel');
const { build: buildMediaPlan } = require('./media-plan');

const CACHE_TTL_MS = Number(process.env.META_CACHE_TTL_MS || 300000);

// The sheet this replaces is "2026 figures only". Year is overridable so the
// board rolls into 2027 without a code change.
const YEAR = Number(process.env.META_YEAR || new Date().getUTCFullYear());

// What a campaign is measured against when it can't be tied to a line in
// Updated Budget.xlsx. Muatasam's rule: assume $500 rather than show a dash.
const DEFAULT_BUDGET_USD = Number(process.env.META_DEFAULT_BUDGET_USD || 500);

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
     Every campaign carries its own budget, so the board can show spend
     against budget on each line rather than a share of the total. Budgets
     come from Updated Budget.xlsx where the campaign can be tied to a plan
     line, and from a flat default where it can't — no row is ever left
     without something to measure against.

     Campaigns are named two different ways: the current code form
     ("ZNZ-BL-202609-02C") and the older long form ("ZNZ Build MSG - 2026",
     "Thailan Wellness MSG - 2026", typo included). Both resolve to the same
     destination + programme pair, which is the level the plan budgets at.
     Deliberately NOT matched on month: the plan's dates are the trip's own
     window while a campaign's are the ad flight's, and a December trip is
     advertised months earlier — matching those two was what put the wrong
     budget on the wrong campaign before. Every programme that runs twice
     carries the same budget in the sheet, so the pair alone is enough. */
  const DESTINATIONS = [
    ['ZNZ', ['znz', 'zanzibar']],
    ['BA', ['ba', 'bali']],
    ['VN', ['vn', 'vietnam']],
    ['TH', ['th', 'thailand', 'thailan']],
    ['KR', ['kr', 'korea']],
  ];
  const PROGRAMMES = [
    ['BL', ['bl', 'build', 'building']],
    ['EX', ['ex', 'explore']],
    ['WL', ['wl', 'wellness']],
    ['TA', ['ta', 'teach', 'teaching']],
    ['ME', ['me', 'medical']],
  ];

  const words = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const codeFrom = (table, tokens) => {
    for (const [code, spellings] of table) {
      if (tokens.some((w) => spellings.includes(w))) return code;
    }
    return null;
  };

  // "ZNZ-BL-202609-02C" and "ZNZ Build MSG - 2026" both come back "ZNZ-BL".
  const projectKey = (name) => {
    const tokens = words(name);
    const dest = codeFrom(DESTINATIONS, tokens);
    const prog = codeFrom(PROGRAMMES, tokens);
    return dest && prog ? `${dest}-${prog}` : null;
  };

  let plan = null;
  try {
    plan = buildMediaPlan();
  } catch (err) {
    console.error(`media plan unavailable, every budget falls back to the default: ${err.message}`);
  }

  // project key -> planned USD, and the always-on website lines which have no
  // destination at all and so are matched on their words instead.
  const planByProject = new Map();
  const planByWords = [];
  for (const line of (plan && plan.lines) || []) {
    if (line.cancelled) continue;
    const key = projectKey(line.program);
    if (key) {
      if (!planByProject.has(key)) planByProject.set(key, { usd: line.budgetUsd, program: line.program });
    } else {
      planByWords.push({ need: words(line.program), usd: line.budgetUsd, program: line.program });
    }
  }

  const planFor = (name) => {
    const key = projectKey(name);
    if (key && planByProject.has(key)) return planByProject.get(key);
    const tokens = new Set(words(name));
    const hit = planByWords.find((l) => l.need.every((w) => tokens.has(w)));
    return hit || null;
  };

  for (const c of campaigns) {
    const hit = planFor(c.name);
    c.budgetUsd = hit ? hit.usd : DEFAULT_BUDGET_USD;
    c.budgetSar = c.budgetUsd * USD_SAR;
    c.budgetSource = hit ? 'plan' : 'default';
    c.planProgram = hit ? hit.program : null;
    c.remaining = c.budgetSar - c.spend;
    c.usedPct = c.budgetSar ? c.spend / c.budgetSar : null;
    c.costPerResult = c.results ? c.spend / c.results : null;
  }

  // The table foots to these, so they're summed from the same rows rather
  // than taken from the plan's own total — the two can't drift apart.
  totals.budget = campaigns.reduce((total, c) => total + c.budgetSar, 0);
  totals.remaining = totals.budget - totals.spend;
  totals.usedPct = totals.budget ? totals.spend / totals.budget : null;
  totals.costPerResult = totals.results ? totals.spend / totals.results : null;
  totals.onPlan = campaigns.filter((c) => c.budgetSource === 'plan').length;

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
    budgetSource: 'Updated Budget.xlsx',
    defaultBudgetUsd: DEFAULT_BUDGET_USD,
    usdSar: USD_SAR,
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
