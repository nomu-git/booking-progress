// Trip Revenue tab: the "NomuHub Trips 2026" revenue workbook, read live
// from its SharePoint share link (REVENUE_SHEET_URL). Same approach as the
// other sheet mirrors: whoever keeps the workbook carries on as they do,
// and the tab mirrors it.
//
// The Trips tab (one row per departure: month, dates, programme, project
// manager, revenue, actual expenses, profit, margin, gain/loss) is the
// source. The workbook's Dashboard tab is formulas over those same rows, so
// the totals and the month / programme breakdowns are recomputed
// here rather than scraped from its layout, which moves when someone
// rearranges it.

const CACHE_TTL_MS = Number(process.env.REVENUE_CACHE_TTL_MS || 60000);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cells = (row) => (row || []).map(text);

// "January 2026" -> "2026-01".
function monthKey(v) {
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(text(v));
  if (!m) return null;
  const i = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`;
}

// Columns found by header name, so one moving or a new one being added
// doesn't shift everything after it.
const COLS = {
  no: /^#$/, month: /^month$/, trip: /^trip$/, destination: /^destination/,
  programme: /^program/, start: /^start/, end: /^end/, weeks: /^weeks?$/,
  manager: /^project manager/, revenue: /revenue/, expenses: /expense/,
  profit: /^profit$/, margin: /^profit %|^margin/, result: /gain|loss/,
};

// What to do about the numbers, in plain words. Worked out here, where the
// real figures are, but written in percentages, ratios and trip names only:
// the site is public and shows no amounts and no people (Muatasam, 4 Oct
// 2026), so a sentence must never carry a figure or a manager's name.
// These are rules over the sheet, not a live AI call.
const THIN = 0.15;
const HEALTHY = 0.3;
const pc = (m) => `${m < 0 ? '−' : ''}${(Math.abs(m) * 100).toFixed(1)}%`;
const share = (n) => `${Math.round(n * 100)}%`;
const LEVEL_ORDER = { fix: 0, improve: 1, keep: 2, note: 3 };

function suggest({ total, programmes, months, trips, todayKey }) {
  const out = [];
  const withFigs = (g) => g.revenue > 0 && g.margin != null;
  const progs = programmes.filter(withFigs);
  const totalTrips = trips.length;
  const totalRev = total.revenue;

  if (total.margin != null) {
    const band = total.margin >= HEALTHY ? 'a healthy level' : total.margin >= THIN ? 'workable but not strong' : 'thin';
    out.push({ level: 'note', title: `Overall margin is ${pc(total.margin)}`, text: `That is ${band}. Expenses take ${pc(1 - total.margin)} of every unit of revenue, so each extra point of margin comes from either a higher price or lower cost per trip.` });
  }

  // Trips that lost money: the clearest thing to fix.
  for (const t of trips.filter((x) => x.revenue > 0 && x.expenses != null && x.profit < 0)) {
    out.push({ level: 'fix', title: `${t.name} lost money (${pc(t.profit / t.revenue)})`, text: `Its expenses were ${(t.expenses / t.revenue).toFixed(1)}x its revenue. Check the price against what it costs to run, and whether it should repeat as is.` });
  }

  // A programme that is a big slice of the trips but a small slice of revenue.
  if (progs.length > 1 && totalTrips && totalRev) {
    const gap = progs
      .map((g) => ({ g, trips: g.trips / totalTrips, rev: g.revenue / totalRev }))
      .sort((a, b) => (b.trips - b.rev) - (a.trips - a.rev))[0];
    if (gap && gap.trips - gap.rev > 0.1) {
      out.push({ level: 'improve', title: `${gap.g.key} is ${share(gap.trips)} of trips but only ${share(gap.rev)} of revenue`, text: `Each ${gap.g.key} trip earns less than the average trip, and its margin is ${pc(gap.g.margin)}. Raising its price, trimming its costs, or running fewer of these weeks would lift the overall margin the most.` });
    }
  }

  const sorted = [...progs].sort((a, b) => a.margin - b.margin);
  const worst = sorted[0];
  if (worst && worst.margin < HEALTHY && !out.some((o) => o.title.startsWith(`${worst.key} is`))) {
    out.push({ level: worst.margin < THIN ? 'improve' : 'note', title: `${worst.key} has the lowest margin, ${pc(worst.margin)}`, text: `Across ${worst.trips} trip${worst.trips === 1 ? '' : 's'}, expenses take ${pc(1 - worst.margin)} of its revenue. Look at its biggest costs first: accommodation, transport and activities per traveller.` });
  }

  // Trips earning a thin margin.
  const thin = trips.filter((x) => x.revenue > 0 && x.profit >= 0 && x.profit / x.revenue < THIN);
  if (thin.length) {
    out.push({ level: 'improve', title: `${thin.length} trip${thin.length === 1 ? '' : 's'} earned under ${share(THIN)}`, text: `${thin.slice(0, 4).map((x) => `${x.name} (${pc(x.profit / x.revenue)})`).join(', ')}${thin.length > 4 ? ` and ${thin.length - 4} more` : ''}. A small price rise or a tighter cost list would move these the most.` });
  }

  const best = sorted[sorted.length - 1];
  if (best && best.margin >= HEALTHY && best !== worst) {
    out.push({ level: 'keep', title: `${best.key} is the strongest, at ${pc(best.margin)}`, text: `It brings in ${share(best.revenue / totalRev)} of all revenue from ${best.trips} trip${best.trips === 1 ? '' : 's'}. Keep its weeks full, and use how it is priced and run as the model for the weaker programmes.` });
  }

  const strong = trips.filter((x) => x.revenue > 0 && x.profit / x.revenue >= 0.45);
  if (strong.length) {
    out.push({ level: 'keep', title: `${strong.length} trip${strong.length === 1 ? '' : 's'} earned 45% or more`, text: `${strong.slice(0, 4).map((x) => `${x.name} (${pc(x.profit / x.revenue)})`).join(', ')}. Worth repeating, and worth checking what made them cheaper to run or easier to price.` });
  }

  // Figures still to come: the margins above are only as complete as these.
  const overdue = trips.filter((x) => /not entered/i.test(x.result || '') && x.end && x.end < todayKey);
  if (overdue.length) {
    out.push({ level: 'improve', title: `${overdue.length} finished trip${overdue.length === 1 ? ' has' : 's have'} no figures yet`, text: `${overdue.slice(0, 4).map((x) => x.name).join(', ')}${overdue.length > 4 ? ` and ${overdue.length - 4} more` : ''}. Until they are filled in, the margins above leave them out and may read better or worse than the real picture.` });
  }

  return out
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    .slice(0, 8);
}

function build(sheets) {
  let master = null;
  let headerRow = -1;
  for (const s of sheets) {
    const r = s.grid.findIndex((row) => {
      const h = cells(row).map((v) => v.toLowerCase());
      return h.includes('trip') && h.some((v) => /revenue/.test(v)) && h.some((v) => /expense/.test(v));
    });
    if (r >= 0) { master = s; headerRow = r; break; }
  }
  if (!master) throw new Error('No tab with Trip / Revenue / Expenses headers found in the revenue workbook');

  const header = cells(master.grid[headerRow]).map((v) => v.toLowerCase());
  const col = {};
  for (const [key, re] of Object.entries(COLS)) col[key] = header.findIndex((h) => re.test(h));
  const cell = (row, key) => (col[key] >= 0 ? row[col[key]] : null);

  const trips = [];
  for (const row of master.grid.slice(headerRow + 1)) {
    const name = text(cell(row, 'trip'));
    // The TOTAL row sits under the list; it's recomputed below.
    if (!name || /^total$/i.test(name)) continue;
    const start = text(cell(row, 'start'));
    const end = text(cell(row, 'end'));
    trips.push({
      no: text(cell(row, 'no')) || null,
      name,
      month: monthKey(cell(row, 'month')) || (ISO.test(start) ? start.slice(0, 7) : null),
      destination: text(cell(row, 'destination')) || null,
      programme: text(cell(row, 'programme')) || null,
      start: ISO.test(start) ? start : null,
      end: ISO.test(end) ? end : null,
      weeks: num(cell(row, 'weeks')),
      manager: text(cell(row, 'manager')) || null,
      revenue: num(cell(row, 'revenue')),
      expenses: num(cell(row, 'expenses')),
      profit: num(cell(row, 'profit')),
      margin: num(cell(row, 'margin')),
      result: text(cell(row, 'result')) || null,
    });
  }

  // Sums as the sheet's own Dashboard does them: a blank counts as nothing.
  const sum = (list, key) => list.reduce((n, t) => n + (t[key] || 0), 0);
  const roll = (list) => {
    const revenue = sum(list, 'revenue');
    const expenses = sum(list, 'expenses');
    const profit = sum(list, 'profit');
    return {
      trips: list.length,
      entered: list.filter((t) => !/not entered/i.test(t.result || '') && t.revenue != null).length,
      revenue, expenses, profit,
      margin: revenue ? profit / revenue : null,
    };
  };
  const groupBy = (key, order) => {
    const keys = [...new Set(trips.map((t) => t[key] || null))];
    if (order) keys.sort(order);
    return keys.map((k) => ({ key: k, ...roll(trips.filter((t) => (t[key] || null) === k)) }));
  };

  // Muatasam, 4 Oct 2026: "Just show percentage not values at all. Remove
  // the ones against ppl too." The site is public, so amounts and project
  // managers are stripped here rather than hidden in the page: nothing
  // leaving this API carries a revenue, expense or profit figure, a
  // currency, or a person's name. What's left is each row's margin (profit
  // over revenue), whether it has figures at all, its Gain/Loss result and
  // trip counts. The margin alone is enough to draw the expenses/profit
  // split of each row's own revenue.
  const pctOnly = (g) => ({
    trips: g.trips,
    entered: g.entered,
    figures: !!(g.revenue || g.expenses),
    margin: g.margin,
  });
  const todayKey = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  const suggestions = suggest({
    total: roll(trips),
    programmes: groupBy('programme').filter((g) => g.key),
    months: groupBy('month').filter((g) => g.key),
    trips,
    todayKey,
  });
  return {
    asOf: new Date().toISOString(),
    suggestions,
    totals: pctOnly(roll(trips)),
    byMonth: groupBy('month', (a, b) => String(a).localeCompare(String(b))).map((g) => ({ key: g.key, ...pctOnly(g) })),
    byProgramme: groupBy('programme', (a, b) => (a == null) - (b == null) || String(a).localeCompare(String(b))).map((g) => ({ key: g.key, ...pctOnly(g) })),
    trips: trips.map((t) => ({
      no: t.no, name: t.name, month: t.month, destination: t.destination, programme: t.programme,
      start: t.start, end: t.end, weeks: t.weeks, result: t.result,
      figures: t.revenue != null || t.expenses != null,
      // The sheet's own Profit % where it has one, else worked out.
      margin: t.margin != null ? t.margin : (t.revenue ? (t.profit || 0) / t.revenue : null),
    })),
  };
}

// Served by api/sheets.js?name=revenue, which fetches the workbook from
// REVENUE_SHEET_URL, caches it for `ttl`, and passes it to build().
module.exports = { build, envVar: 'REVENUE_SHEET_URL', ttl: CACHE_TTL_MS };
