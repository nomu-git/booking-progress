// KPIs tab (Corporate) and the daily KPI message in Slack (Muatasam via Anton,
// 12 Oct 2026): every sales and marketing KPI in one place, each simply
// Passed or Failed, with why and what to adjust. Operations KPIs are left
// out for now, as asked.
//
// Every figure is computed the way its own tab computes it, from the same
// builders: bookings from the Report (booking-report.js), leads and high
// potential from ManyChat's automatic count (lib/manychat.js; Marina's sheet
// until 25 Oct 2026, Anton: "refer ... to the Manychat Automatic tabs and not
// anymore to Marina's sheet"), campaigns from
// api/campaigns.js (cost per result, lead quality, budget) and posts and
// artwork from the monday marketing calendar (lib/calendar.js). Engagement
// rate was removed everywhere (Anton, 19 Oct 2026). Targets already set on the
// dashboard are reused; the others are marked "proposed" below and in the
// tab, until Muatasam confirms them.

const manychat = require('./manychat');
const calendar = require('./calendar');

const T = {
  bookingsWeek: Number(process.env.WEEKLY_BOOKING_TARGET || 12),
  leadsDay: Number(process.env.LEADS_DAILY_TARGET || 20),
  hpDay: Number(process.env.HP_DAILY_TARGET || 5),
  conversion: 0.10,
  // Proposed (12 Oct 2026) until Muatasam confirms them.
  postsWeek: Number(process.env.KPI_POSTS_WEEK || 3),
  planned14: Number(process.env.KPI_PLANNED_14 || 6),
};

const omanToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const muscatDay = (at) => new Date(Date.parse(at) + 4 * 3600 * 1000).toISOString().slice(0, 10);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const n1 = (x) => (Math.round(x * 10) / 10).toString();
const sar = (x) => `SAR ${Number(x).toFixed(2)}`;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dname = (day) => { const d = new Date(`${day}T00:00:00Z`); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

// What each KPI is, shown when hovering its name.
const ABOUT = {
  'Bookings this week': 'Bookings taken since Sunday (Muscat time) against the weekly target of 12, judged on pace: by today there should be 12 ÷ 7 × the days gone so far. Charters are left out. Same count as the Reports tab.',
  'Leads per day': "Average new leads per day, WhatsApp and Instagram together, counted automatically by ManyChat (each new contact, once per 30 days). This week once 3 full days have passed, otherwise last week; today isn't counted until it's over. Same numbers as Leads › ManyChat · automatic.",
  'High potential leads per day': 'Average high-potential (HP) leads per day: contacts tagged HP in ManyChat by whoever is chatting, on the day the tag is added. Same days as Leads per day.',
  'Conversion (bookings ÷ leads)': "All bookings taken on the same days divided by ManyChat's leads on those days, every project and channel together. Same as the conversion on Leads › ManyChat · automatic.",
  'Cost per result': "What one result cost: spend ÷ results, year to date, live from Meta. A result is the campaign's goal (messages, leads or purchases). Judged once the campaign has 5 results.",
  'Campaigns bringing high potential leads': "Each running campaign is matched to its project's leads since it started (ManyChat from 21 Oct 2026, by the lead's Trip tag; Marina's sheet before) (EB-ZNZ-EX = ZNZ|EX). Bad = 5+ leads and no high potential, or under 10% high potential. Same as the lead quality panel on Campaign Ads.",
  'Campaign spend within budget': "Live Meta spend against the Budget Plan (Marketing › Campaigns › This year › Budget Plan). Fails if a running campaign has spent more than its planned budget, a running campaign is not in the plan, or the current budget period is on course to spend more than its money at the pace of the days so far.",
  'Posts in the last 7 days': 'Posts marked Posted on the monday marketing calendar (or Scheduled with a date already reached) over the last 7 days. Read live, so it no longer waits for the weekly social media sheet update.',
  'Artwork ready a week before posting': 'From the monday marketing calendar: every post due in the next 7 days, and any past post not done, must have its artwork Approved, Scheduled or Posted. Working on it, Pending Review, Revision Needed or no status counts as not ready.',
  'Posts planned for the next 2 weeks': 'Posts with a date on the monday marketing calendar for the next 14 days.',
};

function kpi(area, name, target, pass, why, action, extra = {}) {
  return { area, name, target, about: ABOUT[extra.group || name] || null, status: pass == null ? 'na' : pass ? 'pass' : 'fail', why, action: pass ? (extra.keep || 'On track, keep it up.') : action, ...extra };
}
const na = (area, name, target, err) => ({ area, name, target, about: ABOUT[name] || null, status: 'na', why: `Couldn't check: ${err}`, action: 'Check the source is reachable.' });

// `only` (a Set of days) limits it to the days whose leads are counted, so
// conversion never divides bookings from unlogged days (today) by the leads
// (22 Oct 2026).
function bookingsFor(report, start, end, only) {
  let n = 0;
  for (const e of report.events || []) {
    if (e.x || !e.n) continue;
    const d = muscatDay(e.at);
    if (d >= start && d <= end && (!only || only.has(d))) n += e.n;
  }
  return n;
}

// ---- Sales ----
function salesKpis(report, mc, today) {
  const out = [];
  const S = 'Sales';
  if (report) {
    const ws = report.weekStart;
    const elapsed = Math.min(7, Math.round((Date.parse(today) - Date.parse(ws)) / 86400000) + 1);
    const n = bookingsFor(report, ws, today);
    const expected = (T.bookingsWeek / 7) * elapsed;
    out.push(kpi(S, 'Bookings this week', `${T.bookingsWeek} a week, on pace`, n >= expected,
      `${n} of ${T.bookingsWeek} by day ${elapsed} of 7; about ${Math.ceil(expected)} expected by now.`,
      'Follow up high-potential leads today and push the offer on trips with open seats.'));
  } else {
    out.push(na(S, 'Bookings this week', `${T.bookingsWeek} a week`, 'WeTravel'));
  }

  // Leads, HP and conversion from ManyChat's automatic count (25 Oct 2026).
  const L = mcWeek(mc, today);
  if (!L) {
    const why = mc && mc.error ? mc.error : 'ManyChat has no full day counted yet';
    out.push(na(S, 'Leads per day', `${T.leadsDay} a day`, why));
    out.push(na(S, 'High potential leads per day', `${T.hpDay} a day`, why));
    out.push(na(S, 'Conversion (bookings ÷ leads)', `${pct(T.conversion)} or more`, why));
    return out;
  }
  const { days, label } = L;
  const total = days.reduce((s, d) => s + d.total, 0);
  const perDay = total / days.length;
  const hp = days.reduce((s, d) => s + d.hp, 0);
  const hpPerDay = hp / days.length;
  const hit = days.filter((d) => d.total >= T.leadsDay).length;
  const nd = `${days.length} day${days.length === 1 ? '' : 's'}`;

  out.push(kpi(S, 'Leads per day', `${T.leadsDay} a day`, perDay >= T.leadsDay,
    `${n1(perDay)} a day ${label} (${total} leads over ${nd}); ${hit} of ${days.length} days reached ${T.leadsDay}.`,
    'Boost the posts that bring the most messages, or add budget to campaigns under the cost limit.'));
  out.push(kpi(S, 'High potential leads per day', `${T.hpDay} a day`, hpPerDay >= T.hpDay,
    `${n1(hpPerDay)} a day ${label} (${hp} tagged HP in ${nd}).`,
    'Qualify leads in the first reply (trip, dates, budget), tag them HP in ManyChat, and fix campaigns that bring no high potential leads.'));
  // Conversion: bookings on exactly the days whose leads are counted.
  if (report) {
    const b = bookingsFor(report, days[0].date, days[days.length - 1].date, new Set(days.map((d) => d.date)));
    const rate = total ? b / total : null;
    out.push(kpi(S, 'Conversion (bookings ÷ leads)', `${pct(T.conversion)} or more`, rate == null ? null : rate >= T.conversion,
      rate == null ? `No leads ${label} to divide by.` : `${pct(rate, 1)} ${label}: ${b} bookings from ${total} leads (same ${nd}).`,
      'Follow up every high-potential lead within 24 hours, and find out what stops leads from choosing a trip.'));
  } else {
    out.push(na(S, 'Conversion (bookings ÷ leads)', `${pct(T.conversion)} or more`, 'WeTravel'));
  }
  return out;
}

// The week the lead KPIs judge, from ManyChat's daily counts: this week
// (Sunday to Saturday, Muscat) once it has 3 finished days, otherwise last
// week. Only finished days count (today is still filling up), and only days
// since ManyChat started counting.
function mcWeek(mc, today) {
  if (!mc || !mc.first || !Array.isArray(mc.days)) return null;
  const by = new Map(mc.days.map((d) => [d.date, d]));
  const yesterday = addDays(today, -1);
  const span = (start, end) => {
    const out = [];
    for (let d = start < mc.first ? mc.first : start; d <= end && d <= yesterday; d = addDays(d, 1)) {
      const x = by.get(d) || {};
      out.push({ date: d, total: x.leads || 0, hp: x.hp || 0 });
    }
    return out;
  };
  const ws = addDays(today, -new Date(`${today}T00:00:00Z`).getUTCDay());
  let days = span(ws, addDays(ws, 6));
  let label = 'this week so far';
  if (days.length < 3) {
    const ls = addDays(ws, -7);
    const prev = span(ls, addDays(ws, -1));
    if (prev.length) { days = prev; label = `last week (${dname(prev[0].date)} – ${dname(addDays(ws, -1))})`; }
  }
  if (!days.length) return null;
  return { days, label };
}

// ---- Marketing ----
function marketingKpis(campaigns, cal, today, errors) {
  const out = [];
  const M = 'Marketing';
  if (campaigns) {
    const running = (campaigns.campaigns || []).filter((c) => c.status === 'Active');
    const lim = (campaigns.cprLimit && campaigns.cprLimit.report) || 25;
    const minR = (campaigns.cprLimit && campaigns.cprLimit.minResults) || 5;
    for (const c of running) {
      const early = (c.results || 0) < minR;
      out.push(kpi(M, `Cost per result · ${c.name}`, `SAR ${lim} or less`, !c.cprOver,
        c.costPerResult == null ? 'No results yet.'
          : early ? `${sar(c.costPerResult)} per result, but only ${c.results} results so far (judged from ${minR}).`
            : `${sar(c.costPerResult)} per result, ${c.cprOver ? `${n1(c.costPerResult / lim)}x the limit` : 'within the limit'} (${c.results} results).`,
        `Refresh the creative or narrow the audience; pause it if it stays over SAR ${lim} for a few more days.`,
        { group: 'Cost per result' }));
    }
    if (!running.length) out.push(kpi(M, 'Cost per result', `SAR ${lim} or less`, null, 'No campaign is running.', ''));
    const linked = running.filter((c) => c.leadQuality && c.leadQuality.linked);
    const bad = linked.filter((c) => c.leadQuality.status === 'Bad');
    out.push(kpi(M, 'Campaigns bringing high potential leads', 'No running campaign rated Bad', linked.length ? !bad.length : null,
      linked.length ? (bad.length ? `${bad.length} of ${linked.length} running campaigns rated Bad: ${bad.map((c) => c.name).join(', ')}.` : `None of ${linked.length} running campaigns rated Bad.`) : 'No running campaign can be matched to leads.',
      'Change the audience or message of the Bad campaigns, or move their budget to ones that bring high potential leads.',
      { details: running.map((c) => ({ label: c.name, value: c.leadQuality && c.leadQuality.linked ? `${c.leadQuality.status || 'Not judged'} · ${c.leadQuality.leads} leads, ${c.leadQuality.hp ?? '—'} HP` : 'Not linked (no project in the name)' })), detailTitle: 'Running campaigns' }));
    // Against the Budget Plan set on the dashboard (lib/budget-plan.js).
    const bp = campaigns.budgetPlan || {};
    const over = running.filter((c) => c.usedPct != null && c.usedPct > 1);
    const outside = running.filter((c) => !c.inPlan);
    const per = (bp.periods || []).find((x) => x.current);
    const perOver = per && per.projected != null && per.projected > per.amountSar;
    const issues = [];
    if (over.length) issues.push(`Over its planned budget: ${over.map((c) => `${c.name} (${pct(c.usedPct)})`).join(', ')}.`);
    if (outside.length) issues.push(`Running but not in the Budget Plan: ${outside.map((c) => c.name).join(', ')}.`);
    if (perOver) issues.push(`${per.name}: ${sar(per.spent)} spent of ${sar(per.amountSar)}; at ${sar(per.perDayActual)} a day it would reach ${sar(per.projected)}${per.runsOut ? ` and run out on ${dname(per.runsOut)}` : ''}.`);
    const okWhy = per
      ? `All ${running.length} running campaigns are in the plan and within budget. ${per.name}: ${sar(per.spent)} spent of ${sar(per.amountSar)}.`
      : `All ${running.length} running campaigns are in the plan and within budget.`;
    out.push(kpi(M, 'Campaign spend within budget', 'Within the Budget Plan', running.length || per ? !issues.length : null,
      issues.length ? issues.join(' ') : okWhy,
      perOver ? 'Lower the daily budgets (or pause a campaign) so the period lasts to its end date, or add money to the period in the Budget Plan.'
        : 'Lower the daily budget of the campaigns over budget, pause them, or add them to the Budget Plan.'));
  } else {
    out.push(na(M, 'Cost per result', 'SAR 25 or less', errors.campaigns || 'Meta'));
  }

  if (cal) {
    const show = (p) => ({ label: p.name, value: `${p.status} · posts ${dname(p.date)}${p.overdue ? ' (past due)' : ''} · artwork due ${dname(p.artworkDue)}` });
    const pending = cal.posts.filter((p) => !p.ready && p.date <= addDays(today, 13));
    out.push(kpi(M, 'Artwork ready a week before posting', `Ready ${cal.leadDays} days before the post`, !cal.late.length,
      cal.late.length ? `${cal.late.length} post${cal.late.length === 1 ? '' : 's'} due within a week (or past) without approved artwork.` : 'Every post due within a week has its artwork ready.',
      'Chase the late artwork now; anything not approved a week before its post date is at risk.',
      { details: (cal.late.length ? cal.late : pending).map(show), detailTitle: cal.late.length ? 'Artwork not ready' : 'Not ready yet (not late)' }));
    const from = addDays(today, -6);
    const pub = cal.published || [];
    out.push(kpi(M, 'Posts in the last 7 days', `${T.postsWeek} or more (proposed)`, pub.length >= T.postsWeek,
      `${pub.length} post${pub.length === 1 ? '' : 's'} marked Posted on the monday calendar from ${dname(from)} to today.`,
      `Post at least ${T.postsWeek} times a week, and mark each post Posted on the monday calendar once it's live.`,
      { details: pub.map((p) => ({ label: p.name, value: `${p.status} · ${dname(p.date)}` })), detailTitle: 'Posted in the last 7 days' }));
    out.push(kpi(M, 'Posts planned for the next 2 weeks', `${T.planned14} or more (proposed)`, cal.next14.length >= T.planned14,
      `${cal.next14.length} posts on the monday calendar from today to ${dname(addDays(today, 13))}.`,
      `Plan at least ${T.planned14} posts for the next two weeks (${T.postsWeek} a week).`,
      { details: cal.next14.map(show), detailTitle: 'Planned posts' }));
  } else {
    out.push(na(M, 'Artwork ready a week before posting', '7 days before the post', errors.calendar || 'monday.com'));
  }
  return out;
}

async function load() {
  const { build: buildReport } = require('../api/booking-report');
  const { build: buildCampaigns } = require('../api/campaigns');
  const settle = (p) => p.then((v) => ({ v }), (e) => ({ e: e.message }));
  const [report, mc, campaigns, cal] = await Promise.all([
    settle(buildReport()),
    settle(manychat.load()),
    settle(buildCampaigns()),
    settle(calendar.load().then((x) => calendar.build(x))),
  ]);
  return { report, mc, campaigns, cal };
}

function build(src, today = omanToday()) {
  const errors = {};
  for (const k of Object.keys(src)) if (src[k].e) errors[k] = src[k].e;
  const v = (k) => src[k].v || null;
  const kpis = [...salesKpis(v('report'), v('mc'), today), ...marketingKpis(v('campaigns'), v('cal'), today, errors)];
  return {
    asOf: new Date().toISOString(),
    today,
    passed: kpis.filter((k) => k.status === 'pass').length,
    failed: kpis.filter((k) => k.status === 'fail').length,
    unchecked: kpis.filter((k) => k.status === 'na').length,
    kpis,
    calendar: v('cal'),
    errors,
  };
}

// ---- Slack (agreed with Muatasam): one short daily message saying which
// KPIs passed and which failed, no raw numbers; and a separate artwork alert
// only when artwork is late. ----
const LINK = process.env.KPI_LINK || 'https://crm.nomuhub.com/#kpis';

function slackKpis(p) {
  // The per-campaign cost rows read as one line each way.
  const names = (status) => {
    const rows = p.kpis.filter((k) => k.status === status);
    const camp = rows.filter((k) => k.group === 'Cost per result').map((k) => k.name.replace(/^Cost per result · /, ''));
    const rest = rows.filter((k) => k.group !== 'Cost per result').map((k) => k.name);
    return { rest, camp };
  };
  const f = names('fail');
  const ok = names('pass');
  const line = (x) => [...x.rest, ...(x.camp.length ? [`Cost per result: ${x.camp.join(', ')}`] : [])];
  const failed = line(f);
  const passed = line(ok);
  const text = [
    `📊 *Daily KPIs · ${dname(p.today)}*`,
    failed.length ? `❌ *Failed*\n${failed.map((t) => `• ${t}`).join('\n')}` : '❌ *Failed*: none',
    passed.length ? `✅ *Passed*\n${passed.map((t) => `• ${t}`).join('\n')}` : '✅ *Passed*: none',
    `Why and what to adjust: ${LINK}`,
  ].join('\n\n');
  return { text: text.replace(/\*/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

function slackArtwork(p) {
  const late = (p.calendar && p.calendar.late) || [];
  if (!late.length) return null;
  const text = [
    `🎨 *Artwork not ready · ${late.length} post${late.length === 1 ? '' : 's'}*`,
    `Artwork should be ready ${p.calendar.leadDays} days before posting:`,
    ...late.map((x) => `• *${x.name}* · posts ${dname(x.date)}${x.overdue ? ' (past due)' : ''} · ${x.status}`),
    `Marketing calendar on monday.com · ${LINK}`,
  ].join('\n');
  return { text: text.replace(/\*/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

module.exports = { load, build, T, slackKpis, slackArtwork };
