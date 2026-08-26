const {
  graphGetAll, getAccountMeta, toReportCurrency, AD_ACCOUNTS, REPORT_CURRENCY,
} = require('./meta-ads');
const { mapWithConcurrency } = require('./wetravel');

const CACHE_TTL_MS = Number(process.env.META_HISTORY_CACHE_TTL_MS || 1800000);

// Meta keeps ad insights for roughly 37 months and purges everything older —
// which is exactly why the archive spreadsheet marks pre-Jul-2023 rows
// "figures purged by Meta". Asking for more just errors, so the window is
// derived from that limit rather than reaching back to the first campaign.
const RETENTION_MONTHS = Number(process.env.META_RETENTION_MONTHS || 37);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

const RESULT_ACTIONS = {
  Messages: ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.messaging_first_reply'],
  Purchases: ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'],
  Leads: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'],
  'Link Clicks': ['link_click'],
};
const PURCHASE_ACTIONS = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];

let cache = { at: 0, payload: null };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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

function resultsFor(label, actions, reach) {
  if (label === 'Reach') return reach;
  const types = RESULT_ACTIONS[label];
  return types ? actionValue(actions, types) : customConversionValue(actions);
}

// The earliest month Meta will still answer for, floored to the 1st.
function windowStart() {
  const override = (process.env.META_HISTORY_SINCE || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (RETENTION_MONTHS - 1), 1));
  return d.toISOString().slice(0, 10);
}

// One request per account per year. A single 3-year monthly pull at campaign
// level is a lot of rows for one call to survive; per-year keeps each response
// small and means one bad year can't take the whole archive down with it.
async function fetchYear(accountId, year, since, until) {
  const from = year === Number(since.slice(0, 4)) ? since : `${year}-01-01`;
  const to = year === Number(until.slice(0, 4)) ? until : `${year}-12-31`;
  try {
    return await graphGetAll(`/${accountId}/insights`, {
      level: 'campaign',
      time_range: JSON.stringify({ since: from, until: to }),
      time_increment: 'monthly',
      fields: 'campaign_id,campaign_name,objective,spend,impressions,reach,actions,date_start',
    });
  } catch (err) {
    console.error(`history ${accountId} ${year} failed: ${err.message}`);
    return [];
  }
}

async function build() {
  const since = windowStart();
  const until = new Date().toISOString().slice(0, 10);
  const firstYear = Number(since.slice(0, 4));
  const lastYear = Number(until.slice(0, 4));

  const jobs = [];
  for (const accountId of AD_ACCOUNTS) {
    for (let year = firstYear; year <= lastYear; year++) jobs.push({ accountId, year });
  }

  const accountMeta = new Map();
  await Promise.all(AD_ACCOUNTS.map(async (id) => accountMeta.set(id, await getAccountMeta(id))));

  const batches = await mapWithConcurrency(jobs, 3, (job) =>
    fetchYear(job.accountId, job.year, since, until).then((rows) => ({ ...job, rows })));

  // month key -> totals, and campaign+year -> one archive row, built together
  // so a single pass over the data feeds both the timeline and the table.
  const months = new Map();
  const entries = new Map();

  for (const { accountId, rows } of batches) {
    const account = accountMeta.get(accountId) || { name: accountId, currency: REPORT_CURRENCY };

    for (const row of rows) {
      const spend = toReportCurrency(row.spend, account.currency);
      const impressions = num(row.impressions);
      const reach = num(row.reach);
      if (spend === 0 && impressions === 0) continue;

      const monthKey = String(row.date_start || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(monthKey)) continue;
      const year = Number(monthKey.slice(0, 4));

      const label = OBJECTIVE_LABEL[row.objective] || 'Custom Conversion';
      const results = resultsFor(label, row.actions, reach);
      const purchases = actionValue(row.actions, PURCHASE_ACTIONS);

      if (!months.has(monthKey)) {
        months.set(monthKey, {
          month: monthKey, year,
          label: `${MONTHS[Number(monthKey.slice(5, 7)) - 1]} ${year}`,
          spend: 0, results: 0, impressions: 0, reach: 0, purchases: 0, campaigns: new Set(),
        });
      }
      const m = months.get(monthKey);
      m.spend += spend; m.results += results; m.impressions += impressions;
      m.reach += reach; m.purchases += purchases; m.campaigns.add(row.campaign_id);

      // The spreadsheet's unit is one row per campaign per year — same here, so
      // a campaign that ran across two years shows up once under each.
      const key = `${row.campaign_id}:${year}`;
      if (!entries.has(key)) {
        entries.set(key, {
          id: row.campaign_id, year,
          name: row.campaign_name || '(unnamed)',
          objective: label,
          account: account.name,
          spend: 0, results: 0, impressions: 0, reach: 0, purchases: 0,
          monthKeys: new Set(),
        });
      }
      const e = entries.get(key);
      e.spend += spend; e.results += results; e.impressions += impressions;
      e.reach += reach; e.purchases += purchases; e.monthKeys.add(monthKey);
    }
  }

  const monthList = [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, campaigns: m.campaigns.size }));

  const campaigns = [...entries.values()]
    .map((e) => {
      const keys = [...e.monthKeys].sort();
      const pretty = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
      const { monthKeys, ...rest } = e;
      return {
        ...rest,
        firstMonth: keys.length ? pretty(keys[0]) : null,
        lastMonth: keys.length ? pretty(keys[keys.length - 1]) : null,
        monthsLive: keys.length,
      };
    })
    .sort((a, b) => b.year - a.year || b.spend - a.spend);

  const years = [];
  for (let year = lastYear; year >= firstYear; year--) {
    const rows = campaigns.filter((c) => c.year === year);
    const ms = monthList.filter((m) => m.year === year);
    if (!rows.length) continue;
    const sum = (list, key) => list.reduce((total, r) => total + (r[key] || 0), 0);
    years.push({
      year,
      campaigns: rows.length,
      spend: sum(rows, 'spend'),
      results: sum(rows, 'results'),
      impressions: sum(rows, 'impressions'),
      reach: sum(rows, 'reach'),
      purchases: sum(rows, 'purchases'),
      months: ms.length,
      // Partial only at the ends of the retention window — flagged so a short
      // first year doesn't read as a collapse in spend.
      partial: year === firstYear || year === lastYear,
    });
  }

  const sumAll = (key) => campaigns.reduce((total, c) => total + (c[key] || 0), 0);

  return {
    asOf: new Date().toISOString(),
    since,
    until,
    currency: REPORT_CURRENCY,
    retentionMonths: RETENTION_MONTHS,
    accounts: [...accountMeta.values()].map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    totals: {
      spend: sumAll('spend'),
      results: sumAll('results'),
      impressions: sumAll('impressions'),
      reach: sumAll('reach'),
      purchases: sumAll('purchases'),
      rows: campaigns.length,
      campaigns: new Set(campaigns.map((c) => c.id)).size,
    },
    years,
    months: monthList,
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
    if (cache.payload) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ ...cache.payload, stale: true, error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
};

module.exports.build = build;
