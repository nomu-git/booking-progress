// Every sheet-mirror tab in one function: Leads, Engagements, Trips & R&D,
// Feedback and Trip Revenue, picked with ?name=. Each used to be its own
// file in api/, but Vercel's Hobby plan allows 12 functions per deployment
// and every file in api/ is one; at 12, the next tab would have failed
// every deploy silently. The builders live in lib/tabs/, each exporting
// { build, envVar, ttl }, or { build, load, ttl } for a tab whose data isn't
// a workbook (Pending Task reads monday.com). The old /api/<name> URLs
// still work, through rewrites in vercel.json.

const { fetchWorkbook } = require('../lib/sheet');

const TABS = {
  leads: require('../lib/tabs/leads'),
  engagements: require('../lib/tabs/engagements'),
  trips: require('../lib/tabs/trips'),
  feedback: require('../lib/tabs/feedback'),
  revenue: require('../lib/tabs/revenue'),
  pending: require('../lib/tabs/pending'),
};

// One cache entry per tab, as each had its own before the merge.
const cache = new Map();

module.exports = async (req, res) => {
  const name = String((req.query && req.query.name) || '');
  const tab = Object.prototype.hasOwnProperty.call(TABS, name) ? TABS[name] : null;
  if (!tab) return res.status(404).json({ error: `Unknown sheet "${name}"`, sheets: Object.keys(TABS) });

  const hit = cache.get(name);
  try {
    const fresh = req.query && req.query.refresh === '1';
    if (!fresh && hit && Date.now() - hit.at < tab.ttl) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(hit.payload);
    }
    const payload = tab.build(tab.load ? await tab.load() : await fetchWorkbook(tab.envVar));
    cache.set(name, { at: Date.now(), payload });
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    if (hit) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ ...hit.payload, stale: true, error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
};
