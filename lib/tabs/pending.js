// Pending Task tab (Corporate group): every item on the chosen monday.com
// boards that isn't Done yet, with who it's assigned to and its status
// exactly as monday shows it (including no status at all). Main items only,
// no sub-items. Asked for by Anton, 5 Oct 2026.
//
// Boards come from MONDAY_BOARD_IDS. The default is the four Anton picked:
// Operations General, Asia, Africa and Marketing & Sales General. Columns
// are found by type, not by ID, since the boards were made from different
// templates: the people column, the status column titled "Status" (some
// boards also have a Priority status column), and the first date column.
//
// Status labels and colours come from the status column's own settings, so
// the tab says "Stuck" in monday's red the same way the board does. "Done"
// is the only label monday's boards here treat as finished
// (MONDAY_DONE_LABELS to change that).
//
// Public page, no login: Anton chose to show task names and people's names
// as monday has them. Item descriptions, files and updates are never read.

const { mondayQuery } = require('../monday');

const CACHE_TTL_MS = Number(process.env.MONDAY_CACHE_TTL_MS || 60000);
const BOARD_IDS = (process.env.MONDAY_BOARD_IDS || '5102303383,5102494784,5102494871,5103011662')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DONE = new Set((process.env.MONDAY_DONE_LABELS || 'Done')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const ITEM_FIELDS = 'id name group { id title } column_values { id text value }';

const parse = (v) => { try { return JSON.parse(v || 'null'); } catch (e) { return null; } };

async function loadBoards() {
  const data = await mondayQuery(`query ($ids: [ID!]) {
    me { account { slug } }
    boards(ids: $ids) {
      id name workspace { name }
      columns { id title type settings_str }
      groups { id title position }
      items_page(limit: 500) { cursor items { ${ITEM_FIELDS} } }
    }
  }`, { ids: BOARD_IDS });
  // Follow the cursor for any board with more than one page.
  for (const b of data.boards || []) {
    let cursor = b.items_page && b.items_page.cursor;
    for (let page = 0; cursor && page < 20; page++) {
      const next = await mondayQuery(`query ($c: String!) {
        next_items_page(cursor: $c, limit: 500) { cursor items { ${ITEM_FIELDS} } }
      }`, { c: cursor });
      b.items_page.items.push(...((next.next_items_page && next.next_items_page.items) || []));
      cursor = next.next_items_page && next.next_items_page.cursor;
    }
  }
  return { slug: data.me && data.me.account && data.me.account.slug, boards: data.boards || [] };
}

function build({ slug, boards }) {
  const today = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  const items = [];
  const out = [];
  // Keep the order Anton listed the boards in.
  const order = new Map(BOARD_IDS.map((id, i) => [String(id), i]));
  boards.sort((a, b) => (order.get(String(a.id)) ?? 99) - (order.get(String(b.id)) ?? 99));

  // Two of the boards are both called "General" (Operations and Marketing &
  // Sales), so every board is named with its workspace.
  const boardLabel = (b) => (b.workspace && b.workspace.name ? `${b.workspace.name} · ${b.name}` : b.name);
  for (const b of boards) {
    const cols = b.columns || [];
    const people = cols.find((c) => c.type === 'people') || cols.find((c) => c.type === 'multiple-person');
    const statuses = cols.filter((c) => c.type === 'status' || c.type === 'color');
    const status = statuses.find((c) => /^status$/i.test(c.title)) || statuses[0];
    const due = cols.find((c) => c.type === 'date');
    const settings = parse(status && status.settings_str) || {};
    const labels = settings.labels || {};
    const colors = settings.labels_colors || {};
    const groupPos = new Map((b.groups || []).map((g) => [g.id, Number(g.position) || 0]));

    let total = 0;
    let pending = 0;
    for (const it of (b.items_page && b.items_page.items) || []) {
      total++;
      const val = (id) => (it.column_values || []).find((c) => c.id === id) || {};
      const st = status ? val(status.id) : {};
      const label = (st.text || '').trim();
      if (label && DONE.has(label.toLowerCase())) continue;
      pending++;
      const idx = (parse(st.value) || {}).index;
      const color = idx != null && colors[idx] ? colors[idx].color : null;
      const date = due ? (val(due.id).text || '').slice(0, 10) || null : null;
      items.push({
        id: String(it.id),
        board: boardLabel(b),
        boardId: String(b.id),
        workspace: (b.workspace && b.workspace.name) || null,
        group: (it.group && it.group.title) || null,
        groupPos: groupPos.get(it.group && it.group.id) ?? 0,
        name: it.name,
        people: people ? (val(people.id).text || '').split(',').map((s) => s.trim()).filter(Boolean) : [],
        status: label || null,
        statusColor: color,
        due: date,
        overdue: !!(date && date < today),
        url: slug ? `https://${slug}.monday.com/boards/${b.id}/pulses/${it.id}` : null,
      });
    }
    out.push({
      id: String(b.id),
      name: boardLabel(b),
      workspace: (b.workspace && b.workspace.name) || null,
      total,
      pending,
      // Every label the board has, in monday's order and colours, so the
      // filter can list them even when a board has none pending.
      statuses: Object.keys(labels).filter((k) => labels[k]).map((k) => ({ label: labels[k], color: colors[k] ? colors[k].color : null })),
    });
  }

  const byPerson = new Map();
  for (const it of items) {
    for (const p of it.people.length ? it.people : [null]) byPerson.set(p, (byPerson.get(p) || 0) + 1);
  }
  return {
    asOf: new Date().toISOString(),
    today,
    boards: out,
    totals: {
      pending: items.length,
      people: [...byPerson.keys()].filter(Boolean).length,
      unassigned: byPerson.get(null) || 0,
      overdue: items.filter((i) => i.overdue).length,
    },
    byPerson: [...byPerson.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (a.name == null) - (b.name == null) || b.count - a.count || String(a.name).localeCompare(String(b.name))),
    items,
  };
}

// Served by api/sheets.js?name=pending. Not a workbook, so it brings its own
// loader instead of an env var for lib/sheet.js.
module.exports = { build, load: loadBoards, ttl: CACHE_TTL_MS };
