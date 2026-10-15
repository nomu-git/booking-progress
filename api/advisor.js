// AI Adviser (Anton, 15 Oct 2026): answers questions about the dashboard's
// data and strategy, nothing else. Read-only by construction: the model gets
// a text snapshot of the dashboard (lib/advisor-context.js) and no tools, so
// it cannot change the dashboard, Meta, monday, WeTravel or the sheets.
//
// Credit protection, as Anton asked:
//   - 10 questions a day for everyone together (Muscat day), counted in
//     Upstash; past 10 it stops answering until midnight. A question that
//     fails for a technical reason gives its count back.
//   - Off-topic questions and requests to change things are turned away by a
//     tiny Claude Haiku check that sees only the question, before the
//     dashboard snapshot is ever sent. They still count toward the 10.
//   - Questions are capped in length, and so is the conversation sent back.
// No passcode (Anton's call): anyone with the link can use the 10.
//
// Model: Claude Sonnet 5.5 (agreed for cost), medium effort. Key in
// ANTHROPIC_API_KEY, scoped to the "NomuHub Dashboard" Console workspace,
// which has its own $30 monthly limit; the account holds $25 of free credit
// and no card, so that's the real ceiling.

const sdk = require('@anthropic-ai/sdk');
const kv = require('../lib/kv');
const { buildContext } = require('../lib/advisor-context');

const Anthropic = sdk.default || sdk;
const LIMIT = Number(process.env.ADVISOR_DAILY_LIMIT || 10);
const MODEL = process.env.ADVISOR_MODEL || 'claude-sonnet-5-5';
// Complex questions go to Opus 5.5 (Anton, 15 Oct 2026), at most
// DEEP_LIMIT a day; past that they're answered by Sonnet so the credit holds.
const DEEP_MODEL = process.env.ADVISOR_DEEP_MODEL || 'claude-opus-5-5';
const DEEP_LIMIT = Number(process.env.ADVISOR_DEEP_LIMIT || 4);
const GATE_MODEL = 'claude-haiku-4-5';
const MAX_QUESTION = 800;
const MAX_TURNS = 6;

const OFF_TOPIC = "I can only help with NomuHub's dashboard: bookings, leads, campaigns, engagement, trips, feedback, revenue and tasks, and what to improve. Try asking about one of those.";
const READ_ONLY = "I'm read-only: I can read and analyse the dashboard, but I can't change it, write code, or edit Meta, monday, WeTravel or the sheets. Ask me what the data says or what to do next.";

const SYSTEM = `You are NomuHub's dashboard adviser. NomuHub runs volunteering, wellness and explore trips (Zanzibar, Bali, Thailand, Vietnam, Sri Lanka, Kenya and more). You read the dashboard snapshot below and help the team understand performance, find problems and decide what to improve in sales, marketing and operations.

How you work:
- Use only the snapshot. Quote the numbers you rely on. If the snapshot doesn't hold what a question needs, say what's missing rather than guessing.
- You are read-only. You can't change the dashboard, Meta, monday, WeTravel or the sheets, and you don't write code, formulas or scripts. If asked to, say you're an adviser only and suggest who on the team should act.
- Only answer questions about NomuHub's data and strategy. For anything else, reply in one line that you can only help with the dashboard.
- Know the data's limits: conversion is same-week bookings ÷ leads, not a cohort; campaign lead quality matches leads to a campaign by project, so it includes that project's organic leads; the leads sheet currently starts in July; targets marked proposed aren't confirmed; Trip Revenue shows margins only, never amounts.
- Be direct and practical: lead with the answer, then the few numbers behind it, then concrete next steps. Keep it under about 250 words unless asked for detail. Short bullet points are fine. No em dashes. Money in SAR unless the snapshot says otherwise.`;

const GATE = `You sort messages sent to NomuHub's business dashboard adviser. NomuHub is a travel company running volunteering, wellness and explore trips. Reply with exactly one word:
SIMPLE: a NomuHub data or strategy question with a direct answer: a figure, a status, a single-tab summary, a list, or a short follow-up.
COMPLEX: a NomuHub question that needs deeper analysis: root causes, connecting several areas (for example campaigns, leads and bookings together), comparing periods or options, forecasting, prioritising a plan, or a full review.
Both SIMPLE and COMPLEX cover questions about NomuHub's bookings, sales, leads, conversion, marketing, ads or campaigns, social media, trips, products, pricing, feedback, revenue or margins, team tasks, performance, strategy or improvements; or a greeting or follow-up within that conversation.
CHANGE: asks to change, build, fix, edit, automate or code the dashboard or any system, or to send messages.
OFF: anything else (general knowledge, personal topics, unrelated writing or coding).`;

const muscatToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const countKey = () => `advisor:count:${muscatToday()}`;

