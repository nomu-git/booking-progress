const { apiGet, mapWithConcurrency } = require('../lib/wetravel');
const { classify } = require('../lib/trip-code');

// Which of Marina's lead projects ("ZNZ|BL", "SA|EX", "SL") a trip's bookings
// belong to, so the Leads tab can put bookings beside leads. Her codes are
// mostly the project-code vocabulary in trip-code.js; a few destinations she
// uses aren't on Muatasam's list yet (South Africa, Morocco, AlUla), so
// they're recognised here for this matching only, leaving the shared
// vocabulary (and the project codes built from it) unchanged.
const LEAD_DEST_EXTRA = [
  ['SA', (w) => w.includes('sa') || (w.includes('south') && w.includes('africa'))],
  ['MO', (w) => w.includes('morocco')],
  ['ALAULA', (w) => w.includes('alula') || (w.includes('al') && w.includes('ula'))],
];
function leadProject(trip) {
  const c = classify({ title: trip.title, destination: trip.destination });
  let dest = c.destination;
  if (!dest) {
    const words = String(`${trip.title || ''} ${trip.destination || ''}`).toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const hit = LEAD_DEST_EXTRA.find(([, test]) => test(words));
    dest = hit ? hit[0] : null;
  }
  return { pd: dest || undefined, pg: c.programme || undefined };
}

// Muatasam's sales target: new bookings taken per calendar week, counted
// Sunday to Saturday (his example week ran 9 Aug – 15 Aug 2026, a Sunday start).
// This is separate from the per-trip-week capacity target of 10 on the board.
const WEEKLY_TARGET = Number(process.env.WEEKLY_BOOKING_TARGET || 12);

// How far back to look for trips. A booking is always taken before its trip
// departs, so recently-departed trips still hold recent bookings — the board's
// upcoming-only view misses them.
const LOOKBACK_DAYS = Number(process.env.REPORT_LOOKBACK_DAYS || 300);

const CACHE_TTL_MS = Number(process.env.REPORT_CACHE_TTL_MS || 180000);

// Oman is UTC+4 year-round — no DST to account for. WeTravel's order timestamps
// come back in UTC, so a booking at 22:00 UTC is already the next calendar day
// in Muscat; shifting by this offset before reading Y/M/D turns "UTC clock
// fields" into "Oman clock fields" with no timezone library needed.
const OMAN_OFFSET_MS = 4 * 60 * 60 * 1000;

// Broken or duplicated records that should never reach any view.
const SKIP = new Set(
  (process.env.REPORT_SKIP_UUIDS || '10127626,17245052')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

// Corporate/university charters. Real bookings, but not retail sales, so they're
// counted separately and left out of the target by default.
const CHARTERS = new Set(
  (process.env.CHARTER_TRIP_UUIDS || '8612103268,9638755524,0885576464')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

let cache = { at: 0, payload: null };

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+\)/g, ')').trim();

function productName(title) {
  let name = String(title || '').trim();
  name = name.replace(/\s*-?\s*\/\s*\d{1,2}\s+[A-Za-z]+\.?\s*[-–]\s*\d{1,2}\s+[A-Za-z]+\.?\s*/g, ' ');
  name = name.replace(/\s*\(\s*\d{1,2}\s+[A-Za-z]+\.?\s*[-–]\s*\d{1,2}\s+[A-Za-z]+\.?\s*\)/g, ' ');
  name = name.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*20\d{2}\b/gi, ' ');
  name = name.replace(/\b20\d{2}\b/g, ' ');
  name = name.replace(/\s*[-–|]\s*$/, '').replace(/^\s*[-–|]\s*/, '');
  name = name.replace(/\s*[-–]\s*/g, ' | ').replace(/\s*\|\s*/g, ' | ');
  return name.replace(/\s+/g, ' ').trim() || String(title || '').trim();
}

const dayKey = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

async function fetchOrders(tripUuid) {
  const orders = [];
  for (let page = 1; page <= 20; page++) {
    const body = await apiGet(`/bookings/trips/${tripUuid}/bookings?page=${page}`);
    orders.push(...(body.data || []));
    if (!(body.pagination && body.pagination.has_next)) break;
  }
  return orders;
}

