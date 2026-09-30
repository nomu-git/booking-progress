// Engagements tab: Maryam's social media workbook ("Marketing Data: Social
// Media Nomuhub"), read live from its SharePoint share link. She keeps
// filling it in as she does now; the tab mirrors it. Same approach as the
// Leads tab (docs/LEADS-PLAN.md, Phase 1): automatic *reporting* of a
// manual record, until Instagram is connected and the numbers can come
// from its API instead.
//
// Two tabs, told apart by their headers rather than their names:
//   - posts: one row per post, with Views, Likes, Comments, Shares,
//     Book marks and an Engagement rate.
//   - stories: one row per story, with a Poll Type, Views and Responses.
//
// The Engagement rate is Maryam's own figure, shown as she wrote it. It is
// (likes + comments + shares + saves) / views on every post in the sheet,
// which is what the dashboard's hover help says it is.

const CACHE_TTL_MS = Number(process.env.ENGAGEMENT_CACHE_TTL_MS || 60000);

// Oman is UTC+4 year-round, and "today" is Muscat's today.
const omanToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const text = (v) => String(v == null ? '' : v).trim();
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Dates come typed two ways: as text ("3rd July", "26 August") and, from
// late August on, as real dates. Text dates carry no year, so it's supplied.
function parseDate(v, year) {
  if (typeof v === 'string' && ISO.test(v)) return v;
  const m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([A-Za-z]{3,})/.exec(text(v));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const d = new Date(Date.UTC(year, month, Number(m[1])));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Header row -> { key: column }, matched on names so a column moving or a
// new one being added doesn't shift everything after it.
function columns(header, wanted) {
  const h = header.map((v) => text(v).toLowerCase().replace(/\s+/g, ' '));
  const out = {};
  for (const [key, test] of Object.entries(wanted)) out[key] = h.findIndex((name) => test.test(name));
  return out;
}

const POST_COLS = {
  name: /^content name/, language: /^content language/, caption: /^caption language/,
  type: /^content type/, date: /^post date/, views: /^views/, likes: /^likes/,
  comments: /^comments/, shares: /^shares/, saves: /^book ?marks?|^saves?/,
  engagement: /^engagement/, ctaPresent: /^cta present/, ctaWord: /^cta word/,
};
const STORY_COLS = {
  name: /^content name/, language: /^content language/, kind: /^poll type/,
  date: /^post date/, views: /^views/, responses: /^responses/,
  result: /^comments/, question: /question/,
};

function build(sheets, today = omanToday()) {
  const years = new Map();
  for (const s of sheets) for (const row of s.grid) for (const v of row) {
    if (typeof v === 'string' && ISO.test(v)) years.set(v.slice(0, 4), (years.get(v.slice(0, 4)) || 0) + 1);
  }
  const year = Number([...years].sort((a, b) => b[1] - a[1])[0]?.[0] || today.slice(0, 4));

  const posts = [];
  const stories = [];
  for (const s of sheets) {
    const header = s.grid[0] || [];
    const names = header.map((v) => text(v).toLowerCase());
    const cell = (row, col) => (col >= 0 ? row[col] : null);

    if (names.some((n) => n.startsWith('poll type'))) {
      const c = columns(header, STORY_COLS);
      for (const row of s.grid.slice(1)) {
        if (!text(cell(row, c.name)) && count(cell(row, c.views)) == null) continue;
        // Responses is usually a count, but a link story records "8 Link
        // Clicks": the number is kept, and so is what it counts.
        const raw = cell(row, c.responses);
        const n = count(raw) ?? (/\d+/.test(text(raw)) ? Number(text(raw).match(/\d+/)[0]) : null);
        const unit = count(raw) == null && text(raw) ? text(raw).replace(/^\d+\s*/, '').toLowerCase() : null;
        stories.push({
          name: text(cell(row, c.name)),
          language: text(cell(row, c.language)) || null,
          kind: text(cell(row, c.kind)) || null,
          date: parseDate(cell(row, c.date), year),
          dateText: text(cell(row, c.date)),
          views: count(cell(row, c.views)),
          responses: n,
          responsesUnit: unit,
          result: text(cell(row, c.result)) || null,
          question: text(cell(row, c.question)) || null,
        });
      }
    } else if (names.some((n) => n.startsWith('content name')) && names.some((n) => n.startsWith('likes'))) {
      const c = columns(header, POST_COLS);
      for (const row of s.grid.slice(1)) {
        if (!text(cell(row, c.name)) && count(cell(row, c.views)) == null) continue;
        const views = count(cell(row, c.views));
        const likes = count(cell(row, c.likes));
        const comments = count(cell(row, c.comments));
        const shares = count(cell(row, c.shares));
        // A blank Book marks cell means it wasn't recorded, not zero; it's
        // kept blank on screen. Her engagement formula counts it as 0.
        const saves = count(cell(row, c.saves));
        const interactions = (likes || 0) + (comments || 0) + (shares || 0) + (saves || 0);
        posts.push({
          name: text(cell(row, c.name)),
          language: text(cell(row, c.language)) || null,
          captionLanguage: text(cell(row, c.caption)) || null,
          type: text(cell(row, c.type)) || null,
          date: parseDate(cell(row, c.date), year),
          dateText: text(cell(row, c.date)),
          views, likes, comments, shares, saves, interactions,
          engagement: count(cell(row, c.engagement)) ?? (views ? interactions / views : null),
          ctaPresent: text(cell(row, c.ctaPresent)) || null,
          ctaWord: text(cell(row, c.ctaWord)) || null,
        });
      }
    }
  }

  const byDate = (a, b) => (a.date || '9999').localeCompare(b.date || '9999');
  posts.sort(byDate);
  stories.sort(byDate);

  // Month keys present in either tab, for the month filter.
  const months = [...new Set([...posts, ...stories].map((x) => (x.date || '').slice(0, 7)).filter(Boolean))].sort();
  const sum = (list, key) => list.reduce((s, x) => s + (x[key] || 0), 0);
  const views = sum(posts, 'views');
  const interactions = sum(posts, 'interactions');

  return {
    asOf: new Date().toISOString(),
    today,
    year,
    months,
    totals: {
      posts: posts.length,
      views,
      interactions,
      engagement: views ? interactions / views : null,
      stories: stories.length,
      storyViews: sum(stories, 'views'),
      storyResponses: sum(stories, 'responses'),
    },
    posts,
    stories,
  };
}

// Served by api/sheets.js?name=engagements, which fetches the workbook from
// ENGAGEMENT_SHEET_URL, caches it for `ttl`, and passes it to build().
module.exports = { build, envVar: 'ENGAGEMENT_SHEET_URL', ttl: CACHE_TTL_MS };
