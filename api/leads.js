// Leads tab — Marina's "Leads Feedback & Report" workbook, read live and
// summarised into weeks and days. The sheet is the source of truth until
// counting is automated (docs/LEADS-PLAN.md, Phase 1).
//
// The workbook holds three kinds of tab, told apart by their headers rather
// than their names so next quarter's tabs are picked up with no code change:
//
//   - per-lead logs ("Q1 leads", "Q2 leads", "July"): one row per lead, with
//     a Date and a Source (IG or WA). Covers 1 Jan to 21 Jul.
//   - weekly reports ("Q1/Q2/Q3 Report"): a week label ("8-14 Sep"), then
//     IG, WA and IG+WA rows broken down by project. Marina's official weekly
//     numbers, 12 Jan onward.
//   - a daily summary ("Leads Quality"): a date row, then that day's counts
//     by project. IG and WA combined, no split. From 23 Sep.
//
// Weekly figures come from the reports, since those are the numbers the
// team already works from. Days come from the log or the daily summary.
// Where a week has no report row yet (the current week, until Marina fills
// it in), its total is the sum of its days, so it moves as she logs them.
//
// The logs hold phone numbers and Instagram profiles. The site is public,
// so nothing leaves this file except counts.

const { fetchLeadsWorkbook } = require('./leads-sheet');

const CACHE_TTL_MS = Number(process.env.LEADS_CACHE_TTL_MS || 60000);

// Oman is UTC+4 year-round, and "today" is Muscat's today.
const omanToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const text = (v) => String(v == null ? '' : v).trim();
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000));

// The same project is spelled several ways across the tabs: "ZNZ|BL ",
// "ZNZ |EX", "TH/WL", "ZNZ|Med" and "ZNZ|MD". "BL |WL" and its siblings sit
// under Asia beside BA|TA, so BL there is a slip for BA (Bali), not
// Building. Everything is folded onto the dashboard's project codes.
const ALIASES = {
  'BL|WL': 'BA|WL', 'BL|TA': 'BA|TA', 'BL|BL': 'BA|BL', 'BL|EX': 'BA|EX',
  'ZNZ|MD': 'ZNZ|MED', 'SALALAH|WL': 'SAL|WL', KENYA: 'KN', 'SRI LANKA': 'SL',
};
function projectCode(label) {
  const s = text(label).toUpperCase().replace(/\s*[|/]\s*/g, '|').replace(/\s+/g, ' ');
  return ALIASES[s] || s;
}

// A lead's trip ("ZNZ|BL|Jan", "ZNZ|Med|Jul", "NA") -> its project. The
// month is dropped, and so is anything that isn't a letter, since some
// entries carry a stray Arabic vowel mark ("ZNZ|BL|ِApr").
function tripProject(trip) {
  const parts = text(trip).split('|').map((p) => p.replace(/[^A-Za-z ]/g, '').trim()).filter(Boolean);
  if (!parts.length) return 'NA';
  return projectCode(parts.slice(0, 2).join('|'));
}

