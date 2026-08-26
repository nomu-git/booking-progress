// The Saudi Arabia media plan, transcribed verbatim from
// "NomuHub - Saudi Arabia Media Plan.xlsx".
//
// This is a *plan*, not measured data — nothing here comes from Meta. It's the
// intended budget and the estimates that were used to justify it, kept next to
// the live Campaigns and History tabs so the two can be read against each
// other. Every string below is exactly what the spreadsheet cell held, so the
// board and the document can never quietly disagree.
//
// Figures are USD, as the plan was written. SAR equivalents are derived at the
// same rate the rest of the dashboard uses, never stored as a second source.

const USD_SAR = Number(process.env.META_USD_SAR || 3.75);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// program, dates, objective, budget, cpm, impressions, cost/result, results, kind
const ROWS = [
  ['Zanzibar – Building',          'Sep 6–26',      'Messages', 750, 6.0, 125000, '$4.50 / Message', '167 Messages', 'prospecting'],
  ['Bali – Wellness',              'Sep 13–19',     'Messages', 750, 7.0, 107000, '$6.00 / Message', '125 Messages', 'prospecting'],
  ['Vietnam – Explore',            'Sep 19–26',     'Messages', 750, 6.5, 115000, '$5.50 / Message', '136 Messages', 'prospecting'],
  ['Bali – Explore',               'Sep 20–26',     'Messages', 750, 6.0, 125000, '$5.00 / Message', '150 Messages', 'prospecting'],
  ['South Korea – Explore',        'Oct 24–31',     'Messages', 750, 7.0, 107000, '$6.00 / Message', '125 Messages', 'prospecting'],
  ['Thailand – Wellness',          'Nov 15–20',     'Messages', 750, 7.0, 107000, '$6.00 / Message', '125 Messages', 'prospecting'],
  ['Zanzibar – Building',          'Nov 29–Dec 19', 'Messages', 750, 6.0, 125000, '$4.50 / Message', '167 Messages', 'prospecting'],
  ['Bali – Explore',               'Dec 5–12',      'Messages', 750, 6.0, 125000, '$5.00 / Message', '150 Messages', 'prospecting'],
  ['Bali – Teaching',              'Dec 6–19',      'Messages', 750, 5.5, 136000, '$4.50 / Message', '167 Messages', 'prospecting'],
  ['Zanzibar – Explore',           'Dec 12–18',     'Messages', 750, 6.0, 125000, '$5.00 / Message', '150 Messages', 'prospecting'],
  ['Bali – Wellness',              'Dec 20–Jan 2',  'Messages', 750, 7.0, 107000, '$6.00 / Message', '125 Messages', 'prospecting'],
  ['Zanzibar – Teaching',          'Dec 20–Jan 2',  'Messages', 750, 5.5, 136000, '$4.50 / Message', '167 Messages', 'prospecting'],
  ['Website Retargeting',          'Monthly',       'Purchase', 900, null, null, 'Optimize for Purchase', 'Website Purchases', 'retargeting'],
  ['Website Traffic / Engagement', 'Monthly',       'Landing Page Views / Engagement', 450, 5.0, 90000, '$15/day', 'Engagement', 'traffic'],
];

// The plan's own summary block, kept as written rather than recomputed — if a
// derived total ever disagrees with these, that disagreement is worth seeing.
const SUMMARY = [
  { label: 'Total Prospecting',    objective: 'Messages',                        budgetUsd: 9000,  cpm: 6.21, impressions: 1440000, costPerResult: '~$5.13 / Message', results: '~1,754 Messages' },
  { label: 'Retargeting – 30 Days', objective: 'Purchase',                       budgetUsd: 900,   cpm: null, impressions: null,    costPerResult: 'Purchase Optimization', results: '—' },
  { label: 'Total Media Spend',    objective: 'Messages + Purchase',             budgetUsd: 9900,  cpm: null, impressions: null,    costPerResult: '—', results: '—' },
  { label: 'Total Media Spend',    objective: 'Messages + Traffic + Purchase',   budgetUsd: 10350, cpm: null, impressions: null,    costPerResult: '—', results: '—' },
];

