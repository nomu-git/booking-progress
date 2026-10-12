// TEMPORARY (12 Oct 2026): lists the Marketing workspace's calendar boards
// and their columns so the marketing-calendar reader can be written against
// the real layout. Behind CAMPAIGN_ALERT_SECRET via api/sheets.js. Remove
// once lib/tabs/calendar.js exists.
const { mondayQuery } = require('../monday');

async function load() {
  const ws = await mondayQuery('query { workspaces(limit: 100) { id name } }');
  const mk = (ws.workspaces || []).filter((w) => /marketing/i.test(w.name));
  const out = { workspaces: ws.workspaces.map((w) => `${w.id} ${w.name}`), boards: [] };
  for (const w of mk) {
    const f = await mondayQuery('query ($ids: [ID!]) { folders(workspace_ids: $ids, limit: 100) { id name children { id name } } }', { ids: [w.id] }).catch((e) => ({ err: e.message }));
    out[`folders ${w.name}`] = f;
    const b = await mondayQuery(`query ($ids: [ID!]) { boards(workspace_ids: $ids, limit: 200, state: active) {
      id name board_folder_id type
      columns { id title type settings_str }
      groups { id title }
      items_page(limit: 4) { items { name group { title } column_values { id text } } }
    } }`, { ids: [w.id] });
    for (const x of b.boards || []) {
      if (x.type && x.type !== 'board') continue;
      out.boards.push({
        workspace: w.name, id: x.id, name: x.name, folder: x.board_folder_id,
        groups: (x.groups || []).map((g) => g.title),
        columns: (x.columns || []).map((c) => {
          let labels;
          if (c.type === 'status') { try { labels = Object.values(JSON.parse(c.settings_str).labels || {}); } catch (e) { labels = null; } }
          return `${c.id} | ${c.type} | ${c.title}${labels ? ' | ' + labels.join(', ') : ''}`;
        }),
        sample: ((x.items_page && x.items_page.items) || []).map((it) => ({ name: it.name, group: it.group && it.group.title, cols: Object.fromEntries((it.column_values || []).filter((v) => v.text).map((v) => [v.id, v.text.slice(0, 60)])) })),
      });
    }
  }
  return out;
}
module.exports = { load, build: (x) => x, ttl: 0, secret: true };
