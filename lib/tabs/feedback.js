// Feedback tab: the "2026 Feedback" workbook (trip survey results), read live
// from its SharePoint share link (FEEDBACK_SHEET_URL). Same approach as Leads,
// Engagements and Trips: whoever keeps the workbook carries on as they do,
// and the tab mirrors it.
//
// Two tabs are read, found by what's in them rather than their names or
// positions:
//   - Summary: year-to-date satisfaction and one row per surveyed trip,
//     under month headings ("Aug 2026").
//   - By Programme: a block per survey template (Building / Medical,
//     Teaching, Wellness, Explorer), each a table of per-question scores,
//     then "what people wrote" (every comment, verbatim), then an itinerary
//     table scoring each named hotel and excursion.
// Its Coverage Gaps tab (trips with no survey) isn't read: the dashboard
// dropped that view.
//
// Every comment is sent verbatim, including the ones the sheet marks
// ESCALATE (flagged as such). Those were held back at first, since the sheet
// says to escalate them outside the dashboard and the site is public; Anton
// chose to show them (30 Sep 2026). The sheet's "Notes" bullets aren't sent:
// they're working notes on method, and nothing on the page uses them.

const CACHE_TTL_MS = Number(process.env.FEEDBACK_CACHE_TTL_MS || 60000);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cells = (row) => (row || []).map(text);
const filled = (row) => cells(row).filter(Boolean);

