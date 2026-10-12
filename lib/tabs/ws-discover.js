// TEMPORARY (13 Oct 2026): lists the boards of the Sales workspace so the
// Monday tab's Sales section can be pointed at them. Secret-gated; removed
// right after.
const { mondayQuery } = require('../monday');
async function load() {
  const ws = await mondayQuery('query { workspaces(limit: 100) { id name } }');
  const sales = (ws.workspaces || []).filter((w) => /sales/i.test(w.name));
  const out = { workspaces: (ws.workspaces || []).map((w) => `${w.id} ${w.name}`), boards: [] };
  for (const w of sales) {
    out[`folders ${w.name}`] = await mondayQuery('query ($ids: [ID!]) { folders(workspace_ids: $ids, limit: 100) { id name children { id name } } }', { ids: [w.id] }).catch((e) => ({ err: e.message }));
    const b = await mondayQuery(`query ($ids: [ID!]) { boards(workspace_ids: $ids, limit: 100, state: active) {
      id name board_folder_id type groups { id title }
      columns { id title type }
      items_page(limit: 500) { items { id column_values { id text type } } }
    } }`, { ids: [w.id] });
    for (const x of b.boards || []) {
      const status = (x.columns || []).find((c) => c.type === 'status');
      const vals = {};
      let n = 0;
      for (const it of (x.items_page && x.items_page.items) || []) {
        n++;
        const v = (it.column_values || []).find((c) => status && c.id === status.id);
        const t = (v && v.text) || '(blank)';
        vals[t] = (vals[t] || 0) + 1;
      }
      out.boards.push({ workspace: w.name, id: x.id, name: x.name, folder: x.board_folder_id, type: x.type, groups: (x.groups || []).map((g) => g.title), columns: (x.columns || []).map((c) => `${c.type}:${c.title}`), items: n, statuses: vals });
    }
  }
  return out;
}
module.exports = { load, build: (x) => x, ttl: 0, secret: true };