async function build() {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);

  const allTrips = (await apiGet('/draft_trips?per_page=1000&page=1&exclude_payment_links=true')).data || [];

  const scanned = allTrips.filter((t) => {
    if (SKIP.has(String(t.uuid))) return false;
    const start = dayKey(t.start_date);
    const end = dayKey(t.end_date) || start;
    return start && end >= cutoff;
  });

  const perTrip = await mapWithConcurrency(scanned, 4, async (trip) => {
    try {
      return { trip, orders: await fetchOrders(trip.uuid) };
    } catch (err) {
      console.error(`report: bookings failed for ${trip.uuid}: ${err.message}`);
      return { trip, orders: [] };
    }
  });

  // One entry per order, stamped with when the booking was actually taken.
  // The browser buckets these by day/week/month so filters cost nothing.
  const events = [];
  for (const { trip, orders } of perTrip) {
    const name = productName(trip.title);
    const charter = CHARTERS.has(String(trip.uuid));
    const proj = leadProject(trip);
    for (const order of orders) {
      const at = Date.parse(order.created_at);
      if (!Number.isFinite(at) || at > nowMs) continue;
      const active = order.active_count || 0;
      const cancelled = order.cancelled_count || 0;
      const rebooked = order.rebooked_count || 0;
      if (active === 0 && cancelled === 0 && rebooked === 0) continue;
      events.push({
        at: order.created_at,
        n: active,
        c: cancelled,
        r: rebooked,
        t: name,
        u: trip.uuid,
        x: charter || undefined,
        // Destination / programme codes, for matching against lead projects.
        pd: proj.pd,
        pg: proj.pg,
      });
    }
  }

  events.sort((a, b) => a.at.localeCompare(b.at));

  // "Today" and the week boundary are both read off Oman's calendar, not the
  // server's UTC clock — this is what decides which bucket a late-night booking
  // falls into.
  const nowOman = new Date(nowMs + OMAN_OFFSET_MS);
  const weekStartOman = new Date(Date.UTC(
    nowOman.getUTCFullYear(), nowOman.getUTCMonth(), nowOman.getUTCDate() - nowOman.getUTCDay()
  ));

  return {
    asOf: new Date(nowMs).toISOString(),
    today: nowOman.toISOString().slice(0, 10),
    weekStart: weekStartOman.toISOString().slice(0, 10),
    timezone: 'Asia/Muscat (UTC+4)',
    weeklyTarget: WEEKLY_TARGET,
    lookbackDays: LOOKBACK_DAYS,
    tripsScanned: scanned.length,
    events,
  };
}

// TEMPORARY (21 Oct 2026, "1 booking today isn't showing"): every order
// created in the last 2 days across ALL trips, payment links included, with
// counts and status only (no names, emails or amounts). Secret-gated; remove
// once the missing booking is explained.
async function audit(hours) {
  const since = Date.now() - hours * 3600e3;
  const trips = (await apiGet('/draft_trips?per_page=1000&page=1')).data || [];
  const recent = trips.filter((t) => !t.end_date || dayKey(t.end_date) >= '2026-01-01' || /payment/i.test(t.title || ''));
  const out = [];
  await mapWithConcurrency(recent, 4, async (trip) => {
    let orders = [];
    try { orders = await fetchOrders(trip.uuid); } catch (e) { out.push({ trip: trip.title, uuid: trip.uuid, error: e.message }); return; }
    for (const o of orders) {
      const at = Date.parse(o.created_at);
      if (!(at >= since)) continue;
      out.push({
        trip: trip.title, uuid: trip.uuid, paymentLink: !!(trip.is_payment_link || trip.payment_link || /payment/i.test(trip.title || '')),
        scannedByReport: !SKIP.has(String(trip.uuid)),
        created_at: o.created_at, active: o.active_count, cancelled: o.cancelled_count, rebooked: o.rebooked_count,
        status: o.status || o.state || null, payment_status: o.payment_status || null,
        fields: Object.keys(o).filter((k) => !/name|email|phone|address|passport|birth|amount|price|total|paid|balance|note/i.test(k)),
      });
    }
  });
  const flags = trips.slice(0, 1).map((t) => Object.keys(t));
  return { hours, tripsListed: trips.length, tripsChecked: recent.length, tripFields: flags[0], orders: out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) };
}

module.exports = async (req, res) => {
  try {
    if (req.query && req.query.audit === '1') {
      const secret = (process.env.CAMPAIGN_ALERT_SECRET || '').trim();
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'secret required' });
      return res.status(200).json(await audit(Math.min(240, Number(req.query.hours) || 48)));
    }
    const fresh = req.query && req.query.refresh === '1';
    if (!fresh && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cache.payload);
    }
    const payload = await build();
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

// Exposed so the scheduled Slack notifier can reuse this exact scan rather than
// keeping a second, drifting copy of the same WeTravel logic.
module.exports.build = build;
module.exports.leadProject = leadProject;