// "167 Messages" -> 167, so the estimates can be charted and totalled. The
// original string is kept alongside for display.
const countOf = (s) => {
  const m = String(s || '').match(/([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

// "Nov 29–Dec 19" starts in November; "Monthly" isn't a month at all.
function startMonth(dates) {
  const m = String(dates || '').trim().match(/^([A-Za-z]{3})/);
  if (!m) return null;
  const i = MONTHS.indexOf(m[1]);
  return i < 0 ? null : i;
}

function build() {
  const lines = ROWS.map(([program, dates, objective, budgetUsd, cpm, impressions, costPerResult, results, kind], i) => ({
    id: `plan-${i}`,
    program,
    dates,
    objective,
    market: 'Saudi Arabia',
    kind,
    budgetUsd,
    budgetSar: budgetUsd * USD_SAR,
    cpm,
    impressions,
    costPerResult,
    results,
    resultCount: countOf(results),
    recurring: /monthly/i.test(dates),
    startMonth: startMonth(dates),
  }));

  const sumBy = (kind, key) => lines
    .filter((l) => l.kind === kind)
    .reduce((total, l) => total + (l[key] || 0), 0);

  const byMonth = [];
  for (let i = 0; i < 12; i++) {
    const group = lines.filter((l) => l.startMonth === i);
    if (!group.length) continue;
    byMonth.push({
      month: MONTHS[i],
      index: i,
      campaigns: group.length,
      budgetUsd: group.reduce((total, l) => total + l.budgetUsd, 0),
      impressions: group.reduce((total, l) => total + (l.impressions || 0), 0),
      results: group.reduce((total, l) => total + (l.resultCount || 0), 0),
    });
  }

  // One entry per distinct trip, since several run twice on different dates.
  const byProgram = [];
  for (const line of lines) {
    if (line.kind !== 'prospecting') continue;
    let entry = byProgram.find((p) => p.program === line.program);
    if (!entry) {
      entry = { program: line.program, flights: 0, budgetUsd: 0, impressions: 0, results: 0 };
      byProgram.push(entry);
    }
    entry.flights += 1;
    entry.budgetUsd += line.budgetUsd;
    entry.impressions += line.impressions || 0;
    entry.results += line.resultCount || 0;
  }
  byProgram.sort((a, b) => b.budgetUsd - a.budgetUsd || a.program.localeCompare(b.program));

  const prospectingUsd = sumBy('prospecting', 'budgetUsd');
  const retargetingUsd = sumBy('retargeting', 'budgetUsd');
  const trafficUsd = sumBy('traffic', 'budgetUsd');

  return {
    title: 'NomuHub – Saudi Arabia Media Plan',
    market: 'Saudi Arabia',
    currency: 'USD',
    usdSar: USD_SAR,
    source: 'NomuHub - Saudi Arabia Media Plan.xlsx',
    lines,
    summary: SUMMARY,
    byMonth,
    byProgram,
    totals: {
      flights: lines.length,
      programs: byProgram.length,
      prospectingUsd,
      retargetingUsd,
      trafficUsd,
      // Prospecting + retargeting only, matching the plan's "Total Media
      // Spend / Messages + Purchase" line.
      corePlanUsd: prospectingUsd + retargetingUsd,
      allUsd: prospectingUsd + retargetingUsd + trafficUsd,
      impressions: lines.reduce((total, l) => total + (l.impressions || 0), 0),
      results: lines.reduce((total, l) => total + (l.resultCount || 0), 0),
    },
  };
}

module.exports = async (req, res) => {
  try {
    const payload = build();
    // Static reference data — no upstream to go stale, so it can cache hard.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

module.exports.build = build;
