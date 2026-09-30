// Trips tab: the "NomuHub Trip Decision Dashboard" workbook ("which products
// to grow, optimise, or stop"), read live from its SharePoint share link
// (TRIPS_SHEET_URL). Same approach as Leads and Engagements: the team keeps
// the workbook as they do now, and the tab mirrors it.
//
// The master tab ("Trip Dashboard 2026", one row per trip product) is the
// source. Its "Executive Summary" tab is formulas over that same list, so
// the counts are recomputed here from the rows rather than scraped from the
// summary's layout, which moves whenever someone rearranges it. The one
// thing taken from the summary is its own wording for what each quality
// rating means and what to do with it, so the tab says what the team wrote
// and picks up their edits.

const { fetchWorkbook } = require('../lib/sheet');

const CACHE_TTL_MS = Number(process.env.TRIPS_CACHE_TTL_MS || 60000);

const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A header like "REGION\r\n(ASIA or AFRICA or EUROPE or GCC)" -> "region":
// the name before its explanation, so the columns are found by what they
// are, not where they sit.
const headName = (v) => text(String(v == null ? '' : v).split(/[\r\n(]/)[0]).toLowerCase();

const COLS = {
  no: /^no\b/, name: /^trip name/, category: /^trip category/, region: /^region/,
  destination: /^destination/, pic: /^operations manager/, weeks: /^number of trip/,
  days: /^duration/, year: /^year/, oldPrice: /^existing pricing/, newPrice: /^new pricing/,
  priceChange: /^price change/, quality: /^quality/, status: /^product status/,
  rdStatus: /^r&d status/, rdNext: /^r&d next step/, needsUpdate: /^requires update/,
  analysis: /^detailed analysis/, actions: /^corrective actions/, notes: /^additional notes/,
  profit: /^profit/,
};

// The sheet's own words, used only if its summary tables can't be found.
// Two different texts per rating: the quality guide's longer "what we do
// with the calendar", and the short per-trip "calendar decision" from its
// all-products table.
const QUALITY = ['High', 'Medium', 'Low', 'R&D'];
const DEFAULT_GUIDE = {
  High: { meaning: 'Strong seller. We can sell a lot of these.', whatToDo: 'Keep repeating it and improve the operations around it.', decision: 'Repeat and scale — protect these weeks' },
  Medium: { meaning: 'Sells, but is not yet a strong performer.', whatToDo: 'Worth optimising and building up.', decision: 'Optimise and build it up' },
  Low: { meaning: 'Weak product. Hard to fill.', whatToDo: 'Run it rarely or drop it, and free up the weeks.', decision: 'Run rarely or drop it' },
  'R&D': { meaning: 'Not launched yet. Still in research.', whatToDo: 'Finish the R&D before the year is locked in.', decision: 'Finish R&D before the calendar is locked' },
};
const NOT_RATED = { meaning: 'No rating set, so it cannot be judged at a glance.', whatToDo: 'Give it a rating so it stops being invisible.', decision: 'Give it a rating' };

// "N/A", "-" and blanks all mean "nothing written here".
const blank = (v) => !text(v) || /^(n\/?a|-|—)$/i.test(text(v));
const orNull = (v) => (blank(v) ? null : text(v));

const qualityKey = (v) => QUALITY.find((q) => q.toLowerCase() === text(v).toLowerCase()) || null;

// Reads the summary's wording where it can find it: the quality guide (a
// "Rating" header with "What it means" and "What we do" columns) and the
// all-products table (a "Quality" header beside "Calendar decision"). Each
// is optional; the defaults above stand in for whatever isn't there.
function readGuide(sheets) {
  const guide = JSON.parse(JSON.stringify(DEFAULT_GUIDE));
  for (const s of sheets) {
    for (let r = 0; r < s.grid.length; r++) {
      const row = (s.grid[r] || []).map(text);
      const rating = row.findIndex((v) => /^rating$/i.test(v));
      const meaning = row.findIndex((v) => /what it means/i.test(v));
      const todo = row.findIndex((v) => /what we do/i.test(v));
      if (rating >= 0 && meaning >= 0) {
        for (let k = r + 1; k < s.grid.length && text((s.grid[k] || [])[rating]); k++) {
          const q = qualityKey(s.grid[k][rating]);
          if (!q) continue;
          if (text(s.grid[k][meaning])) guide[q].meaning = text(s.grid[k][meaning]);
          if (todo >= 0 && text(s.grid[k][todo])) guide[q].whatToDo = text(s.grid[k][todo]);
        }
      }
      const quality = row.findIndex((v) => /^quality$/i.test(v));
      const decision = row.findIndex((v) => /calendar decision/i.test(v));
      if (quality >= 0 && decision >= 0) {
        const seen = new Set();
        for (let k = r + 1; k < s.grid.length && (s.grid[k] || []).some((v) => text(v)); k++) {
          const q = qualityKey(s.grid[k][quality]);
          if (q && !seen.has(q) && text(s.grid[k][decision])) { guide[q].decision = text(s.grid[k][decision]); seen.add(q); }
        }
      }
    }
  }
  return guide;
}

function build(sheets) {
  // The master tab is whichever has a header row carrying both TRIP NAME and
  // QUALITY; the header sits a few rows down, under a title block.
  let master = null;
  let headerRow = -1;
  for (const s of sheets) {
    for (let r = 0; r < Math.min(12, s.grid.length); r++) {
      const names = (s.grid[r] || []).map(headName);
      if (names.includes('trip name') && names.some((n) => n.startsWith('quality'))) { master = s; headerRow = r; break; }
    }
    if (master) break;
  }
  if (!master) throw new Error('No tab with a TRIP NAME / QUALITY header found in the trips workbook');

  const names = master.grid[headerRow].map(headName);
  const col = {};
  for (const [key, re] of Object.entries(COLS)) col[key] = names.findIndex((n) => re.test(n));
  const cell = (row, key) => (col[key] >= 0 ? row[col[key]] : null);

  const trips = [];
  for (const row of master.grid.slice(headerRow + 1)) {
    const name = text(cell(row, 'name'));
    if (!name) continue;
    const quality = qualityKey(cell(row, 'quality')) || orNull(cell(row, 'quality'));
    trips.push({
      no: text(cell(row, 'no')) || null,
      name,
      category: orNull(cell(row, 'category')),
      region: orNull(cell(row, 'region')),
      destination: orNull(cell(row, 'destination')),
      pic: orNull(cell(row, 'pic')),
      weeks: count(cell(row, 'weeks')),
      days: count(cell(row, 'days')),
      year: count(cell(row, 'year')),
      oldPrice: count(cell(row, 'oldPrice')),
      newPrice: count(cell(row, 'newPrice')),
      priceChange: count(cell(row, 'priceChange')),
      quality,
      status: orNull(cell(row, 'status')),
      rdStatus: orNull(cell(row, 'rdStatus')),
      rdNext: orNull(cell(row, 'rdNext')),
      needsUpdate: orNull(cell(row, 'needsUpdate')),
      analysis: orNull(cell(row, 'analysis')),
      actions: orNull(cell(row, 'actions')),
      notes: orNull(cell(row, 'notes')),
      profit: count(cell(row, 'profit')) ?? orNull(cell(row, 'profit')),
    });
  }

  const guide = readGuide(sheets);
  for (const t of trips) t.decision = (guide[t.quality] || NOT_RATED).decision;

  const weeksOf = (list) => list.reduce((s, t) => s + (t.weeks || 0), 0);
  const totalWeeks = weeksOf(trips);
  const byQuality = [...QUALITY, null].map((q) => {
    const list = trips.filter((t) => (q ? t.quality === q : !QUALITY.includes(t.quality)));
    return {
      quality: q || 'Not rated',
      trips: list.length,
      weeks: weeksOf(list),
      share: totalWeeks ? weeksOf(list) / totalWeeks : 0,
      meaning: (q ? guide[q] : NOT_RATED).meaning,
      whatToDo: (q ? guide[q] : NOT_RATED).whatToDo,
    };
  });

  const regions = [...new Set(trips.map((t) => t.region).filter(Boolean))];
  const REGION_ORDER = ['Africa', 'Asia', 'Europe', 'GCC'];
  regions.sort((a, b) => ((REGION_ORDER.indexOf(a) + 1 || 99) - (REGION_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  const byRegion = regions.map((region) => {
    const list = trips.filter((t) => t.region === region);
    const out = { region, trips: list.length, weeks: weeksOf(list) };
    for (const q of QUALITY) {
      out[q] = list.filter((t) => t.quality === q).length;
      out[`${q}Weeks`] = weeksOf(list.filter((t) => t.quality === q));
    }
    return out;
  });

  return {
    asOf: new Date().toISOString(),
    sheet: master.name,
    guide,
    totals: {
      trips: trips.length,
      weeks: totalWeeks,
      ...Object.fromEntries(QUALITY.map((q) => [q, trips.filter((t) => t.quality === q).length])),
    },
    byQuality,
    byRegion,
    rd: trips.filter((t) => t.status === 'R&D' || t.quality === 'R&D'),
    trips,
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
    const payload = build(await fetchWorkbook('TRIPS_SHEET_URL'));
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
