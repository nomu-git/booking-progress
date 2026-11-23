// B2B tab (Sales group): the "B2B CRM" board in monday.com's Sales
// workspace (B2B folder), live. Asked for by Anton, 23 Nov 2026: "add the
// B2B CRM board ... under the Sales tab ... Name it B2B".
//
// The board is found by name, not ID: the board in a workspace named
// "Sales" whose name has both "B2B" and "CRM" (else just "B2B"), so moving
// it between folders or renaming it "B2B CRM 2027" keeps working.
// MONDAY_B2B_BOARD_ID pins it if that ever picks the wrong one.
//
// Every column is sent as monday shows it (titles, order, status colours),
// EXCEPT contact details: this is a public page with no login, so email,
// phone and file columns, long text (notes), and any column whose title
// says email / phone / mobile / WhatsApp / contact / notes are left out at
// the API, never sent. The payload says which columns were held back
// (titles only) so the page can say so. Item updates and files are never
// read.

const { mondayQuery } = require('../monday');

const CACHE_TTL_MS = Number(process.env.MONDAY_CACHE_TTL_MS || 60000);
const PINNED = (process.env.MONDAY_B2B_BOARD_ID || '').trim();

const HIDDEN_TYPES = new Set(['email', 'phone', 'file', 'long_text', 'location', 'button', 'doc', 'direct_doc', 'item_assignees', 'creation_log', 'last_updated', 'item_id', 'subtasks', 'subitems', 'board_relation', 'mirror', 'lookup', 'dependency', 'formula', 'auto_number', 'time_tracking', 'world_clock']);
const HIDDEN_TITLE = /e-?mail|phone|mobile|whats ?app|contact|note|address|passport|linkedin/i;
// Shown, with monday's text: status, people, dates, dropdowns, text,
// numbers, tags, ratings, timelines, countries, links, checkboxes.

const ITEM_FIELDS = 'id name created_at group { id title } column_values { id text value }';
const parse = (v) => { try { return JSON.parse(v || 'null'); } catch (e) { return null; } };

async function findBoard() {
  if (PINNED) return PINNED;
  const list = await mondayQuery(`query {
    boards(limit: 500, state: active) { id name type workspace { id name } }
  }`);
  const boards = (list.boards || []).filter((b) => (!b.type || b.type === 'board'));
  const inSales = boards.filter((b) => b.workspace && /\bsales\b/i.test(b.workspace.name));
  const pick = inSales.find((b) => /b2b/i.test(b.name) && /crm/i.test(b.name))
    || inSales.find((b) => /b2b/i.test(b.name))
    || boards.find((b) => /b2b/i.test(b.name) && /crm/i.test(b.name));
  if (!pick) throw new Error('No "B2B CRM" board found in the Sales workspace on monday.com');
  return pick.id;
}

async function load() {
  const id = await findBoard();
  const data = await mondayQuery(`query ($ids: [ID!]) {
    me { account { slug } }
    boards(ids: $ids) {
      id name workspace { name }
      columns { id title type settings_str }
      groups { id title position color }
      items_page(limit: 500) { cursor items { ${ITEM_FIELDS} } }
    }
  }`, { ids: [id] });
  const b = (data.boards || [])[0];
  if (!b) throw new Error(`monday board ${id} not found (or the token can't see it)`);
  let cursor = b.items_page && b.items_page.cursor;
  for (let page = 0; cursor && page < 20; page++) {
    const next = await mondayQuery(`query ($c: String!) {
      next_items_page(cursor: $c, limit: 500) { cursor items { ${ITEM_FIELDS} } }
    }`, { c: cursor });
    b.items_page.items.push(...((next.next_items_page && next.next_items_page.items) || []));
    cursor = next.next_items_page && next.next_items_page.cursor;
  }
  return { slug: data.me && data.me.account && data.me.account.slug, board: b };
}

function build({ slug, board: b }) {
  const today = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  const cols = (b.columns || []).filter((c) => c.id !== 'name');
  const hidden = cols.filter((c) => HIDDEN_TYPES.has(c.type) || HIDDEN_TITLE.test(c.title));
  const shown = cols.filter((c) => !hidden.includes(c));

  const columns = shown.map((c) => {
    const out = { id: c.id, title: c.title, type: c.type };
    if (c.type === 'status' || c.type === 'color') {
      const s = parse(c.settings_str) || {};
      const labels = s.labels || {};
      const colors = s.labels_colors || {};
      out.labels = Object.keys(labels).filter((k) => labels[k])
        .map((k) => ({ label: labels[k], color: colors[k] ? colors[k].color : null }));
    }
    return out;
  });
  const statusCols = columns.filter((c) => c.labels);
  const colorOf = new Map();
  for (const c of statusCols) for (const l of c.labels) colorOf.set(`${c.id}|${l.label}`, l.color);

  const groups = (b.groups || []).slice().sort((x, y) => (Number(x.position) || 0) - (Number(y.position) || 0))
    .map((g) => ({ id: g.id, title: g.title, color: g.color || null }));

  const items = ((b.items_page && b.items_page.items) || []).map((it) => {
    const vals = {};
    for (const c of columns) {
      const v = (it.column_values || []).find((x) => x.id === c.id) || {};
      let text = (v.text || '').trim();
      if (c.type === 'checkbox') text = (parse(v.value) || {}).checked ? '✓' : '';
      if (!text) continue;
      if (c.labels) vals[c.id] = { text, color: colorOf.get(`${c.id}|${text}`) || null };
      else if (c.type === 'people' || c.type === 'multiple-person') vals[c.id] = { people: text.split(',').map((s) => s.trim()).filter(Boolean) };
      else vals[c.id] = { text };
    }
    return {
      id: String(it.id),
      name: it.name,
      group: (it.group && it.group.id) || null,
      created: (it.created_at || '').slice(0, 10) || null,
      values: vals,
      url: slug ? `https://${slug}.monday.com/boards/${b.id}/pulses/${it.id}` : null,
    };
  });

  return {
    asOf: new Date().toISOString(),
    today,
    board: { id: String(b.id), name: b.name, workspace: (b.workspace && b.workspace.name) || null, url: slug ? `https://${slug}.monday.com/boards/${b.id}` : null },
    columns,
    hiddenColumns: hidden.map((c) => c.title),
    groups,
    items,
  };
}

// Served by api/sheets.js?name=b2b.
module.exports = { build, load, ttl: CACHE_TTL_MS };
