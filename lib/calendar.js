// Marketing calendar from monday.com (Muatasam via Anton, 12 Oct 2026):
// "Artwork should be ready one week before the post", flagged so he doesn't
// have to chase it. The calendar is one board per month in the Marketing
// workspace ("July 2026" ... "December 2026", folder 3231011 today); boards
// are found by their month-year name, so a new month's board is picked up
// without a code change, wherever it's filed.
//
// Board layouts differ by month: October onwards has "Posting Date" and an
// "Artwork Status" (Working on it / Pending Review / Revision Needed /
// Approved / Scheduled / Posted), November adds a separate "Post Status"
// (Posted / Scheduled); September has one "Status". So: the first date
// column is the posting date, and a post is READY if ANY of its status
// columns says Posted, Scheduled, Approved, Done or Complete(d). Anything
// else (including blank) is not ready.
//
// Only real posts count: items in the Instagram / TikTok / Campaign Ads style
// groups with a posting date. "Hashtag Bank", "Ideas" and "Archive" groups
// aren't posts. Scope (Anton): today and upcoming posts, plus past ones that
// still aren't ready. Artwork is due 7 days before the posting date; a post
// whose artwork is due (or past due) and not ready is LATE.

const { mondayQuery } = require('./monday');

const WORKSPACE_ID = process.env.MONDAY_MARKETING_WORKSPACE_ID || '121351';
const LEAD_DAYS = Number(process.env.ARTWORK_LEAD_DAYS || 7);
const READY = /^(posted|scheduled|approved|done|complete|completed|ready)$/i;
const NOT_POSTS = /hashtag|idea|archive/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const omanToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// "October 2026", "Dec 2025", "Jan 2024 Content Calendar" -> "2026-10".
function boardMonth(name) {
  const m = /^([a-z]+)\s+(\d{4})/i.exec(String(name || '').trim());
  if (!m) return null;
  const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`;
}

async function load(today = omanToday()) {
  const list = await mondayQuery(`query ($ids: [ID!]) {
    boards(workspace_ids: $ids, limit: 200, state: active) { id name type }
  }`, { ids: [WORKSPACE_ID] });
  // Last month's board too, for posts that went past due without being done.
  const from = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  const boards = (list.boards || [])
    .filter((b) => (!b.type || b.type === 'board') && boardMonth(b.name) && boardMonth(b.name) >= from);
  if (!boards.length) return { today, boards: [] };
  const data = await mondayQuery(`query ($ids: [ID!]) {
    boards(ids: $ids) {
      id name
      columns { id title type }
      items_page(limit: 500) { items { id name group { title } column_values { id text } } }
    }
  }`, { ids: boards.map((b) => b.id) });
  return { today, boards: data.boards || [] };
}

function build({ today, boards }) {
  const posts = [];
  for (const b of boards) {
    const cols = b.columns || [];
    const date = cols.find((c) => c.type === 'date');
    const statuses = cols.filter((c) => c.type === 'status');
    const people = cols.find((c) => c.type === 'people');
    if (!date) continue;
    for (const it of (b.items_page && b.items_page.items) || []) {
      const group = (it.group && it.group.title) || '';
      if (NOT_POSTS.test(group)) continue;
      const val = (id) => ((it.column_values || []).find((v) => v.id === id) || {}).text || '';
      const day = val(date.id).slice(0, 10);
      if (!day) continue;
      const labels = statuses.map((c) => ({ column: c.title, label: val(c.id).trim() }));
      const ready = labels.some((s) => READY.test(s.label));
      // Shown as the status: the first one that isn't blank, artwork first.
      const shown = labels.find((s) => /artwork/i.test(s.column) && s.label) || labels.find((s) => s.label);
      const due = addDays(day, -LEAD_DAYS);
      if (day < today && ready) continue; // past and done: out of scope
      posts.push({
        name: it.name,
        board: b.name,
        channel: group,
        date: day,
        artworkDue: due,
        status: shown ? shown.label : 'No status',
        ready,
        late: !ready && today >= due,
        overdue: !ready && day < today,
        lead: people ? val(people.id) || null : null,
      });
    }
  }
  posts.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return {
    today,
    leadDays: LEAD_DAYS,
    posts,
    late: posts.filter((p) => p.late),
    next7: posts.filter((p) => p.date >= today && p.date <= addDays(today, 6)),
    next14: posts.filter((p) => p.date >= today && p.date <= addDays(today, 13)),
  };
}

module.exports = { load, build, boardMonth, READY };
