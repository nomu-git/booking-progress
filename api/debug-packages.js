// Temporary — inspecting WeTravel's raw package/booking fields to build
// per-week cancellation detection. Remove after.
const { apiGet } = require('./wetravel');

module.exports = async (req, res) => {
  try {
    const uuid = req.query.uuid;
    if (!uuid) return res.status(400).json({ error: 'uuid required' });
    const packages = await apiGet(`/draft_trips/${uuid}/packages`);
    const orders = await apiGet(`/bookings/trips/${uuid}/bookings?page=1`);
    res.status(200).json({ packages, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