// "Aug 2026" -> "2026-08"; anything else -> null.
const MONTH_RE = /^([A-Za-z]{3})[a-z]* (\d{4})$/;
function monthKey(label) {
  const m = MONTH_RE.exec(text(label));
  if (!m) return null;
  const i = MONTHS.indexOf(m[1].toLowerCase());
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`;
}

// A heading row is a single filled cell.
const single = (row) => (filled(row).length === 1 ? text((row || []).find((v) => text(v))) : null);

// "2 / 3" -> { responses: 2, travellers: 3 }; "5 / 1" or "0 / N/A" kept as
// text too, since the sheet uses N/A where the traveller count is unknown.
function responses(v) {
  const m = /^(\d+)\s*\/\s*(\d+|n\/a)$/i.exec(text(v));
  return {
    responses: m ? Number(m[1]) : null,
    travellers: m && /^\d+$/.test(m[2]) ? Number(m[2]) : null,
    responsesText: text(v) || null,
  };
}

// "Trip name, Aug 2026" plus whatever follows: the comment headings
// ("..., Aug 2026      (7 comments · 1 suggestion)"), a no-feedback line
// ("..., Feb 2026  —  No written feedback: ...") and the itinerary labels.
// The trip name can itself contain " — ", so the month is the anchor.
function tripHeading(s) {
  const m = /^(.*?), ([A-Z][a-z]{2} \d{4})(?:\s+\((.*)\)|\s+—\s+(.*))?$/.exec(text(s));
  if (!m) return null;
  return { name: m[1].trim(), month: monthKey(m[2]), counts: m[3] || null, note: m[4] || null };
}

const tripId = (name, month) => `${text(name).toLowerCase()}|${month}`;

// The next row with anything in it, as text cells.
function nextRow(grid, r) {
  for (let k = r + 1; k < grid.length; k++) if (filled(grid[k]).length) return cells(grid[k]);
  return [];
}

function readSummary(grid) {
  const out = { kpis: [], trips: [] };
  for (let r = 0; r < grid.length; r++) {
    const row = cells(grid[r]);
    // KPI labels sit in capitals with their values on the row beneath.
    if (row.some((v) => /satisfaction/i.test(v)) && row.filter(Boolean).every((v) => v === v.toUpperCase())) {
      const vals = grid[r + 1] || [];
      row.forEach((label, c) => { if (label) out.kpis.push({ label, value: vals[c] ?? null }); });
    }
    if (row[0] === 'Trip' && row.some((v) => /^responses/i.test(v))) {
      const col = (re) => row.findIndex((v) => re.test(v));
      const c = {
        rs: col(/^responses/i), rate: col(/^response rate/i), overall: col(/^overall/i),
        sat: col(/^satisfaction/i), programme: col(/^programme/i),
      };
      let month = null;
      for (let k = r + 1; k < grid.length; k++) {
        const g = grid[k] || [];
        const head = single(g);
        if (head && monthKey(head)) { month = monthKey(head); continue; }
        if (head && /^notes$/i.test(head)) break;
        if (!text(g[0]) || !month) continue;
        out.trips.push({
          name: text(g[0]),
          month,
          ...responses(g[c.rs]),
          responseRate: num(g[c.rate]),
          overall: num(g[c.overall]),
          satisfaction: num(g[c.sat]),
          programme: c.programme >= 0 ? text(g[c.programme]) || null : null,
        });
      }
      break;
    }
  }
  return out;
}

// The columns every programme table starts with. Matched whole: "Trip" is a
// fixed column but "Trip Manual / On-boarding Pack" is a question, and a
// prefix match silently dropped it.
const FIXED = /^(trip|month|responses\b.*|response rate|overall\b.*|satisfaction\b.*)$/i;

function readProgrammes(grid) {
  const programmes = [];
  const scored = new Map(); // tripId -> { template, scores, facts }
  const comments = [];
  const quiet = new Map(); // tripId -> "No written feedback: ..."
  const items = new Map(); // tripId -> [{ item, type, score }]
  let current = null; // programme block
  let mode = null; // 'scores' | 'comments' | 'items' | 'notes'
  let header = null;
  let trip = null; // tripId for comments/items

  for (let r = 0; r < grid.length; r++) {
    const g = grid[r] || [];
    const row = cells(g);
    const head = single(g);
    if (!row.some(Boolean)) continue;

    if (row[0] === 'Trip' && row[1] === 'Month') {
      header = row;
      mode = 'scores';
      // The survey's questions in the sheet's order, for the Ratings view's
      // question-by-trip table.
      if (current) current.questions = row.filter((q) => q && !FIXED.test(q));
      continue;
    }
    // A programme block starts with its name on the line above a Trip/Month
    // table header.
    const after = nextRow(grid, r);
    if (head && after[0] === 'Trip' && after[1] === 'Month') {
      current = { name: head, summary: null, questions: [] };
      programmes.push(current);
      mode = null;
      continue;
    }
    if (row[0] === 'Item' && row[1] === 'Type') { mode = 'items'; trip = null; continue; }
    if (head && /^notes$/i.test(head)) { mode = 'notes'; continue; }

    if (head && /—\s*what people wrote$/i.test(head)) {
      const name = head.replace(/\s*—\s*what people wrote$/i, '').trim();
      current = programmes.find((p) => p.name === name) || current;
      mode = 'comments';
      trip = null;
      // The line under the heading is the sheet's own summary of the asks.
      const next = single(grid[r + 1]);
      if (current && next && !tripHeading(next)) { current.summary = next; r++; }
      continue;
    }

    if (head && head.startsWith('•')) continue;

    if (mode === 'items') {
      const th = head && tripHeading(head);
      if (th) { trip = tripId(th.name, th.month); items.set(trip, []); continue; }
      if (trip && row[0]) items.get(trip).push({ item: row[0], type: row[1] || null, score: num(g[2]) });
      continue;
    }

    if (mode === 'comments') {
      const th = head && tripHeading(head);
      if (th) {
        trip = tripId(th.name, th.month);
        if (th.note) quiet.set(trip, th.note);
        continue;
      }
      if (trip && row[0] && row[1]) {
        // "Concern — Other comments — ESCALATE", "Praise — Ops team (Salim)"
        const parts = row[0].split(/\s+—\s+/);
        const escalate = parts.some((x) => /^escalate$/i.test(x));
        const kind = parts[0];
        const source = parts.slice(1).filter((x) => !/^escalate$/i.test(x)).join(' — ') || null;
        comments.push({ trip, kind, source, escalate, text: row[1] });
      }
      continue;
    }

    if (mode === 'scores' && header && row[0] && current) {
      const scores = [];
      const facts = [];
      // "Not asked" (not on this trip's form) is kept apart from "—" (no
      // answer yet), so the Ratings table can say which it is.
      const notAsked = [];
      header.forEach((q, c) => {
        if (!q || FIXED.test(q)) return;
        const v = g[c];
        if (num(v) != null) scores.push({ q, v: num(v) });
        else if (/^not asked$/i.test(text(v))) notAsked.push(q);
        else if (text(v) && text(v) !== '—') facts.push({ q, text: text(v) });
      });
      scored.set(tripId(row[0], monthKey(row[1])), { template: current.name, scores, facts, notAsked });
    }
  }
  return { programmes, scored, comments, quiet, items };
}

function build(sheets) {
  const find = (test) => sheets.find((s) => s.grid.some((row) => test(cells(row))));
  const summarySheet = find((row) => row.some((v) => /year-to-date satisfaction/i.test(v)));
  const byProgSheet = find((row) => row.some((v) => /—\s*what people wrote$/i.test(v)));
  if (!summarySheet) throw new Error('No tab with a YEAR-TO-DATE SATISFACTION figure found in the feedback workbook');

  const summary = readSummary(summarySheet.grid);
  const prog = byProgSheet ? readProgrammes(byProgSheet.grid) : { programmes: [], scored: new Map(), comments: [], quiet: new Map(), items: new Map() };

  const trips = summary.trips.map((t) => {
    const id = tripId(t.name, t.month);
    const s = prog.scored.get(id) || {};
    const mine = prog.comments.filter((c) => c.trip === id);
    return {
      id,
      ...t,
      template: s.template || null,
      scores: s.scores || [],
      facts: s.facts || [],
      notAsked: s.notAsked || [],
      items: prog.items.get(id) || [],
      comments: mine.length,
      escalations: mine.filter((c) => c.escalate).length,
      noComments: prog.quiet.get(id) || null,
    };
  });
  // A trip that's only in By Programme (added there first) still shows.
  for (const [id, s] of prog.scored) {
    if (trips.some((t) => t.id === id)) continue;
    const [name, month] = id.split('|');
    trips.push({ id, name, month, template: s.template, programme: s.template, scores: s.scores, facts: s.facts, notAsked: s.notAsked, items: prog.items.get(id) || [], comments: 0, escalations: 0, noComments: null });
  }
  trips.sort((a, b) => b.month.localeCompare(a.month));

  const kpi = (re) => summary.kpis.find((k) => re.test(k.label)) || null;
  const nameOf = new Map(trips.map((t) => [t.id, t.name]));

  return {
    asOf: new Date().toISOString(),
    totals: {
      satisfaction: num(kpi(/satisfaction/i)?.value),
      tripsReported: kpi(/trips reported/i) ? text(kpi(/trips reported/i).value) : null,
      responsesCounted: kpi(/responses/i) ? text(kpi(/responses/i).value) : null,
      comments: prog.comments.length,
      escalations: prog.comments.filter((c) => c.escalate).length,
    },
    trips,
    programmes: prog.programmes,
    comments: prog.comments.map((c) => ({ ...c, tripName: nameOf.get(c.trip) || c.trip.split('|')[0], month: c.trip.split('|')[1] })),
  };
}

// Served by api/sheets.js?name=feedback, which fetches the workbook from
// FEEDBACK_SHEET_URL, caches it for `ttl`, and passes it to build().
module.exports = { build, envVar: 'FEEDBACK_SHEET_URL', ttl: CACHE_TTL_MS };
