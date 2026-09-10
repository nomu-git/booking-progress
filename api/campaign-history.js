// One calendar year of Meta ad history, Jan through Dec.
//
// This used to be a rolling ~37-month window with every year stacked on one
// page, which read as a wall of numbers. Muatasam asked for the full 2026
// year instead, so the unit here is a single year: pick it, see all twelve
// months of it, see the campaigns that ran in it. Older years are still
// reachable through the picker, they're just not all on screen at once.

const {
  graphGetAll, getAccountMeta, toReportCurrency, AD_ACCOUNTS, REPORT_CURRENCY,
} = require('./meta-ads');
const { mapWithConcurrency } = require('./wetravel');

const CACHE_TTL_MS = Number(process.env.META_HISTORY_CACHE_TTL_MS || 1800000);

// Meta keeps ad insights for roughly 37 months and purges everything older,
// so that's how far back the year picker can honestly offer.
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

// year -> payload. Each year is a separate upstream pull, so they cache apart.
const cache = new Map();

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Meta campaign names are typed by hand and carry stray double spaces and
// trailing separators. Nothing here invents or rewrites a name — the words
// stay exactly as they are in Ads Manager, so the board and Meta always
// agree; only the whitespace is tidied.
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s*[-–|]\s*$/, '').trim() || '(unnamed)';

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

// The earliest day Meta will still answer for. Asking past it doesn't return
// an empty result, it errors — so every request has to be clamped to it.
function retentionFloor() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (RETENTION_MONTHS - 1), 1))
    .toISOString().slice(0, 10);
}

// The years Meta will still answer for, newest first.
function availableYears() {
  const oldest = Number(retentionFloor().slice(0, 4));
  const years = [];
  for (let y = new Date().getUTCFullYear(); y >= oldest; y--) years.push(y);
  return years;
}

async function fetchYear(accountId, since, until) {
  try {
    return await graphGetAll(`/${accountId}/insights`, {
      level: 'campaign',
      time_range: JSON.stringify({ since, until }),
      time_increment: 'monthly',
      fields: 'campaign_id,campaign_name,objective,spend,impressions,reach,actions,date_start',
    });
  } catch (err) {
    console.error(`history ${accountId} ${since}..${until} failed: ${err.message}`);
    return [];
  }
}

async function build(year) {
  const today = new Date().toISOString().slice(0, 10);
  const floor = retentionFloor();
  // The oldest year in the picker starts mid-year, because Meta has purged
  // the months before that. Those months aren't "no spend" — they're gone at
  // the source, and the view has to say so rather than draw them as empty.
  const yearStart = `${year}-01-01`;
  const since = yearStart < floor ? floor : yearStart;
  const purgedBefore = since > yearStart ? since : null;
  // Meta also rejects a range that runs past today, so the request stops at
  // today even though the view still shows all twelve months of the year.
  const until = `${year}-12-31` > today ? today : `${year}-12-31`;

  const accountMeta = new Map();
  await Promise.all(AD_ACCOUNTS.map(async (id) => accountMeta.set(id, await getAccountMeta(id))));

  const batches = await mapWithConcurrency(AD_ACCOUNTS, 3, (accountId) =>
    fetchYear(accountId, since, until).then((rows) => ({ accountId, rows })));

  // Every month of the year exists up front, spend or not — an empty November
  // is a fact about the year, not a gap to hide.
  const months = new Map();
  for (let i = 0; i < 12; i++) {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    months.set(key, { month: key, label: MONTHS[i], spend: 0, results: 0, campaigns: new Set() });
  }

  const entries = new Map();

  for (const { accountId, rows } of batches) {
    const account = accountMeta.get(accountId) || { name: accountId, currency: REPORT_CURRENCY };

    for (const row of rows) {
      const spend = toReportCurrency(row.spend, account.currency);
      const impressions = num(row.impressions);
      const reach = num(row.reach);
      if (spend === 0 && impressions === 0) continue;

      const monthKey = String(row.date_start || '').slice(0, 7);
      if (!months.has(monthKey)) continue;

      const label = OBJECTIVE_LABEL[row.objective] || 'Custom Conversion';
      const results = resultsFor(label, row.actions, reach);

      const m = months.get(monthKey);
      m.spend += spend;
      m.results += results;
      m.campaigns.add(row.campaign_id);

      // One row per campaign for the whole year, so a campaign that ran in
      // three separate months is still one line in the table.
      if (!entries.has(row.campaign_id)) {
        entries.set(row.campaign_id, {
          id: row.campaign_id,
          name: cleanName(row.campaign_name),
          objective: label,
          account: account.name,
          spend: 0, results: 0, impressions: 0, reach: 0,
          monthKeys: new Set(),
        });
      }
      const e = entries.get(row.campaign_id);
      e.spend += spend;
      e.results += results;
      e.impressions += impressions;
      e.reach += reach;
      e.monthKeys.add(monthKey);
    }
  }

  const monthList = [...months.values()].map((m) => ({ ...m, campaigns: m.campaigns.size }));
  const totalSpend = monthList.reduce((total, m) => total + m.spend, 0);

  const campaigns = [...entries.values()]
    .map((e) => {
      const keys = [...e.monthKeys].sort();
      const short = (k) => MONTHS[Number(k.slice(5, 7)) - 1];
      const { monthKeys, ...rest } = e;
      return {
        ...rest,
        firstMonth: keys.length ? short(keys[0]) : null,
        lastMonth: keys.length ? short(keys[keys.length - 1]) : null,
        monthsLive: keys.length,
        share: totalSpend > 0 ? e.spend / totalSpend : 0,
      };
    })
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));

  return {
    asOf: new Date().toISOString(),
    year,
    since,
    until,
    today,
    purgedBefore,
    retentionMonths: RETENTION_MONTHS,
    currency: REPORT_CURRENCY,
    availableYears: availableYears(),
    accounts: [...accountMeta.values()].map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    totals: {
      spend: totalSpend,
      results: monthList.reduce((total, m) => total + m.results, 0),
      campaigns: campaigns.length,
      impressions: campaigns.reduce((total, c) => total + c.impressions, 0),
      reach: campaigns.reduce((total, c) => total + c.reach, 0),
    },
    months: monthList,
    campaigns,
  };
}

module.exports = async (req, res) => {
  const years = availableYears();
  const asked = Number((req.query && req.query.year) || years[0]);
  const year = years.includes(asked) ? asked : years[0];

  try {
    const fresh = req.query && req.query.refresh === '1';
    const hit = cache.get(year);
    if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(hit.payload);
    }
    const payload = await build(year);
    cache.set(year, { at: Date.now(), payload });
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    const hit = cache.get(year);
    if (hit) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ ...hit.payload, stale: true, error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
};

module.exports.build = build;
