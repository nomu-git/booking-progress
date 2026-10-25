// The AI Adviser's view of the dashboard (Anton, 15 Oct 2026): one compact
// text snapshot of every tab, built from the dashboard's OWN endpoints over
// HTTP. So the adviser sees exactly what the tabs show, already sanitised
// (Trip Revenue in percentages only, no lead names or phone numbers), and each
// endpoint's cache is reused. Nothing here writes anywhere.

const ENDPOINTS = {
  board: '/api/trips-progress',
  report: '/api/booking-report',
  previous: '/api/previous-trips',
  campaigns: '/api/campaigns',
  leads: '/api/sheets?name=leads',
  engagements: '/api/sheets?name=engagements',
  trips: '/api/sheets?name=trips',
  feedback: '/api/sheets?name=feedback',
  revenue: '/api/sheets?name=revenue',
  impact: '/api/sheets?name=impact',
  pending: '/api/sheets?name=pending',
  kpis: '/api/sheets?name=kpis',
};

const muscatDay = (at) => new Date(Date.parse(at) + 4 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const r1 = (x) => (x == null || !Number.isFinite(Number(x)) ? '-' : String(Math.round(Number(x) * 10) / 10));
const r0 = (x) => (x == null || !Number.isFinite(Number(x)) ? '-' : String(Math.round(Number(x))));
const pct = (x, d = 1) => (x == null || !Number.isFinite(Number(x)) ? '-' : `${(Number(x) * 100).toFixed(d)}%`);
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function fetchAll(base) {
  const out = {};
  await Promise.all(Object.entries(ENDPOINTS).map(async ([k, path]) => {
    try {
      // The login gate (middleware.js) lets the dashboard's own secret through.
      const secret = (process.env.CAMPAIGN_ALERT_SECRET || '').trim();
      const res = await fetch(base + path, { signal: AbortSignal.timeout(45000), headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
      out[k] = await res.json();
    } catch (err) {
      out[k] = { error: err.message };
    }
  }));
  return out;
}

function bookingsFor(events, start, end) {
  let n = 0;
  for (const e of events || []) {
    if (e.x || !e.n) continue;
    const d = muscatDay(e.at);
    if (d >= start && d <= end) n += e.n;
  }
  return n;
}

function summarise(d, today) {
  const L = [];
  const sec = (title) => L.push('', `## ${title}`);
  const failed = (x) => (x && x.error && !Object.keys(x).some((k) => k !== 'error' && k !== 'stale') ? `(not available: ${x.error})` : null);

  L.push(`# NomuHub dashboard snapshot · ${today} (Muscat time, UTC+4) · money in SAR unless stated`);
  L.push('Targets: 12 bookings a week (Sun-Sat); 10 seats per departure week; 20 leads a day; 5 high-potential (HP) leads a day; conversion (bookings ÷ leads, weekly) 10%+; cost per result SAR 25 or less for running campaigns; 3+ posts a week (proposed); artwork ready 7 days before posting.');

  // KPIs
  sec('KPIs (Corporate › KPIs tab): pass / fail');
  const k = d.kpis;
  if (failed(k)) L.push(failed(k));
  else for (const x of k.kpis || []) L.push(`- [${x.status === 'pass' ? 'PASSED' : x.status === 'fail' ? 'FAILED' : 'NOT CHECKED'}] ${x.name} (target ${x.target}): ${x.why}`);
  const cal = k && k.calendar;
  if (cal && cal.posts) {
    L.push('Marketing calendar (monday) posts, today onward plus past ones not ready (artwork due 7 days before):');
    for (const p of cal.posts.slice(0, 40)) L.push(`- ${p.date} ${p.channel}: ${cut(p.name, 70)} · status ${p.status}${p.late ? ' · LATE' : ''}${p.ready ? ' · ready' : ''}`);
  }

  // Bookings board
  sec('Sales › Booking (upcoming departures, seats per week)');
  const b = d.board;
  if (failed(b)) L.push(failed(b));
  else {
    L.push(`Total booked ${b.totalBooked} across ${b.weekCount} departure weeks; ${b.weeksAtTarget} weeks at the 10-seat target.`);
    for (const t of b.trips || []) {
      const weeks = t.weeks.map((w) => `${w.start}: ${w.booked}/${w.unavailable ? 'unavailable' : w.capacity ?? '?'}`).join('; ');
      const open = t.weeks.filter((w) => !w.unavailable);
      const sold = !t.cancelled && open.length && open.every((w) => w.capacity > 0 && w.booked >= w.capacity);
      L.push(`- ${t.name} (${t.start} to ${t.end})${t.cancelled ? ' CANCELLED' : ''}${sold ? ' SOLD OUT' : ''}: ${weeks}${t.cancelledCount ? ` · ${t.cancelledCount} cancelled bookings` : ''}`);
    }
  }

  // Bookings taken
  sec('Sales › Report (bookings taken, by the day they were made; charters excluded)');
  const rp = d.report;
  if (failed(rp)) L.push(failed(rp));
  else {
    const ws = rp.weekStart;
    const weeks = [];
    for (let i = 12; i >= 0; i--) {
      const s = addDays(ws, -7 * i);
      weeks.push(`${s}: ${bookingsFor(rp.events, s, addDays(s, 6))}${i === 0 ? ' (this week so far)' : ''}`);
    }
    L.push(`Weekly bookings (Sun-Sat, target ${rp.weeklyTarget}): ${weeks.join(' | ')}`);
    const since = addDays(today, -60);
    const byTrip = new Map();
    for (const e of rp.events || []) {
      if (e.x || !e.n || muscatDay(e.at) < since) continue;
      byTrip.set(e.t, (byTrip.get(e.t) || 0) + e.n);
    }
    L.push(`Bookings by trip, last 60 days: ${[...byTrip].sort((a, z) => z[1] - a[1]).slice(0, 20).map(([t, n]) => `${cut(t, 50)} ${n}`).join('; ') || 'none'}`);
  }

  // Previous sales
  sec('Sales › Reports › Previous Sales (bookings taken per month, all trips)');
  const pv = d.previous;
  if (failed(pv)) L.push(failed(pv));
  else {
    const months = Object.entries((pv.sales && pv.sales.months) || {}).sort();
    L.push(`Last 36 months: ${months.slice(-36).map(([m, v]) => `${m} ${v.n}`).join(', ')}`);
    const mm = today.slice(5, 7);
    const dayN = Number(today.slice(8, 10));
    const same = months.filter(([m]) => m.slice(5, 7) === mm).map(([m, v]) => `${m.slice(0, 4)}: full ${v.n}, by day ${dayN} ${(v.byDay || []).slice(0, dayN).reduce((a, z) => a + z, 0)}`);
    L.push(`Same month (${mm}) year on year: ${same.join('; ')}`);
    // New vs repeat customers (WeTravel buyer history; repeat = booked 30+ days before).
    const byYear = {};
    for (const [m, v] of months) { const y = m.slice(0, 4); const a = byYear[y] || (byYear[y] = [0, 0]); a[0] += v.n; a[1] += v.rep || 0; }
    L.push(`Repeat customers (a buyer who booked with us 30+ days before, any trip): ${Object.entries(byYear).map(([y, [n, r]]) => `${y} ${r} of ${n} bookings (${n ? Math.round((r / n) * 100) : 0}%)`).join('; ')}. Last 12 months by month (repeat/all): ${months.slice(-12).map(([m, v]) => `${m} ${v.rep || 0}/${v.n}`).join(', ')}`);
    const recent = (pv.trips || []).filter((t) => t.start >= addDays(today, -365)).slice(-40);
    L.push(`Past departures, last 12 months (code or name, dates, booked, cancelled flag): ${recent.map((t) => `${t.code || cut(t.name, 30)} ${t.start} booked ${t.booked}${t.cancelledTrip ? ' CANCELLED' : ''}`).join('; ')}`);
  }

  // Leads
  sec("Sales › Leads (Marina's leads sheet; WA = WhatsApp, IG = Instagram, HP = high potential)");
  const ld = d.leads;
  if (failed(ld)) L.push(failed(ld));
  else {
    L.push(`Note: the leads sheet currently starts in July (earlier quarters are not in the workbook). Year total so far ${ld.totals.leads} leads, ${ld.totals.hp} HP.`);
    for (const w of (ld.weeks || []).slice(-10)) {
      const bk = rp && !rp.error ? bookingsFor(rp.events, w.start, w.end < today ? w.end : today) : null;
      L.push(`- Week ${w.start} to ${w.end}${w.current ? ' (current)' : ''}: ${w.total} leads (WA ${w.wa ?? '-'}, IG ${w.ig ?? '-'}), HP ${w.hp ?? 'not recorded'}${w.hpWa != null ? ` (WA ${w.hpWa}, IG ${w.hpIg})` : ''}${bk != null && w.total ? `, bookings ${bk}, conversion ${pct(bk / w.total)}` : ''}`);
    }
    for (const w of (ld.weeks || []).slice(-2)) {
      L.push(`By project, week ${w.start}: ${(w.projects || []).map((p) => `${p.code} ${p.total}${p.hp ? ` (HP ${p.hp})` : ''}`).join(', ')}`);
      const days = (w.days || []).filter((x) => x.recorded && !x.future);
      if (days.length) L.push(`Days, week ${w.start}: ${days.map((x) => `${x.date} ${x.total} leads / ${x.hp ?? '-'} HP`).join('; ')}`);
    }
  }

  // Campaigns
  sec('Marketing › Campaigns › This year (Meta, year to date)');
  const c = d.campaigns;
  if (failed(c)) L.push(failed(c));
  else {
    const t = c.totals || {};
    L.push(`Year totals: budget ${r0(t.budget)}, spend ${r0(t.spend)} (${pct(t.usedPct)} of budget), results ${r0(t.results)}, cost per result ${r1(t.costPerResult)}. Cost per result limit SAR ${(c.cprLimit || {}).report || 25} for running campaigns. Budgets come from the media plan by project, or an assumed $500 (SAR 1,875) when there is no plan line.`);
    for (const x of (c.campaigns || []).sort((a, z) => z.spend - a.spend)) {
      const q = x.leadQuality;
      L.push(`- ${x.name} [${x.status}${x.status === 'Active' && x.dailyBudget ? `, daily budget ${r0(x.dailyBudget)}` : ''}] objective ${x.objective}; spend ${r0(x.spend)} of budget ${r0(x.budgetSar)}; results ${r0(x.results)}; cost/result ${r1(x.costPerResult)}${x.cprOver ? ' (OVER LIMIT)' : ''}; purchases ${r0(x.purchases)}; impressions ${r0(x.impressions)}${q && q.linked ? `; lead quality ${q.status || '-'}: ${q.leads} project leads, ${q.hp ?? '-'} HP since ${q.since}, cost per HP lead ${r0(q.costPerHp)}` : ''}${q && !q.linked ? '; lead quality not linked (no project in name)' : ''}`);
    }
  }

  // Engagements
  sec("Marketing › Engagements (Maryam's Instagram sheet)");
  const e = d.engagements;
  if (failed(e)) L.push(failed(e));
  else {
    const by = new Map();
    for (const p of e.posts || []) {
      const m = (p.date || '').slice(0, 7);
      const v = by.get(m) || { n: 0, views: 0, inter: 0 };
      v.n++; v.views += p.views || 0; v.inter += p.interactions || 0;
      by.set(m, v);
    }
    L.push(`Per month: ${[...by].sort().map(([m, v]) => `${m} ${v.n} posts, ${v.views} views, engagement ${pct(v.views ? v.inter / v.views : null, 2)}`).join('; ')}`);
    L.push('Posts (date, type, name, views, engagement):');
    for (const p of (e.posts || []).slice().sort((a, z) => (z.date || '').localeCompare(a.date || '')).slice(0, 40)) L.push(`- ${p.date} ${p.type || '-'} "${cut(p.name, 60)}" ${p.views} views, ${pct(p.engagement, 2)}${p.ctaWord ? `, CTA ${p.ctaWord}` : ''}`);
    L.push(`Stories: ${(e.stories || []).map((s) => `${s.date} "${cut(s.name, 40)}" ${s.views} views, ${s.responses ?? '-'} responses`).join('; ') || 'none'}`);
  }

  // Trips & R&D
  sec('Operations › Products (product decisions sheet)');
  const tr = d.trips;
  if (failed(tr)) L.push(failed(tr));
  else {
    L.push(`Totals: ${JSON.stringify(tr.totals)}`);
    for (const p of tr.trips || []) L.push(`- ${p.name} (${p.region}, ${p.category}) quality ${p.quality}, status ${p.status}, ${p.weeks ?? '-'} weeks, price ${p.oldPrice ?? '-'} -> ${p.newPrice ?? '-'} USD${p.rdStatus ? `, R&D ${p.rdStatus}` : ''}${p.analysis ? `. Analysis: ${cut(p.analysis, 220)}` : ''}${p.actions ? `. Actions: ${cut(p.actions, 160)}` : ''}`);
  }

  // Feedback
  sec('Operations › Feedback (trip surveys)');
  const f = d.feedback;
  if (failed(f)) L.push(failed(f));
  else {
    L.push(`Totals: satisfaction ${pct(f.totals.satisfaction)}, trips reported ${f.totals.tripsReported}, responses ${f.totals.responsesCounted}, ${f.totals.comments} comments (${f.totals.escalations} escalated).`);
    for (const t of f.trips || []) {
      const low = (t.scores || []).filter((s) => typeof s.v === 'number').sort((a, z) => a.v - z.v).slice(0, 3).map((s) => `${s.q} ${s.v}`).join(', ');
      L.push(`- ${t.name} ${t.month}: overall ${t.overall ?? '-'} / 5, ${t.responsesText || t.responses} responses${low ? `; lowest: ${low}` : ''}`);
    }
    L.push('Comments (trip, kind, text):');
    for (const x of (f.comments || []).slice(0, 40)) L.push(`- ${cut(x.trip, 40)} · ${x.kind}${x.escalate ? ' · ESCALATED' : ''}: ${cut(x.text, 220)}`);
  }

  // Revenue (percentages only)
  sec('Operations › Performance (trip margins only; amounts are hidden by design)');
  const rv = d.revenue;
  if (failed(rv)) L.push(failed(rv));
  else {
    L.push(`Overall margin ${pct(rv.totals.margin)} over ${rv.totals.trips} trips (${rv.totals.entered} with figures).`);
    L.push(`By month: ${(rv.byMonth || []).map((m) => `${m.key} ${pct(m.margin)} (${m.trips} trips)`).join('; ')}`);
    L.push(`By programme: ${(rv.byProgramme || []).map((m) => `${m.key || m.name} ${pct(m.margin)} (${m.trips} trips)`).join('; ')}`);
    L.push(`Trips: ${(rv.trips || []).map((t) => `${cut(t.name, 40)} ${t.month} ${t.result}${t.margin != null ? ` ${pct(t.margin)}` : ''}`).join('; ')}`);
    L.push(`Sheet suggestions: ${(rv.suggestions || []).map((s) => `[${s.level}] ${s.title}`).join('; ')}`);
  }

  // Impact
  sec('Operations › Impact (community work per trip since 2017)');
  const im = d.impact;
  if (failed(im)) L.push(failed(im));
  else {
    const t = im.totals;
    L.push(`${t.trips} trips ${t.firstYear}-${t.lastYear}; ${t.recorded} with impact recorded (${t.noImpact} had none to record); ${t.toFill} still to fill in (${t.missingTrips} missing trips, ${t.missingImpact} missing impact). ${t.travellers} travellers; ${t.places} schools / villages; ${t.destinations} destinations.`);
    L.push(`Trips per year (Africa / Asia / Other): ${(im.byYear || []).map((r) => `${r.key} ${r.Africa}/${r.Asia}/${r.Other}`).join('; ')}`);
    L.push(`By theme: ${(im.byTheme || []).map((r) => `${r.key} ${r.total}`).join('; ')}`);
    L.push(`By destination: ${(im.byDestination || []).map((r) => `${r.key} ${r.total}`).join('; ')}`);
    L.push('Latest trips:');
    for (const x of (im.trips || []).slice(0, 20)) L.push(`- ${x.year} ${x.destination} ${x.code || ''} · ${x.theme} · ${x.travellers || '?'} travellers · ${x.place || '-'} · ${x.kind === 'fill' ? 'TO FILL' : cut(x.impact || 'no impact', 140)}`);
  }

  // monday
  sec('Corporate › Monday (pending tasks: anything not Done)');
  const m = d.pending;
  if (failed(m)) L.push(failed(m));
  else {
    L.push(`Pending ${m.totals.pending}, overdue ${m.totals.overdue}, unassigned ${m.totals.unassigned}.`);
    for (const i of m.items || []) L.push(`- [${i.workspace}${i.group ? ` · ${i.group}` : ''}] ${cut(i.name, 70)} · ${i.status}${i.people.length ? ` · ${i.people.join(', ')}` : ' · unassigned'}${i.due ? ` · due ${i.due}${i.overdue ? ' OVERDUE' : ''}` : ''}`);
  }
  return L.join('\n');
}

// Cached per warm instance for a few minutes; the dashboard data doesn't move
// faster than that and each rebuild calls every endpoint.
let cache = { at: 0, text: null };
async function buildContext(base, today) {
  if (cache.text && Date.now() - cache.at < 5 * 60 * 1000) return cache.text;
  const text = summarise(await fetchAll(base), today);
  cache = { at: Date.now(), text };
  return text;
}

module.exports = { buildContext, summarise, fetchAll };