// "8-14 Sep", "8/13 July", "28-3 Aug", "26 Jan-1 Feb", "23-31Mar" -> dates.
// Labels carry no year, so it's supplied.
function weekRange(label, year) {
  const m = /^(\d{1,2})\s*([a-z]*)\s*-\s*(\d{1,2})\s*([a-z]+)/.exec(text(label).toLowerCase().replace(/\//g, '-'));
  if (!m) return null;
  const endMonth = MONTHS.indexOf(m[4].slice(0, 3));
  if (endMonth < 0) return null;
  const d1 = Number(m[1]);
  const d2 = Number(m[3]);
  // No month on the first day means it shares the second's, unless it's the
  // larger number: "28-3 Aug" starts in July.
  const startMonth = m[2] ? MONTHS.indexOf(m[2].slice(0, 3)) : (d1 <= d2 ? endMonth : endMonth - 1);
  if (startMonth < 0) return null;
  const start = new Date(Date.UTC(year, startMonth, d1));
  const end = new Date(Date.UTC(year, endMonth, d2));
  return end >= start ? { start: iso(start), end: iso(end) } : null;
}

// The header row of a report or daily summary: the first near the top with
// a Total column. Every other named column after the label column is a
// project.
function projectHeader(grid) {
  for (let r = 0; r < Math.min(6, grid.length); r++) {
    const row = grid[r] || [];
    const totalCol = row.findIndex((v) => /^total/i.test(text(v)));
    if (totalCol < 1) continue;
    const projects = [];
    for (let c = 1; c < totalCol; c++) if (text(row[c])) projects.push({ col: c, code: projectCode(row[c]) });
    if (projects.length >= 3) return { totalCol, projects };
  }
  return null;
}

function tally() {
  return { ig: 0, wa: 0, other: 0, total: 0, projects: new Map() };
}

// ---- tab readers ----

function readLog(grid, days) {
  const header = (grid[0] || []).map((v) => text(v).toLowerCase());
  const dateCol = header.indexOf('date');
  const sourceCol = header.indexOf('source');
  const tripCol = header.indexOf('trip');
  for (const row of grid.slice(1)) {
    const day = row[dateCol];
    if (typeof day !== 'string' || !ISO.test(day)) continue; // month divider rows
    if (!days.has(day)) days.set(day, { ...tally(), split: true, from: 'log' });
    const t = days.get(day);
    const source = text(row[sourceCol]).toUpperCase();
    if (source === 'IG') t.ig += 1;
    else if (source === 'WA') t.wa += 1;
    else t.other += 1;
    t.total += 1;
    const p = tripCol >= 0 ? tripProject(row[tripCol]) : 'NA';
    t.projects.set(p, (t.projects.get(p) || 0) + 1);
  }
}

function readDailySummary(grid, header, days) {
  for (let r = 0; r < grid.length; r++) {
    const day = (grid[r] || [])[0];
    if (typeof day !== 'string' || !ISO.test(day)) continue;
    // The counts sit on the row under the date, unless the date row carries
    // them itself.
    const own = grid[r].slice(1).some((v) => count(v) != null);
    const next = grid[r + 1] || [];
    const values = own ? grid[r] : (typeof next[0] === 'string' && ISO.test(next[0]) ? [] : next);
    const cells = header.projects.map((p) => ({ code: p.code, n: count(values[p.col]) }));
    if (!cells.some((c) => c.n != null) && count(values[header.totalCol]) == null) continue; // not filled in yet
    if (days.has(day) && days.get(day).from === 'log') continue; // the log also has the split
    const t = { ...tally(), split: false, from: 'daily' };
    for (const c of cells) if (c.n) t.projects.set(c.code, (t.projects.get(c.code) || 0) + c.n);
    const sum = cells.reduce((s, c) => s + (c.n || 0), 0);
    t.total = count(values[header.totalCol]) ?? sum;
    days.set(day, t);
  }
}

function readReport(grid, header, year, weeks) {
  for (let r = 0; r < grid.length; r++) {
    const range = weekRange((grid[r] || [])[0], year);
    if (!range) continue;
    const rows = { ig: null, wa: null, total: null };
    for (let k = r + 1; k <= r + 4 && k < grid.length; k++) {
      const label = text((grid[k] || [])[0]).toLowerCase().replace(/\s/g, '');
      if (weekRange((grid[k] || [])[0], year)) break;
      if (label.includes('ig+wa')) rows.total = grid[k];
      else if (/\|ig$/.test(label)) rows.ig = grid[k];
      else if (/\|wa$/.test(label)) rows.wa = grid[k];
    }
    const sumOf = (row) => (row ? header.projects.reduce((s, p) => s + (count(row[p.col]) || 0), 0) : null);
    const totalOf = (row) => (row ? count(row[header.totalCol]) ?? sumOf(row) : null);
    const ig = totalOf(rows.ig);
    const wa = totalOf(rows.wa);
    const total = totalOf(rows.total) ?? (ig != null && wa != null ? ig + wa : null);
    // An unfilled week has formulas that already total 0 but no counts typed.
    const filled = [rows.ig, rows.wa, rows.total].some((row) => row && header.projects.some((p) => count(row[p.col]) != null))
      && (total || 0) > 0;
    const projects = new Map();
    for (const p of header.projects) {
      const pi = rows.ig ? count(rows.ig[p.col]) || 0 : 0;
      const pw = rows.wa ? count(rows.wa[p.col]) || 0 : 0;
      const pt = rows.total ? count(rows.total[p.col]) ?? pi + pw : pi + pw;
      if (!pi && !pw && !pt) continue;
      const cur = projects.get(p.code) || { ig: 0, wa: 0, total: 0 };
      projects.set(p.code, { ig: cur.ig + pi, wa: cur.wa + pw, total: cur.total + pt });
    }
    weeks.push({ label: text(grid[r][0]), ...range, report: filled ? { ig, wa, total, projects } : null });
  }
}

// ---- assembling weeks ----

function daysBetween(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const shortDate = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1)}`;
};

function build(sheets, today = omanToday()) {
  // The labels carry no year; the dates typed into the logs do.
  const years = new Map();
  for (const s of sheets) for (const row of s.grid) for (const v of row) {
    if (typeof v === 'string' && ISO.test(v)) years.set(v.slice(0, 4), (years.get(v.slice(0, 4)) || 0) + 1);
  }
  const year = Number([...years].sort((a, b) => b[1] - a[1])[0]?.[0] || today.slice(0, 4));

  const days = new Map();
  const reportWeeks = [];
  const summaries = [];
  for (const s of sheets) {
    const head = (s.grid[0] || []).map((v) => text(v).toLowerCase());
    if (head.includes('date') && head.includes('source')) { readLog(s.grid, days); continue; }
    const header = projectHeader(s.grid);
    if (!header) continue;
    const hasDates = s.grid.some((row) => typeof row[0] === 'string' && ISO.test(row[0]));
    if (hasDates) summaries.push({ grid: s.grid, header });
    else readReport(s.grid, header, year, reportWeeks);
  }
  // Summaries after the logs, so a day in both keeps the log's IG/WA split.
  for (const s of summaries) readDailySummary(s.grid, s.header, days);

  // The log is complete for its span: a day inside it with no rows had no
  // leads. Outside the log, a day only counts as known if it has an entry.
  const logDays = [...days].filter(([, t]) => t.from === 'log').map(([d]) => d).sort();
  const logSpan = logDays.length ? [logDays[0], logDays[logDays.length - 1]] : null;

  reportWeeks.sort((a, b) => a.start.localeCompare(b.start));
  const weeks = reportWeeks.map((w) => ({ ...w }));

  // Days no report week covers (1–11 Jan, and anything after the last report
  // week, the current week included) are grouped into 7-day weeks of their
  // own, so they aren't dropped.
  const covered = (d) => weeks.some((w) => d >= w.start && d <= w.end);
  const loose = [...days.keys(), today].filter((d) => d.slice(0, 4) === String(year) && !covered(d)).sort();
  for (const d of loose) {
    if (covered(d)) continue;
    const prev = weeks.filter((w) => w.end < d).pop();
    const next = weeks.find((w) => w.start > d);
    const start = prev && addDays(prev.end, 1) > addDays(d, -7) ? addDays(prev.end, 1) : d;
    let end = addDays(start, 6);
    if (next && end >= next.start) end = addDays(next.start, -1);
    weeks.push({ label: null, start, end, report: null });
    weeks.sort((a, b) => a.start.localeCompare(b.start));
  }

  const out = weeks.map((w) => {
    const dailies = daysBetween(w.start, w.end).map((d) => {
      const t = days.get(d);
      const future = d > today;
      const inLog = logSpan && d >= logSpan[0] && d <= logSpan[1];
      if (t) return { date: d, total: t.total, ig: t.split ? t.ig : null, wa: t.split ? t.wa : null, recorded: true, future };
      return { date: d, total: inLog ? 0 : null, ig: inLog ? 0 : null, wa: inLog ? 0 : null, recorded: !!inLog, future };
    });
    const recorded = dailies.filter((d) => d.recorded);
    const dailyTotal = recorded.reduce((s, d) => s + d.total, 0);
    const splitKnown = recorded.length > 0 && recorded.every((d) => d.ig != null);

    const r = w.report;
    const projects = new Map();
    if (r) {
      for (const [code, p] of r.projects) projects.set(code, p);
    } else {
      for (const d of daysBetween(w.start, w.end)) {
        const t = days.get(d);
        if (!t) continue;
        for (const [code, n] of t.projects) {
          const cur = projects.get(code) || { ig: null, wa: null, total: 0 };
          projects.set(code, { ig: null, wa: null, total: cur.total + n });
        }
      }
    }

    const issues = [];
    if (r && r.ig != null && r.wa != null && r.total != null && r.ig + r.wa !== r.total) {
      issues.push(`In the sheet, IG ${r.ig} + WA ${r.wa} = ${r.ig + r.wa}, but the IG+WA row says ${r.total}`);
    }
    if (r && recorded.length === dailies.length && dailyTotal !== r.total) {
      issues.push(`The daily entries add up to ${dailyTotal}; the weekly report says ${r.total}`);
    }

    return {
      label: w.label || `${shortDate(w.start)} – ${shortDate(w.end)}`,
      start: w.start,
      end: w.end,
      current: today >= w.start && today <= w.end,
      source: r ? 'report' : 'daily',
      total: r ? r.total : dailyTotal,
      ig: r ? r.ig : (splitKnown ? recorded.reduce((s, d) => s + d.ig, 0) : null),
      wa: r ? r.wa : (splitKnown ? recorded.reduce((s, d) => s + d.wa, 0) : null),
      days: recorded.length ? dailies : null,
      daysRecorded: recorded.length,
      dailyTotal,
      projects: [...projects].map(([code, p]) => ({ code, ...p }))
        .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
      issues,
    };
  });

  // Weeks that end up empty on every count (future filler) are dropped,
  // except the current one, which should always be there to watch.
  const weeksOut = out.filter((w) => w.current || w.total > 0 || w.days);
  const known = weeksOut.filter((w) => w.ig != null && w.wa != null);
  return {
    asOf: new Date().toISOString(),
    today,
    year,
    weeks: weeksOut,
    totals: {
      leads: weeksOut.reduce((s, w) => s + (w.total || 0), 0),
      ig: known.reduce((s, w) => s + w.ig, 0),
      wa: known.reduce((s, w) => s + w.wa, 0),
      weeks: weeksOut.length,
    },
  };
}

let cache = { at: 0, payload: null };

module.exports = async (req, res) => {
  try {
    const fresh = req.query && req.query.refresh === '1';
    if (!fresh && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cache.payload);
    }
    const payload = build(await fetchLeadsWorkbook());
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