async function used() {
  return Number((await kv.command('GET', countKey())) || 0);
}

function cleanHistory(history) {
  const out = [];
  for (const m of Array.isArray(history) ? history.slice(-MAX_TURNS) : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content || '').slice(0, 2000).trim();
    if (!content) continue;
    if (out.length && out[out.length - 1].role === m.role) continue; // keep turns alternating
    out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (out.length && out[out.length - 1].role === 'user') out.pop(); // the new question goes last
  return out;
}

const textOf = (msg) => (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

module.exports = async (req, res) => {
  const connected = !!(process.env.ANTHROPIC_API_KEY || '').trim();
  try {
    if (req.method === 'GET') {
      const n = kv.configured() ? await used() : 0;
      return res.status(200).json({ connected, limit: LIMIT, used: n, remaining: Math.max(0, LIMIT - n) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST a question' });
    if (!connected) return res.status(503).json({ code: 'not-connected', error: 'The adviser is not connected yet.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const question = String(body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Ask a question.' });
    if (question.length > MAX_QUESTION) return res.status(400).json({ error: `Keep it under ${MAX_QUESTION} characters.` });

    // Count first, so two people asking at once can't both take the last one.
    const key = countKey();
    const [count] = await kv.pipeline([['INCR', key], ['EXPIRE', key, 2 * 24 * 3600]]);
    if (Number(count) > LIMIT) {
      return res.status(429).json({ code: 'limit', error: `Today's ${LIMIT} questions are used up. The adviser opens again at midnight (Muscat).`, remaining: 0, limit: LIMIT });
    }
    const remaining = Math.max(0, LIMIT - Number(count));
    const giveBack = () => kv.command('DECR', key).catch(() => {});

    const client = new Anthropic();
    const history = cleanHistory(body.history);
    try {
      // 1. Cheap check on the question alone: dashboard, change request, or off-topic.
      const lastQ = [...history].reverse().find((m) => m.role === 'user');
      const gate = await client.messages.create({
        model: GATE_MODEL,
        max_tokens: 5,
        system: GATE,
        messages: [{ role: 'user', content: `${lastQ ? `Previous question: ${lastQ.content.slice(0, 300)}\n` : ''}New message: ${question}` }],
      });
      const verdict = textOf(gate).toUpperCase();
      if (verdict.startsWith('OFF')) return res.status(200).json({ answer: OFF_TOPIC, kind: 'off-topic', remaining, limit: LIMIT });
      if (verdict.startsWith('CHANGE')) return res.status(200).json({ answer: READ_ONLY, kind: 'read-only', remaining, limit: LIMIT });

      // Opus for complex questions, while today's deep allowance lasts.
      let model = MODEL;
      let deep = false;
      if (verdict.startsWith('COMPLEX')) {
        const dk = `advisor:deep:${muscatToday()}`;
        const [dn] = await kv.pipeline([['INCR', dk], ['EXPIRE', dk, 2 * 24 * 3600]]);
        if (Number(dn) <= DEEP_LIMIT) { model = DEEP_MODEL; deep = true; }
      }

      // 2. The real answer, from the dashboard snapshot.
      const base = (process.env.DASHBOARD_URL || `https://${req.headers.host}`).replace(/\/$/, '');
      const snapshot = await buildContext(base, muscatToday());
      const msg = await client.beta.messages.create({
        model,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: [
          { type: 'text', text: SYSTEM },
          // Cached, so a follow-up within a few minutes re-reads it cheaply.
          { type: 'text', text: `Dashboard snapshot:\n\n${snapshot}`, cache_control: { type: 'ephemeral' } },
        ],
        messages: [...history, { role: 'user', content: question }],
      });
      if (msg.stop_reason === 'refusal') {
        return res.status(200).json({ answer: "I can't help with that one. Ask me about the dashboard's data or what to improve.", kind: 'refusal', remaining, limit: LIMIT });
      }
      const answer = textOf(msg) || 'I could not put an answer together. Please try rephrasing.';
      return res.status(200).json({ answer, kind: 'answer', deep, model, remaining, limit: LIMIT, usage: msg.usage && { in: msg.usage.input_tokens, out: msg.usage.output_tokens, cached: msg.usage.cache_read_input_tokens } });
    } catch (err) {
      await giveBack();
      console.error('advisor failed:', err);
      const status = err && err.status;
      const credit = status === 400 && /credit|balance|billing/i.test(String(err.message));
      return res.status(502).json({
        code: credit ? 'credit' : 'failed',
        error: credit ? 'The adviser is out of credit. Add funds in the Claude Console.' : 'The adviser could not answer just now. It did not count toward today\'s limit; please try again.',
      });
    }
  } catch (err) {
    console.error('advisor error:', err);
    return res.status(500).json({ error: err.message });
  }
};
