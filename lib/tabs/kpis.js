// KPIs tab (Corporate), served by api/sheets.js?name=kpis. It reads every
// other source (WeTravel, the leads and social sheets, Meta, monday), so it's
// cached for 5 minutes. See lib/kpis.js.
const { load, build } = require('../kpis');

module.exports = { load, build: (src) => build(src), ttl: Number(process.env.KPI_CACHE_TTL_MS || 300000) };
