// New vs repeat customers (Anton, 25 Oct 2026: "see the new people booking
// with us and the repeated customer we have"), from WeTravel's own buyer
// history. Every order carries its buyer, so an order is a REPEAT booking when
// that buyer already has an earlier real booking with us (any trip, any year
// since 2019, charters' orders count as history) and a NEW booking when it's
// their first.
//
// `gapDays`: the earlier booking has to be at least this many days before, so
// one person booking two weeks of the same trip minutes apart, or adding a
// second order the same week, isn't called "a returning customer".
//
// Only counts leave the API; the buyer id never does.

const DAY = 86400000;

function buyerKey(order) {
  if (order.buyer_id != null && order.buyer_id !== '') return `id:${order.buyer_id}`;
  const b = order.buyer;
  const email = b && (b.email || b.email_address);
  return email ? `em:${String(email).trim().toLowerCase()}` : null;
}

// tripOrders: [{ trip, orders }]. Returns the Set of `${trip.uuid}:${order.id}`
// that are repeat bookings, plus how many orders had no buyer to judge.
function repeatOrders(tripOrders, nowMs, gapDays) {
  const by = new Map(); // buyer -> [{ at, key }] real bookings, oldest first
  let unknown = 0;
  for (const { trip, orders } of tripOrders) {
    for (const o of orders || []) {
      const at = Date.parse(o.created_at);
      if (!Number.isFinite(at) || at > nowMs || !(o.active_count > 0)) continue;
      const b = buyerKey(o);
      if (!b) { unknown += 1; continue; }
      if (!by.has(b)) by.set(b, []);
      by.get(b).push({ at, key: `${trip.uuid}:${o.id}` });
    }
  }
  const repeat = new Set();
  for (const list of by.values()) {
    list.sort((a, b) => a.at - b.at);
    const firstAt = list[0].at;
    for (let i = 1; i < list.length; i += 1) {
      // Repeat when the buyer's FIRST booking is at least gapDays earlier.
      if (list[i].at - firstAt >= gapDays * DAY) repeat.add(list[i].key);
    }
  }
  return { repeat, unknown, buyers: by.size };
}

module.exports = { repeatOrders, buyerKey };
