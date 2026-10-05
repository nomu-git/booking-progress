// Minimal monday.com GraphQL client, over fetch. The token is a monday API
// token in MONDAY_API_TOKEN (profile picture -> Developers -> API token),
// kept only in Vercel. The API version is pinned so a monday release can't
// change field shapes under the dashboard.

const API_URL = 'https://api.monday.com/v2';
const API_VERSION = process.env.MONDAY_API_VERSION || '2024-10';

async function mondayQuery(query, variables = {}, attempt = 0) {
  const token = (process.env.MONDAY_API_TOKEN || '').trim();
  if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json', 'API-Version': API_VERSION },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null);
  // monday rate-limits by "complexity"; a short wait and one or two retries
  // is enough for a dashboard reading a few boards.
  if ((res.status === 429 || (body && /complexity|rate limit/i.test(JSON.stringify(body.errors || body.error_message || '')))) && attempt < 2) {
    await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
    return mondayQuery(query, variables, attempt + 1);
  }
  if (!res.ok || !body || body.errors || body.error_message) {
    const detail = (body && (body.error_message || (body.errors && body.errors.map((e) => e.message).join('; ')))) || `HTTP ${res.status}`;
    throw new Error(`monday API: ${detail}`);
  }
  return body.data;
}

module.exports = { mondayQuery };
