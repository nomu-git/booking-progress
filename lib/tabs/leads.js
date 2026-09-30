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
    if (projects.length < 3) continue;
    // A day's channel split can also be two plain columns past Total ("IG",
    // "WA"), the lightest way to log it: two numbers a day, no extra rows.
    // Their headers may sit on this row or the one above (row 1 carries
    // "HP" that way today).
    let igCol = -1;
    let waCol = -1;
    for (const hr of [row, grid[r - 1] || []]) {
      hr.forEach((v, c) => {
        if (c <= totalCol) return;
        const h = text(v).toLowerCase();
        if (igCol < 0 && /^(ig|instagram)$/.test(h)) igCol = c;
        if (waCol < 0 && /^(wa|whatsapp)$/.test(h)) waCol = c;
      });
    }
    return { totalCol, projects, igCol, waCol };
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
    const code = tripCol >= 0 ? tripProject(row[tripCol]) : 'NA';
    const p = t.projects.get(code) || { ig: 0, wa: 0, total: 0 };
    p.total += 1;
    if (source === 'IG') p.ig += 1;
    else if (source === 'WA') p.wa += 1;
    t.projects.set(code, p);
  }
}

const isDay = (v) => typeof v === 'string' && ISO.test(v);
const hasCounts = (row) => (row || []).slice(1).some((v) => count(v) != null);

// Each date's counts sit on the rows under it, down to the next date. Today
// that's one combined row ("IG+WA", or no label at all). If the channels get
// logged separately, as IG and WA rows the way the weekly report does it,
// the day gets its split, per project too, with no code change. A combined
// row alongside them is the total; without one, IG + WA is.
function readDailySummary(grid, header, days) {
  const channelOf = (label) => {
    const l = text(label).toLowerCase().replace(/\s/g, '');
    if (/(^|\|)(ig|instagram)$/.test(l)) return 'ig';
    if (/(^|\|)(wa|whatsapp)$/.test(l)) return 'wa';
    return 'total';
  };
  for (let r = 0; r < grid.length; r++) {
    const day = (grid[r] || [])[0];
    if (!isDay(day)) continue;
    const rows = { total: null, ig: null, wa: null };
    if (hasCounts(grid[r])) rows.total = grid[r];
    for (let k = r + 1; k < grid.length && !isDay((grid[k] || [])[0]); k++) {
      if (!hasCounts(grid[k])) continue;
      const which = channelOf(grid[k][0]);
      if (!rows[which]) rows[which] = grid[k];
    }
    if (!rows.total && !rows.ig && !rows.wa) continue; // not filled in yet
    if (days.has(day) && days.get(day).from === 'log') continue; // the log has it already

    const at = (row, col) => (row && col >= 0 ? count(row[col]) : null);
    const totalOf = (row) => (row ? at(row, header.totalCol) ?? header.projects.reduce((s, p) => s + (at(row, p.col) || 0), 0) : null);
    const split = !!(rows.ig && rows.wa);
    // No IG/WA rows, but IG and WA columns filled in beside the total: the
    // day gets its channel split, though not per project.
    const colIg = !split ? at(rows.total, header.igCol) : null;
    const colWa = !split ? at(rows.total, header.waCol) : null;
    const t = { ...tally(), split, from: 'daily' };
    for (const p of header.projects) {
      const ig = split ? at(rows.ig, p.col) || 0 : null;
      const wa = split ? at(rows.wa, p.col) || 0 : null;
      const total = rows.total ? at(rows.total, p.col) ?? (split ? ig + wa : 0) : ig + wa;
      if (!total && !ig && !wa) continue;
      const cur = t.projects.get(p.code) || { ig: split ? 0 : null, wa: split ? 0 : null, total: 0 };
      t.projects.set(p.code, {
        ig: split ? cur.ig + ig : null,
        wa: split ? cur.wa + wa : null,
        total: cur.total + total,
      });
    }
    t.ig = split ? totalOf(rows.ig) : 0;
    t.wa = split ? totalOf(rows.wa) : 0;
    t.total = rows.total ? totalOf(rows.total) : t.ig + t.wa;
    if (!split && colIg != null && colWa != null) {
      t.split = true;
      t.ig = colIg;
      t.wa = colWa;
    }
    // The day's Total is Marina's own figure; when her project cells don't
    // add up to it, both are kept and the gap is flagged, rather than one
    // quietly overruling the other.
    const cellSum = [...t.projects.values()].reduce((sum, p) => sum + p.total, 0);
    if (rows.total && at(rows.total, header.totalCol) != null && cellSum !== t.total) {
      t.issue = `the projects add up to ${cellSum}, but the day's Total says ${t.total}`;
    }
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
      if (t) {
        return {
          date: d, total: t.total, ig: t.split ? t.ig : null, wa: t.split ? t.wa : null, recorded: true, future,
          // Tapping a day shows this in the table below the chart.
          projects: [...t.projects].map(([code, p]) => ({ code, ...p }))
            .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
        };
      }
      return { date: d, total: inLog ? 0 : null, ig: inLog ? 0 : null, wa: inLog ? 0 : null, recorded: !!inLog, future, projects: [] };
    });
    const recorded = dailies.filter((d) => d.recorded);
    const dailyTotal = recorded.reduce((s, d) => s + d.total, 0);
    const splitKnown = recorded.length > 0 && recorded.every((d) => d.ig != null);

    const r = w.report;
    const projects = new Map();
    if (r) {
      for (const [code, p] of r.projects) projects.set(code, p);
    } else {
      // A project's split holds for the week only if every day it had leads
      // on carried that project's split. A day split in total but not per
      // project (the IG/WA-columns layout) leaves its projects unsplit, and
      // a project with no leads on a combined day loses nothing by it.
      const logged = daysBetween(w.start, w.end).map((d) => days.get(d)).filter(Boolean);
      for (const t of logged) {
        for (const [code, p] of t.projects) {
          const cur = projects.get(code) || { ig: 0, wa: 0, total: 0, known: true };
          const known = cur.known && p.ig != null && p.wa != null;
          projects.set(code, {
            ig: known ? cur.ig + p.ig : 0,
            wa: known ? cur.wa + p.wa : 0,
            total: cur.total + p.total,
            known,
          });
        }
      }
      for (const [code, p] of projects) {
        projects.set(code, { ig: p.known ? p.ig : null, wa: p.known ? p.wa : null, total: p.total });
      }
    }

    const issues = [];
    if (r && r.ig != null && r.wa != null && r.total != null && r.ig + r.wa !== r.total) {
      issues.push(`In the sheet, IG ${r.ig} + WA ${r.wa} = ${r.ig + r.wa}, but the IG+WA row says ${r.total}`);
    }
    for (const d of daysBetween(w.start, w.end)) {
      const t = days.get(d);
      if (t && t.issue) issues.push(`${shortDate(d)}: ${t.issue}`);
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

// Served by api/sheets.js?name=leads, which fetches the workbook from
// LEADS_SHEET_URL, caches it for `ttl`, and passes it to build().
module.exports = { build, envVar: 'LEADS_SHEET_URL', ttl: CACHE_TTL_MS };
