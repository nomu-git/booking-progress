// KPIs tab (Corporate) and the daily KPI message in Slack (Muatasam via Anton,
// 12 Oct 2026): every sales and marketing KPI in one place, each simply
// Passed or Failed, with why and what to adjust. Operations KPIs are left
// out for now, as asked.
//
// Every figure is computed the way its own tab computes it, from the same
// builders: bookings from the Report (booking-report.js), leads and high
// potential from the Leads sheet (lib/tabs/leads.js), campaigns from
// api/campaigns.js (cost per result, lead quality, budget), engagement from
// Maryam's sheet (lib/tabs/engagements.js) and artwork from the monday
// marketing calendar (lib/calendar.js). Targets already set on the
// dashboard are reused; the others are marked "proposed" below and in the
// tab, until Muatasam confirms them.

const { fetchWorkbook } = require('./sheet');
const leadsTab = require('./tabs/leads');
const engTab = require('./tabs/engagements');
const calendar = require('./calendar');

const T = {
  bookingsWeek: Number(process.env.WEEKLY_BOOKING_TARGET || 12),
  leadsDay: Number(process.env.LEADS_DAILY_TARGET || 20),
  hpDay: Number(process.env.HP_DAILY_TARGET || 5),
  conversion: 0.10,
  // Proposed (12 Oct 2026) until Muatasam confirms them.
  engagement: Number(process.env.KPI_ENGAGEMENT || 0.01),
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
  'Bookings this week': 'Bookings taken since Sunday (Muscat time) against the weekly target of 12, judged on pace: by today there should be 12 ÷ 7 × the days gone so far. Charters are left out. Same count as the Report tab.',
  'Leads per day': "Average leads per logged day, WhatsApp and Instagram together, from Marina's leads sheet. This week once 3 days are logged, otherwise last week. Same numbers as the Leads tab.",
  'High potential leads per day': 'Average high-potential (HP) leads per day, as Marina marks them in the leads sheet. Same week as Leads per day.',
  'Conversion (bookings ÷ leads)': 'All bookings taken in the week divided by all leads that week, every project and channel together. Same as the overall conversion on the Leads tab.',
  'Leads sheet up to date': "Checks that yesterday's leads are in Marina's sheet. She logs each day around 6 PM; a missing day holds back every lead KPI above.",
  'Cost per result': "What one result cost: spend ÷ results, year to date, live from Meta. A result is the campaign's goal (messages, leads or purchases). Judged once the campaign has 5 results.",
  'Campaigns bringing high potential leads': "Each running campaign is matched to its project's leads in Marina's sheet since it started (EB-ZNZ-EX = ZNZ|EX). Bad = 5+ leads and no high potential, or under 10% high potential. Same as the lead quality panel on Campaign Ads.",
  'Campaign spend within budget': "Spend so far this year, live from Meta, against each running campaign's budget in the media plan (Updated Budget.xlsx, matched by project), or an assumed $500 when it has no plan line. Fails if any running campaign has spent more than its budget.",
  'Engagement rate (posts)': "Likes + comments + shares + saves divided by views, for this month's Instagram posts in Maryam's sheet. Same as the Engagements tab.",
  'Posts in the last 7 days': 'Posts marked Posted on the monday marketing calendar (or Scheduled with a date already reached) over the last 7 days. Read live, so it no longer waits for the weekly social media sheet update.',
  'Artwork ready a week before posting': 'From the monday marketing calendar: every post due in the next 7 days, and any past post not done, must have its artwork Approved, Scheduled or Posted. Working on it, Pending Review, Revision Needed or no status counts as not ready.',
  'Posts planned for the next 2 weeks': 'Posts with a date on the monday marketing calendar for the next 14 days.',
};

function kpi(area, name, target, pass, why, action, extra = {}) {
  return { area, name, target, about: ABOUT[extra.group || name] || null, status: pass == null ? 'na' : pass ? 'pass' : 'fail', why, action: pass ? (extra.keep || 'On track, keep it up.') : action, ...extra };
}
const na = (area, name, target, err) => ({ area, name, target, about: ABOUT[name] || null, status: 'na', why: `Couldn't check: ${err}`, action: 'Check the source is reachable.' });

function bookingsFor(report, start, end) {
  let n = 0;
  for (const e of report.events || []) {
    if (e.x || !e.n) continue;
    const d = muscatDay(e.at);
    if (d >= start && d <= end) n += e.n;
  }
  return n;
}

