// Reads the announcement banner's content from env vars, so it can be changed
// from the Vercel dashboard alone — no code edits, no redeploying by hand
// beyond the one click Vercel already requires to pick up a changed env var.
//
// Dated reminders (Anton, 6 Oct 2026) live in REMINDERS below instead: each
// shows on the Booking tab until the end of its due day (Muscat), then drops
// off on its own, so a passed deadline never lingers on the wall.
// Empty since 13 Oct 2026 (Anton: "remove the announcements"): the Thailand
// Wellness and South Africa Explore decision reminders are gone. Add
// { due: 'YYYY-MM-DD', title, body } here for the next one.
const REMINDERS = [];

module.exports = async (req, res) => {
  const title = (process.env.ANNOUNCEMENT_TITLE || '').trim();
  const body = (process.env.ANNOUNCEMENT_BODY || '').trim();
  const today = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  const items = [
    ...(title || body ? [{ title, body, due: null }] : []),
    ...REMINDERS.filter((r) => r.due >= today).sort((a, b) => a.due.localeCompare(b.due)),
  ];
  // title/body kept for any page still on the single-banner version.
  res.status(200).json({ title, body, today, items });
};
