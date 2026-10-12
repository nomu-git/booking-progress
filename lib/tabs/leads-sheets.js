// TEMPORARY (12 Oct 2026): which tabs the leads workbook has right now, how
// big, and how each one is read. Names, counts and header words only, never
// cell values. Secret-gated; removed right after.
const leadsTab = require('./leads');
module.exports = {
  envVar: leadsTab.envVar,
  ttl: 0,
  secret: true,
  build: (sheets) => sheets.map((s) => {
    const g = s.grid || [];
    const head = (g[0] || []).map((v) => String(v == null ? '' : v).trim().toLowerCase());
    const dated = g.filter((r) => typeof r[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r[0])).length;
    return {
      name: s.name, rows: g.length, cols: Math.max(0, ...g.map((r) => r.length)),
      firstRowHeaders: head.filter(Boolean).slice(0, 12), datedRows: dated,
      kind: head.includes('date') && head.includes('source') ? 'log' : null,
    };
  }),
};
