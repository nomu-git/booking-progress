// Trip Revenue tab: the "NomuHub Trips 2026" revenue workbook, read live
// from its SharePoint share link (REVENUE_SHEET_URL). Same approach as the
// other sheet mirrors: whoever keeps the workbook carries on as they do,
// and the tab mirrors it.
//
// The Trips tab (one row per departure: month, dates, programme, project
// manager, revenue, actual expenses, profit, margin, gain/loss) is the
// source. The workbook's Dashboard tab is formulas over those same rows, so
// the totals and the month / programme / manager breakdowns are recomputed
// here rather than scraped from its layout, which moves when someone
// rearranges it. The Settings tab supplies the currency label.

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

  // The currency is a label in Settings ("USD"), under a "Currency" header.
  let currency = 'USD';
  for (const s of sheets) {
    for (let r = 0; r < s.grid.length; r++) {
      const c = cells(s.grid[r]).findIndex((v) => /^currency$/i.test(v));
      if (c >= 0 && text((s.grid[r + 1] || [])[c])) currency = text(s.grid[r + 1][c]);
    }
  }

  return {
    asOf: new Date().toISOString(),
    currency,
    totals: roll(trips),
    byMonth: groupBy('month', (a, b) => String(a).localeCompare(String(b))),
    byProgramme: groupBy('programme', (a, b) => (a == null) - (b == null) || String(a).localeCompare(String(b))),
    // Trips with no project manager picked are their own row, so the table
    // adds up to the same totals as everything else.
    byManager: groupBy('manager', (a, b) => (a == null) - (b == null)),
    trips,
  };
}

// Served by api/sheets.js?name=revenue, which fetches the workbook from
// REVENUE_SHEET_URL, caches it for `ttl`, and passes it to build().
module.exports = { build, envVar: 'REVENUE_SHEET_URL', ttl: CACHE_TTL_MS };