// ---- Sales ----
function salesKpis(report, leads, today) {
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

  if (!leads) {
    out.push(na(S, 'Leads per day', `${T.leadsDay} a day`, 'the leads sheet'));
    return out;
  }
  // Same weeks as the Leads tab. Early in a week (under 3 days logged) the
  // previous week is judged instead, so a Sunday doesn't read as a failure.
  const weeks = (leads.weeks || []).filter((w) => w.days);
  const cur = weeks.find((w) => today >= w.start && today <= w.end);
  const logged = (w) => (w.days || []).filter((d) => d.recorded && !d.future);
  const pick = cur && logged(cur).length >= 3 ? cur : weeks.filter((w) => w.end < (cur ? cur.start : today)).pop() || cur;
  if (!pick) return out;
  const days = logged(pick);
  const label = pick === cur ? 'this week so far' : `last week (${pick.label})`;
  const total = days.reduce((s, d) => s + d.total, 0);
  const perDay = days.length ? total / days.length : 0;
  const hpDays = days.filter((d) => d.hp != null);
  const hp = hpDays.reduce((s, d) => s + d.hp, 0);
  const hpPerDay = hpDays.length ? hp / hpDays.length : 0;
  const hit = days.filter((d) => d.total >= T.leadsDay).length;

  out.push(kpi(S, 'Leads per day', `${T.leadsDay} a day`, perDay >= T.leadsDay,
    `${n1(perDay)} a day ${label} (${total} leads over ${days.length} days); ${hit} of ${days.length} days reached ${T.leadsDay}.`,
    'Boost the posts that bring the most messages, or add budget to campaigns under the cost limit.'));
  out.push(kpi(S, 'High potential leads per day', `${T.hpDay} a day`, hpDays.length ? hpPerDay >= T.hpDay : null,
    hpDays.length ? `${n1(hpPerDay)} a day ${label} (${hp} in ${hpDays.length} days).` : 'No high potential recorded for these days.',
    'Qualify leads in the first reply (trip, dates, budget) and fix campaigns that bring no high potential leads.'));
  // Conversion: same week, every booking over every lead, as on the Leads tab.
  if (report) {
    const end = pick.end < today ? pick.end : today;
    const b = bookingsFor(report, pick.start, end);
    const rate = pick.total ? b / pick.total : null;
    out.push(kpi(S, 'Conversion (bookings ÷ leads)', `${pct(T.conversion)} or more`, rate == null ? null : rate >= T.conversion,
      rate == null ? 'No leads to divide by.' : `${pct(rate, 1)} ${label}: ${b} bookings from ${pick.total} leads.`,
      'Follow up every high-potential lead within 24 hours, and find out what stops leads from choosing a trip.'));
  }

  const y = addDays(today, -1);
  const yd = weeks.flatMap((w) => w.days).find((d) => d.date === y);
  out.push(kpi(S, 'Leads sheet up to date', 'Yesterday logged', !!(yd && yd.recorded),
    yd && yd.recorded ? `${dname(y)} is logged (${yd.total} leads).` : `${dname(y)} isn't in the leads sheet yet.`,
    'Ask Marina to log yesterday\'s leads; every lead KPI above depends on it.'));
  return out;
}

// ---- Marketing ----
function marketingKpis(campaigns, eng, cal, today, errors) {
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
    const over = running.filter((c) => c.usedPct != null && c.usedPct > 1);
    out.push(kpi(M, 'Campaign spend within budget', 'No running campaign over budget', running.length ? !over.length : null,
      over.length ? `Over budget: ${over.map((c) => `${c.name} (${pct(c.usedPct)})`).join(', ')}.` : `All ${running.length} running campaigns are within their budget.`,
      'Lower the daily budget of the campaigns over budget, or pause them.'));
  } else {
    out.push(na(M, 'Cost per result', 'SAR 25 or less', errors.campaigns || 'Meta'));
  }

  if (eng) {
    const month = today.slice(0, 7);
    // This month; last month if nothing is recorded yet this month.
    const prev = addDays(`${month}-01`, -1).slice(0, 7);
    const inMonth = (list, m) => (list || []).filter((x) => (x.date || '').startsWith(m));
    let posts = inMonth(eng.posts, month);
    let when = 'this month';
    if (!posts.length) { posts = inMonth(eng.posts, prev); when = 'last month'; }
    const views = posts.reduce((s, p) => s + (p.views || 0), 0);
    const inter = posts.reduce((s, p) => s + (p.interactions || 0), 0);
    out.push(kpi(M, 'Engagement rate (posts)', `${pct(T.engagement)} or more (proposed)`, views ? inter / views >= T.engagement : null,
      views ? `${pct(inter / views, 2)} ${when}: ${inter} interactions on ${views.toLocaleString('en-US')} views over ${posts.length} posts.` : 'No posts recorded.',
      'Repeat the format of the top performing posts (Engagements tab) and end each post with a question or clear call to action.'));
    // Posts in the last 7 days now come from the monday calendar (below), so
    // they don't lag behind the sheet's weekly update (Maryam, 18 Oct 2026).
  } else {
    out.push(na(M, 'Engagement rate (posts)', `${pct(T.engagement)} or more`, errors.engagements || 'the social media sheet'));
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
  const [report, leads, campaigns, eng, cal] = await Promise.all([
    settle(buildReport()),
    settle(fetchWorkbook(leadsTab.envVar).then((wb) => leadsTab.build(wb))),
    settle(buildCampaigns()),
    settle(fetchWorkbook(engTab.envVar).then((wb) => engTab.build(wb))),
    settle(calendar.load().then((x) => calendar.build(x))),
  ]);
  return { report, leads, campaigns, eng, cal };
}

function build(src, today = omanToday()) {
  const errors = {};
  for (const k of Object.keys(src)) if (src[k].e) errors[k] = src[k].e;
  const v = (k) => src[k].v || null;
  const kpis = [...salesKpis(v('report'), v('leads'), today), ...marketingKpis(v('campaigns'), v('eng'), v('cal'), today, errors)];
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
