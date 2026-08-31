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

// Just the two totals this view needs — no per-week breakdown, that's the
// live dashboard's job, not a record of what already happened.
async function loadTotals(trip) {
  let orders;
  try {
    orders = await fetchOrders(trip.uuid);
  } catch (err) {
    console.error(`previous-trips: bookings failed for ${trip.uuid}: ${err.message}`);
    return null;
  }
  let booked = 0;
  let cancelled = 0;
  for (const order of orders) {
    booked += order.active_count || 0;
    cancelled += order.cancelled_count || 0;
  }
  return { booked, cancelled };
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

  const loaded = await mapWithConcurrency(candidates, 4, (trip) => loadTotals(trip));

  const trips = [];
  candidates.forEach((trip, i) => {
    const totals = loaded[i];
    // No booking record at all isn't a departure the team can review — same
    // rule the live dashboard applies.
    if (!totals) return;

    const start = dayKey(trip.start_date);
    const end = dayKey(trip.end_date) || start;
    const d = new Date(`${start}T00:00:00Z`);

    trips.push({
      uuid: trip.uuid,
      name: productName(trip.title),
      title: trip.title,
      destination: trip.destination || '',
      start,
      end,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(), // 0-11, for the month filter
      booked: totals.booked,
      cancelled: totals.cancelled,
      charter: CHARTERS.has(String(trip.uuid)),
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
