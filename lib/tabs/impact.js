// Impact tab (Operations), Anton, 20 Oct 2026: the "NomuHub Impact
// Dashboard" workbook on SharePoint, from IMPACT_SHEET_URL. It logs every trip
// since 2017 with the community work it did: where, which school or village,
// how many travellers, who led it and what was built, taught or treated.
//
// Region tabs (Africa, Asia, Other Regions) are found by their header row
// (No. | Year | Region | Destination | Trip Code | ... | Status), not their
// names, so a new region tab is picked up by itself. Counts are recomputed
// from the rows; they match the workbook's own Summary tab (checked 20 Oct
// 2026: 193 trips, 174 with impact recorded, every year and theme row).
//
// Status: "Recorded" (and "Recorded (recovered ...)") = impact written up;
// "No impact" = the trip had none to record (Explore, Wellness), which the
// sheet's Summary counts as recorded; "... to fill" = a missing trip or a
// missing impact description the team still has to fill in. "Possible
// duplicate" rows are left out of every count, as the Summary does.

const CACHE_TTL_MS = Number(process.env.IMPACT_CACHE_TTL_MS || 300000);

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).toLowerCase();

// Dates come as ISO (real Excel dates) or typed "21/10/2023" / "28/8/24".
// A date the sheet has clearly mistyped (before 2015) is dropped, not shown.
function day(v) {
  const s = norm(v);
  if (!s || s === 'None') return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  let out = null;
  if (m) out = `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    out = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return out && out >= '2015' ? out : null;
}
const num = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const text = (v) => { const s = norm(v); return !s || s === 'None' ? null : s; };

function statusKind(s) {
  const k = key(s);
  if (/duplicate/.test(k)) return 'duplicate';
  if (/no impact/.test(k)) return 'none';
  if (/to fill|missing/.test(k)) return 'fill';
  if (/recorded/.test(k)) return 'recorded';
  return 'other';
}
// Africa / Asia, and everything else (Europe, Middle East, "To confirm") as Other.
const regionGroup = (r) => (/africa/i.test(r) ? 'Africa' : /asia/i.test(r) ? 'Asia' : 'Other');

function build(wb) {
  const trips = [];
  for (const sheet of wb) {
    const grid = sheet.grid || [];
    const hi = grid.findIndex((row) => (row || []).some((c) => key(c) === 'impact description') && (row || []).some((c) => key(c) === 'status'));
    if (hi < 0) continue;
    const head = grid[hi].map(key);
    const col = (name) => head.indexOf(name);
    const C = {
      no: col('no.'), year: col('year'), region: col('region'), dest: col('destination'), code: col('trip code'),
      client: col('client'), type: col('trip type'), theme: col('theme'), start: col('start'), end: col('end'),
      travellers: col('travellers'), officer: col('officer in charge'), place: col('village / school'),
      impact: col('impact description'), status: col('status'),
    };
    for (const row of grid.slice(hi + 1)) {
      const at = (i) => (i >= 0 ? row[i] : null);
      const year = num(at(C.year));
      if (!year || !text(at(C.status))) continue;
      const region = text(at(C.region)) || sheet.name;
      trips.push({
        id: `${sheet.name}:${norm(at(C.no))}`,
        year,
        region,
        group: regionGroup(region === 'To confirm' ? sheet.name : region),
        destination: text(at(C.dest)) || 'To confirm',
        code: text(at(C.code)),
        client: text(at(C.client)),
        type: text(at(C.type)),
        theme: text(at(C.theme)) || 'To confirm',
        start: day(at(C.start)),
        end: day(at(C.end)),
        travellers: num(at(C.travellers)),
        officer: text(at(C.officer)),
        place: text(at(C.place)),
        impact: text(at(C.impact)),
        status: text(at(C.status)),
        kind: statusKind(at(C.status)),
      });
    }
  }
  const counted = trips.filter((t) => t.kind !== 'duplicate');
  counted.sort((a, b) => b.year - a.year || String(b.start || '').localeCompare(String(a.start || '')));

  const GROUPS = ['Africa', 'Asia', 'Other'];
  const tally = (keyOf) => {
    const m = new Map();
    for (const t of counted) {
      const k = keyOf(t);
      const r = m.get(k) || { key: k, Africa: 0, Asia: 0, Other: 0, total: 0, recorded: 0, travellers: 0 };
      r[t.group] += 1;
      r.total += 1;
      if (t.kind === 'recorded' || t.kind === 'none') r.recorded += 1;
      r.travellers += t.travellers || 0;
      m.set(k, r);
    }
    return [...m.values()];
  };
  const places = new Set(counted.filter((t) => t.place).map((t) => key(t.place).replace(/[^a-z0-9 ]/g, '')));
  const years = counted.map((t) => t.year);
  return {
    asOf: new Date().toISOString(),
    groups: GROUPS,
    totals: {
      trips: counted.length,
      recorded: counted.filter((t) => t.kind === 'recorded' || t.kind === 'none').length,
      withImpact: counted.filter((t) => t.kind === 'recorded').length,
      noImpact: counted.filter((t) => t.kind === 'none').length,
      toFill: counted.filter((t) => t.kind === 'fill').length,
      missingTrips: counted.filter((t) => t.kind === 'fill' && /missing trip/i.test(t.status)).length,
      missingImpact: counted.filter((t) => t.kind === 'fill' && !/missing trip/i.test(t.status)).length,
      travellers: counted.reduce((a, t) => a + (t.travellers || 0), 0),
      places: places.size,
      destinations: new Set(counted.map((t) => t.destination).filter((d) => d !== 'To confirm')).size,
      firstYear: years.length ? Math.min(...years) : null,
      lastYear: years.length ? Math.max(...years) : null,
    },
    byYear: tally((t) => t.year).sort((a, b) => a.key - b.key),
    byTheme: tally((t) => t.theme).sort((a, b) => b.total - a.total),
    byDestination: tally((t) => t.destination).sort((a, b) => b.total - a.total),
    trips: counted,
  };
}

module.exports = { build, envVar: 'IMPACT_SHEET_URL', ttl: CACHE_TTL_MS };
