// Departed trips, most recent first — the counterpart to trips-progress.js,
// which only shows what's still upcoming. Same WeTravel data, opposite half
// of the calendar.

const { apiGet, mapWithConcurrency } = require('./wetravel');

const CACHE_TTL_MS = Number(process.env.PREVIOUS_TRIPS_CACHE_TTL_MS || 300000);

// Broken or duplicated records — same list booking-report.js keeps out of
// every view, since a bad record isn't a real departure to show anyone.
const EXCLUDED = new Set(
  (process.env.REPORT_SKIP_UUIDS || '10127626,17245052')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

// Corporate/charter departures — shown, but flagged, so they can be told
// apart from retail trips rather than hidden outright.
const CHARTERS = new Set(
  (process.env.CHARTER_TRIP_UUIDS || '8612103268,9638755524,0885576464')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

let cache = { at: 0, payload: null };

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+\)/g, ')').trim();

// Trip titles carry departure dates and a season stamp, both shown elsewhere
// as their own fields, so the label here is just the product.
function productName(title) {
  let name = String(title || '').trim();
  name = name.replace(/\s*-?\s*\/\s*\d{1,2}\s+[A-Za-z]+\.?\s*[-–]\s*\d{1,2}\s+[A-Za-z]+\.?\s*/g, ' ');
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

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "Week 2 (05 Jul - 11 Jul)" carries no year, so anchor it to the trip it
// belongs to. Same logic trips-progress.js uses for the live board — kept in
// sync there rather than shared, since the two files read different data.
function weekDates(packageName, trip) {
  const m = String(packageName || '')
    .match(/\((\d{1,2})\s*([A-Za-z]{3,})\.?\s*[-–]\s*(\d{1,2})\s*([A-Za-z]{3,})\.?\s*\)/);
  const tripStart = new Date(trip.start_date);
  if (!m || Number.isNaN(tripStart.getTime())) {
    return { start: dayKey(trip.start_date), end: dayKey(trip.end_date) || dayKey(trip.start_date) };
  }
  const [, d1, mo1, d2, mo2] = m;
  const m1 = MONTHS[mo1.slice(0, 3).toLowerCase()];
  const m2 = MONTHS[mo2.slice(0, 3).toLowerCase()];
  if (m1 == null || m2 == null) {
    return { start: dayKey(trip.start_date), end: dayKey(trip.end_date) || dayKey(trip.start_date) };
  }
  let year = tripStart.getUTCFullYear();
  let start = new Date(Date.UTC(year, m1, Number(d1)));
  if (start.getTime() < tripStart.getTime() - 45 * 864e5) {
    year += 1;
    start = new Date(Date.UTC(year, m1, Number(d1)));
  }
  let end = new Date(Date.UTC(year, m2, Number(d2)));
  if (end.getTime() < start.getTime()) end = new Date(Date.UTC(year + 1, m2, Number(d2)));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// Oman is UTC+4 year-round — "has this departed?" is judged on Muscat's
// calendar day, same as the dashboard and report.
const OMAN_OFFSET_MS = 4 * 60 * 60 * 1000;
const omanToday = () => new Date(Date.now() + OMAN_OFFSET_MS).toISOString().slice(0, 10);

async function listAllTrips() {
  const trips = [];
  for (let page = 1; page <= 10; page++) {
    const body = await apiGet(`/draft_trips?per_page=1000&page=${page}&exclude_payment_links=true`);
    trips.push(...(body.data || []));
    if (!(body.pagination && body.pagination.has_next)) break;
  }
  return trips;
}

async function fetchOrders(tripUuid) {
  const orders = [];
  for (let page = 1; page <= 20; page++) {
    const body = await apiGet(`/bookings/trips/${tripUuid}/bookings?page=${page}`);
    orders.push(...(body.data || []));
    if (!(body.pagination && body.pagination.has_next)) break;
  }
  return orders;
}

// Packages exist even at zero capacity — that's exactly the signal this file
// is looking for, so an empty week still needs to come back, not be skipped.
async function fetchPackages(tripUuid) {
  return (await apiGet(`/draft_trips/${tripUuid}/packages`)).data || [];
}

// WeTravel drops an order's package/week once it's cancelled — a cancelled
// order comes back with an empty packages array, no matter which week it was
// for. So a cancellation total is trustworthy at the trip level (summed
// below) but not attributable to one particular week; per-week figures here
// are booked counts only, never a per-week cancelled count.
async function loadTripDetail(trip) {
  let orders;
  let packages;
  try {
    [orders, packages] = await Promise.all([fetchOrders(trip.uuid), fetchPackages(trip.uuid)]);
  } catch (err) {
    console.error(`previous-trips: fetch failed for ${trip.uuid}: ${err.message}`);
    return null;
  }

  let booked = 0;
  let cancelled = 0;
  const bookedByWeek = new Map();
  for (const order of orders) {
    booked += order.active_count || 0;
    cancelled += order.cancelled_count || 0;
    for (const pkg of order.packages || []) {
      const key = tidy(pkg.name);
      bookedByWeek.set(key, (bookedByWeek.get(key) || 0) + (pkg.quantity || 1));
    }
  }

  const weeks = packages
    .map((pkg) => {
      const label = tidy(pkg.name);
      // A capacity of zero is WeTravel's own "unavailable" state for that
      // week — Muatasam's rule is that a week closed like this, after the
      // trip already had real bookings against it, reads as cancelled.
      const capacity = pkg.quantity == null ? null : Number(pkg.quantity);
      return {
        label,
        capacity,
        unavailable: capacity === 0,
        booked: bookedByWeek.get(label) || 0,
        ...weekDates(label, trip),
      };
    })
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  // Orders with no package at all (deleted before cancellation, or never
  // assigned one) aren't lost — surfaced as a leftover rather than silently
  // dropped, the same way trips-progress.js handles it for live trips.
  const weeksBooked = weeks.reduce((sum, w) => sum + w.booked, 0);
  const unallocated = Math.max(0, booked - weeksBooked);

  return { booked, cancelled, weeks, unallocated };
}

async function build() {
  const todayKey = omanToday();
  const allTrips = await listAllTrips();

  // Departed = end date (or start, if no end) already in the past. Undated
  // records have nothing to sort or filter by, so they're left out rather
  // than guessed into a bucket.
  const candidates = allTrips.filter((trip) => {
    if (EXCLUDED.has(String(trip.uuid))) return false;
    const start = dayKey(trip.start_date);
    const end = dayKey(trip.end_date) || start;
    return end && end < todayKey;
  });

  const loaded = await mapWithConcurrency(candidates, 4, (trip) => loadTripDetail(trip));

  const trips = [];
  candidates.forEach((trip, i) => {
    const detail = loaded[i];
    // No booking record at all isn't a departure the team can review — same
    // rule the live dashboard applies.
    if (!detail) return;

    const start = dayKey(trip.start_date);
    const end = dayKey(trip.end_date) || start;
    const d = new Date(`${start}T00:00:00Z`);

    // A single-week trip with no live capacity left has nowhere else for that
    // signal to show, so the whole row carries it. A multi-week trip keeps
    // its other weeks visible — only the closed one is flagged.
    const singleWeekCancelled = detail.weeks.length === 1 && detail.weeks[0].unavailable;

    trips.push({
      uuid: trip.uuid,
      name: productName(trip.title),
      title: trip.title,
      destination: trip.destination || '',
      start,
      end,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(), // 0-11, for the month filter
      booked: detail.booked,
      cancelled: detail.cancelled,
      charter: CHARTERS.has(String(trip.uuid)),
      weeks: detail.weeks,
      unallocated: detail.unallocated,
      cancelledTrip: singleWeekCancelled,
    });
  });

  // Most recent departure first — the order asked for.
  trips.sort((a, b) => (b.start || '').localeCompare(a.start || ''));

  const years = [...new Set(trips.map((t) => t.year))].sort((a, b) => b - a);

  return {
    asOf: new Date().toISOString(),
    today: todayKey,
    years,
    totals: {
      trips: trips.length,
      booked: trips.reduce((sum, t) => sum + t.booked, 0),
      cancelled: trips.reduce((sum, t) => sum + t.cancelled, 0),
    },
    trips,
  };
}

module.exports = async (req, res) => {
  try {
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

module.exports.build = build;
