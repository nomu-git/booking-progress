// Automatic lead counts from ManyChat (lib/manychat.js), for the Leads tab's
// side-by-side check against Marina's sheet. Counts only.
const { load } = require('../manychat');

module.exports = { load, build: (x) => x, ttl: Number(process.env.MANYCHAT_CACHE_TTL_MS || 30000) };
