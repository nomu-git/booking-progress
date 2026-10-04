// Tiny client for Upstash Redis over its REST API, so nothing needs to be
// installed. Used by api/campaign-alerts.js to remember which alerts have
// already been posted. The connection comes from env vars that Vercel's
// Upstash integration sets: KV_REST_API_URL / KV_REST_API_TOKEN, or the
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN pair, whichever is there.

const url = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/, '');
const token = () => (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

const configured = () => !!(url() && token());

// Several commands in one round trip: [['SET', k, v, 'NX'], ...] -> results.
async function pipeline(commands) {
  if (!commands.length) return [];
  if (!configured()) throw new Error('Alert store not configured (KV_REST_API_URL / KV_REST_API_TOKEN not set)');
  const res = await fetch(`${url()}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body)) {
    throw new Error(`Alert store request failed: ${(body && body.error) || `HTTP ${res.status}`}`);
  }
  return body.map((r) => {
    if (r && r.error) throw new Error(`Alert store: ${r.error}`);
    return r ? r.result : null;
  });
}

const command = async (...args) => (await pipeline([args]))[0];

module.exports = { configured, pipeline, command };
