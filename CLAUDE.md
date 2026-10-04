# CLAUDE.md

Context for any Claude session working on this project — including a fresh
session on a different Claude account. **Update this file at the end of every
session that changes the dashboard**, so the next session (whoever's account
it runs under) has the full picture without re-deriving it from git history.

## What this is

**NomuHub CRM dashboard** — a single-page live dashboard for Nomu (a trip
operator), covering two unrelated things in one app:

- **BOOKING** — live trip/booking data pulled from the **WeTravel Partner
  API**. No database.
- **AD CAMPAIGN** — live Meta (Facebook/Instagram) ad performance pulled from
  the **Meta Marketing/Graph API**, compared against a budget sheet.

Live at **https://bookingprogress.vercel.app**. Repo:
**github.com/nomu-git/booking-progress** (public). Deploys automatically on
every push to `main` via Vercel.

**The primary stakeholder is Muatasam** (Anton's boss). Anton relays
Muatasam's feedback (often screenshots of Slack messages, sometimes typo'd or
terse) and Claude implements it. See "Muatasam's standing preferences" below
— read it before making any UI decision, it will save a round trip.

## Architecture

One static frontend, a folder of Vercel serverless functions, no build step,
no framework.

- `index.html` — the entire frontend. One file: inline `<style>`, inline
  `<script>`, no bundler. ~215,000 characters. Ten views in three sidebar
  categories (`<aside class="sidebar">`, its `<nav id="viewSeg">` holds the
  `data-view` buttons `setView()` drives). Regrouped by Anton, 4 Oct 2026:
  - **SALES**: Booking, Report, Leads
  - **OPERATIONS**: Previous Projects, Trips & R&D, Feedback, Trip Revenue
  - **MARKETING**: Campaign Ads, Engagements. **History Campaign is a
    sub-tab of Campaign Ads**, not a sidebar item: `#adsSub` (a `.seg.subtabs` bar above
    `#campaignsWrap`/`#historyWrap`, shown for either view) switches between
    `setView('campaigns')` and `setView('history')`; the Ads sidebar button
    stays lit for both. Both views keep their own hash (`#campaigns`,
    `#history`), so old links still work.

  Labels only, renamed by Muatasam/Anton, 30 Sep–4 Oct 2026: tab
  "Dashboard" -> "Booking", "Trips" -> "Trips & R&D", "Campaigns" -> "Ads" -> "Campaign Ads" (4 Oct 2026),
  "History" -> "History Campaign" (now the Ads sub-tab "History"); category
  "Booking" -> "Sales", "Ad Campaign" -> "Marketing". Every `data-view`
  value (`board`/`trips`/`campaigns`/`history`/…), file, variable and
  route is unchanged; only visible text and grouping moved. Don't rename the
  underlying names to match; that wasn't asked for.
- **Sidebar**: over 900px it's docked and collapses to a 64px icon rail
  (labels fly out on hover), remembered in `localStorage` as
  `nomuSidebarCollapsed`; a snippet at the top of `<body>` applies it before
  first paint. At 900px and under it's a drawer over the page, opened by the
  header's ☰ (`#sbMenu`), closed by picking a tab, the backdrop, Escape, or
  its own button. State lives as classes on `<html>` (`sb-collapsed`,
  `sb-open`). Everything on the page sits in `.shell`, which carries the old
  body padding and the sidebar offset; the tooltip and modal stay at body
  level because they're fixed-position overlays.
- `api/*.js`: **endpoints only.** CommonJS Vercel functions (`module.exports = async (req, res) => {...}`).
- **Sheet-mirror tabs all go through one function, `api/sheets.js?name=`**
  (`leads`, `engagements`, `trips`, `feedback`, `revenue`). Each tab's
  builder lives in `lib/tabs/<name>.js` and exports `{ build, envVar, ttl }`;
  `api/sheets.js` fetches the workbook from that env var, caches per tab,
  and serves stale on error. The page fetches `/api/sheets?name=<name>`
  (`&refresh=1` to bypass the cache); `vercel.json` rewrites the old
  `/api/leads`, `/api/engagements`, `/api/trips`, `/api/feedback` URLs to
  it. **A new sheet tab = a new `lib/tabs/<name>.js` plus one line in
  `TABS`, never a new file in `api/`.** Merged 30 Sep 2026 when the site
  sat at exactly 12 functions and Trip Revenue would have been the 13th.
- `lib/*.js`: shared helpers (`wetravel`, `meta-ads`, `trip-code`, `xlsx`,
  `sheet`), required as `require('../lib/…')`. They live outside
  `api/` on purpose: Vercel turns **every** file in `api/` into a function,
  and the Hobby plan allows **12 per deployment**. See the pitfall below.
  Each also exports `build()` separately where another function needs its
  logic (e.g. `slack-notify.js` calls `booking-report.js`'s `build()`).
- No `package.json` dependencies really used — Node's built-in `fetch`.
  `node_modules/` in git is leftover cruft from an old Google Sheets version;
  ignore it.
- `vercel.json` — one cron: `/api/slack-notify` daily at 04:00 UTC (08:00
  Muscat). Hobby only allows daily crons, so anything more frequent is
  triggered from outside: **cron-job.org** calls the campaign alerts every 2
  minutes (see "Campaign on/off alerts" below). GitHub Actions was tried
  first and its schedule never fired once in 5 hours, so it was removed.

### Booking side

| File | Role |
| --- | --- |
| `lib/wetravel.js` | Shared WeTravel client. `WETRAVEL_API_KEY` is a **refresh token**, exchanged here for a 1-hour access token (cached, retried on 429/401). Also exports `mapWithConcurrency`. |
| `api/trips-progress.js` | Booking tab (sidebar label; was "Dashboard") — live/upcoming departures, per-week booking bars. Keeps a departure for its whole month, drops it once the month passes. |
| `api/previous-trips.js` | Previous Projects tab — the complement of trips-progress: everything whose month has already passed. `end < monthStart` is the exact filter, so a trip is never in both views or neither. |
| `api/booking-report.js` | Report tab — flat list of booking events, last 300 days by default. Exports `build()`, reused by `slack-notify.js`. |
| `api/slack-notify.js` | Cron target — posts the day's new bookings to Slack. `?preview=1` renders without posting. Gated by `CRON_SECRET` if set. |
| `api/announcement.js` | Banner text from env vars, editable without a code change. |
| `lib/trip-code.js` | **Shared** by both booking and ad-campaign sides — see "Project code scheme" below. |

Full env-var reference for the booking side (required/recommended/optional,
with defaults) is in **`README.md`** — don't duplicate it here, it's kept
current there. The one thing worth repeating: **changing an env var in
Vercel requires a redeploy to take effect** — this has bitten the project
before (a blank dashboard after an account migration turned out to be an
env var that was set but never redeployed).

A few more operational details from `README.md` worth having here directly,
since they're easy to forget mid-session:

- **Vercel Hobby plan runs the daily cron at an approximate time**, not on
  the minute (Pro does). `slack-notify.js` tolerates ±30 min of drift when
  picking its reporting window to compensate — don't "fix" an off-by-a-bit
  cron trigger time, it's expected.
- **No double-posting, and no stored state to prevent it.** Each Slack run
  reports exactly the 24h since the *previous scheduled boundary* (not
  "since last successful post"), so consecutive daily messages tile the
  calendar without gaps or overlap on their own — this only holds if the
  cron actually fires roughly on schedule.
- **`node_modules/` is committed but dead** — leftover `googleapis` packages
  from an earlier Google Sheets-backed version of this project, before it
  moved to reading WeTravel/Meta live. Nothing imports them (`fetch` is
  Node's built-in). `.gitignore` already excludes `node_modules/` going
  forward; the committed copy is just historical baggage, safe to `git rm`
  in a cleanup pass if anyone gets around to it.

### Ad Campaign side

| File | Role |
| --- | --- |
| `lib/meta-ads.js` | Shared Meta Graph API client. `graphGet`/`graphGetAll` (follows Meta's cursor pagination), `getAccountMeta`, `toReportCurrency`/`budgetToReportCurrency` (USD→SAR conversion), `AD_ACCOUNTS` (env `META_AD_ACCOUNT_IDS`, default two accounts), `REPORT_CURRENCY` (env `META_CURRENCY`, default `SAR`), `USD_SAR` (env `META_USD_SAR`, default `3.75`). Token comes from whichever of `META_ACCESS_TOKEN` / `META_ACCESS_KEY` / `META_API_KEY` is set. |
| `api/campaigns.js` | **Campaign Ads tab** (sidebar label; was "Campaigns", then "Ads"). Current year only (env `META_YEAR`, defaults to current calendar year — so this auto-rolls into 2027 with no code change). Every campaign gets its own budget (see "Budget matching" below), live spend/results/purchases from Meta. |
| `api/campaign-history.js` | **History Campaign tab** (sidebar label; was "History"). One full calendar year at a time, picked via `?year=`. **Deliberately excludes the current year** — that's what Ads is for. Offers years back to Meta's retention floor (~37 months, env `META_RETENTION_MONTHS`). Every campaign uses a flat assumed budget (env `META_DEFAULT_BUDGET_USD`, default `$500`) since there's no budget sheet for past years. |
| `api/media-plan.js` | Reads `Updated Budget.xlsx` — hardcoded `ROWS` array transcribed **verbatim** from the spreadsheet's "Media Plan" sheet. This is the *plan*, not measured data. If the spreadsheet changes, this array has to be hand-updated to match — there's no live file parsing. |
| `lib/trip-code.js` | The project-code generator — see below. |

**Budget matching (important, was broken once already):** Meta campaign
names come in two eras — old descriptive names ("ZNZ Build MSG - 2026") and
the newer code form ("ZNZ-BL-202609-02C", after Muatasam renamed them in Ads
Manager). Both `campaigns.js` and `campaign-history.js` resolve a campaign to
a **destination + programme pair** (e.g. `ZNZ-BL`) via `trip-code.js`'s
`classify()`, and match that pair against `media-plan.js`'s plan lines,
which are also resolved to the same pair. **Deliberately not matched on
month** — the plan's dates are the *trip's* window, a campaign's are the *ad
flight's*, and a December trip is advertised months earlier; matching month
put the wrong budget on the wrong campaign in an earlier version. A campaign
that can't be resolved to a plan line falls back to `META_DEFAULT_BUDGET_USD`
($500) rather than showing a dash.

### Project code scheme

Muatasam's naming convention, used to label trips on Previous Projects **and**
to match ad campaigns to budget lines. Lives in `lib/trip-code.js`, shared by
`api/previous-trips.js` and `api/campaigns.js` so a code means the same thing
on both sides of the dashboard.

Format: **`{DESTINATION}-{PROGRAMME}-{YYYYMM}-{WEEKS}{B2B/C}`**
Example: `BA-EX-202608-01C` = Bali, Explore, started August 2026, 1 week, B2C.

Current vocabulary (his list, verbatim):

```
Destinations: JP=Japan, ZNZ=Zanzibar, TH=Thailand, VN=Vietnam, KO=Korea,
              NP=Nepal, KN=Kenya, SAL=Salalah, SL=Sri Lanka, PH=Philippines,
              BA=Bali
Programmes:   WL=Wellness, EX=Explore, BL=Building, TA=Teaching, MED=Medical
```

**A trip that can't be resolved to both a destination and a programme keeps
its original WeTravel title instead of getting a guessed code** — a wrong
code is worse than no code once people start referring to a project by it.
As of the last count, **145 of 232 historical trips code cleanly**; the rest
need entries Muatasam hasn't sent yet:

- Programmes not on the list: Construction (36 trips — the single biggest
  gap, possibly the old word for Building?), Safari/Maasai, Sustainability,
  Renovation, Community Development
- Destinations not on the list: Morocco, AlUla, Aseer, Maldives, Italy/Sardinia,
  Oman/Muscat, South Africa, Arusha (mainland Tanzania, not Zanzibar)

**B2B detection**: read off partner names in the trip title (`B2B_MARKERS` in
`trip-code.js`) — CISCO, KUMSA, UoS, Sharjah, KBBS, KMSSAI, ADQ, EGA, Etihad,
university, Dar Al Hikma, "Private Trip", "Giving Hands" — plus the existing
charter flag. Confirmed correct by Muatasam.

**Duplicate codes**: the format has no day or run number, so two runs of the
same project in one month collide (e.g. Thailand Teaching starting 15 Dec and
22 Dec 2024 both generate `TH-TA-202412-01C`). Resolved in
`previous-trips.js` (not `trip-code.js` — it's a property of the whole list,
not one trip in isolation): earliest start in the month keeps the bare code,
later ones get `-A`, `-B`, ... appended, in start order.

**When Muatasam sends new destinations/programmes**: add them to the
`DESTINATIONS`/`PROGRAMMES` arrays in `trip-code.js` — one line each, code
first, then every way it might be written (both the long form and the short
code itself, since a campaign already renamed to the scheme has to resolve
back to the same pair — see the vocabulary-sharing regression noted below).

## Muatasam's standing preferences

Distilled from repeated, sometimes blunt feedback across many rounds. Apply
these by default rather than waiting to be told again:

- **Strip to the essentials.** His most direct feedback: *"Dont give me half
  cooked solution... A lot not clear naming / I dont want other dashboards /
  Remove anything not needed from here"* and *"Keep it simple."* Every tab
  rebuild since has followed the same pattern: 1–2 panels, a hero
  number/comparison, one table. No extra charts, no explanatory paragraphs,
  no accordion-everything.
- **Live data only, never fabricated or historical-masquerading-as-current.**
  Ads tab must reflect what Meta says *right now*.
- **Every number needs a bar or visual, not just digits.** *"There is no
  bar"* was a direct complaint.
- **Names must be exactly what's in Meta, not edited/guessed.** He renames
  campaigns himself in Ads Manager; the dashboard mirrors it live on next
  refresh, never invents or corrects a name.
- **Explain reasoning briefly when relaying to him, but keep Slack updates
  very short.** He wants short, direct messages — no long explanations, no
  em dashes (explicit instruction), say what changed plainly.
- **When a request is ambiguous, state the assumption made and flag it for
  him to confirm** rather than silently picking one reading. Several rounds
  of rework happened because an ambiguous instruction was read too narrowly
  or too broadly the first time.
- **When two requests conflict or an assumption will look surprising** (e.g.
  a flat $500 default budget makes historical campaigns show 100–400% over
  budget), say so explicitly rather than let him discover it.

## Known pitfalls (already hit once — don't reintroduce)

- **`esc()` vs `attr()`.** The page's `esc()` goes through `textContent` →
  `innerHTML`, which escapes `& < >` but **not quotes**. Fine for text nodes;
  breaks anything interpolated into an HTML attribute (the first embedded
  `"` ends the attribute early, e.g. `data-tip="...` silently truncates and a
  later `class="tt"` in the string terminates it, producing an empty
  tooltip). Use `attr()` for anything going inside a `"..."` attribute.
- **Hover triggers must sit on the smallest element that visually represents
  the word**, not the containing block. A `<th>` or a `<div>` label is padded
  and full-width; hanging `data-help`/`data-tip` off it fires the tooltip
  with the pointer nowhere near the visible text. Wrap the word in a `<span>`
  and put the trigger there.
- **A re-render can destroy the hovered element**, so its `mouseleave` never
  fires and a tooltip gets stuck on screen describing content that's gone.
  Every `bindHelp`/`bindViz`-style rebind must explicitly hide any open
  tooltip first (see `hideTip()` in `index.html`), and dismiss on `scroll`
  too (scrolling moves the table out from under a pointer that never moved).
- **Sharing a name-matching vocabulary between two files is fragile if one
  list only has the "written out" spellings.** The `trip-code.js` refactor
  briefly broke Campaigns' budget matching (17/21 → 7/21) because the shared
  `DESTINATIONS`/`PROGRAMMES` lists only recognized long-form words like
  "explore", not the short code itself ("EX") — so a campaign already
  renamed to `ZNZ-BL-202609-02C` no longer matched. Every vocabulary entry
  needs the code itself listed as a recognized spelling of itself.
- **Dead-code sweeps after a UI strip-down are easy to over- or
  under-reach.** One earlier "remove what's not needed" pass deleted the
  Previous Trips tab's entire stylesheet by accident (it lived next to CSS
  that genuinely was being removed) — that tab shipped unstyled in
  production for a while before it was caught. When deleting CSS/JS during a
  simplification pass, grep every removed class name and function identifier
  across the **whole** file afterward, not just the section being edited.
- **Generic class names collide with old rules.** A Leads chart axis was
  given `class="laxis weeks"`, and `.weeks` (line ~142, the trip cards'
  week meters) is `flex-direction: column`, so the axis rendered as a
  vertical list. Before naming a new class, grep for a *standalone*
  selector of that name (`^\s*\.name\b`), not just rules starting with
  your prefix. New feature classes here are prefixed (`l*` for leads).
- **Vercel Hobby caps a deployment at 12 serverless functions, and every
  file in `api/` counts, helpers included.** Adding two helper modules to
  `api/` took it from 11 to 13, and every deploy after that failed while
  the live site sat on the last good build. From the outside the only sign
  was "the new page never shows up". Helpers go in `lib/`. To check a
  deploy, the repo is public, so Vercel's result shows up on GitHub:
  `curl -s https://api.github.com/repos/nomu-git/booking-progress/commits/<sha>/status`
  (there's no `gh` or `vercel` CLI on this Mac).
- **Vercel env var changes need a redeploy.** Setting/changing a var in the
  dashboard does nothing until the next deploy. This was the root cause of
  the original "WETRAVEL_API_KEY is not set" blank-dashboard incident.
- **Meta's insight retention (~37 months) rejects requests past its floor
  rather than returning empty.** Any year-scoped Meta query must clamp
  `since` to the retention floor (see `retentionFloor()` in
  `campaign-history.js`) or the whole request errors instead of partially
  succeeding.
- **CPM is cost per *thousand* impressions** — `spend / impressions * 1000`,
  not `spend / impressions`. Bit the project once as a value 1000x too small.
- **Campaign Budget Optimization (CBO) is off** on these Meta ad accounts, so
  a campaign's own `daily_budget`/`lifetime_budget` fields are empty — the
  real budget lives on its **ad sets**, summed across only the ones with
  `effective_status === 'ACTIVE'`.
- **One Meta ad account bills in USD, not SAR** — always run figures through
  `toReportCurrency`/`budgetToReportCurrency`, never assume raw Meta numbers
  are already in the display currency.

## Testing

**There IS a real Node runtime on this Mac, through VS Code's Electron.**
There's no standalone `node`, but this runs full Node v24 (with `zlib`,
`Buffer`, `fetch`, `require`):

```bash
ELECTRON_RUN_AS_NODE=1 '/Applications/Visual Studio Code.app/Contents/MacOS/Code' -e 'require("./lib/xlsx.js")'
```

Use it to run `api/*.js` modules and their `build()` functions directly.
(Anything that needs the API tokens still can't run locally, since those
env vars only exist in Vercel.) Found 28 Sep 2026; earlier sessions didn't
know about it, which is why the harness below exists.

For code inside `index.html`, the older approach still applies:
**macOS JavaScriptCore via `osascript -l JavaScript`**. The Electron Node
above works for this too: slice the functions out of the page's script and
run them with a stub `$()`.

**To actually see a layout**, render a static snapshot with Quick Look:
write the page's `<style>` plus the generated markup to an .html file, then
`qlmanage -t -s 1400 -o <dir> <file>.html` produces a PNG you can Read. JS
doesn't run in it, so render the markup first. This is how the `.weeks`
collision was caught; no amount of markup checking had found it. Parse-checking
and rendering JS extracted from `index.html` is done with **macOS
JavaScriptCore via `osascript -l JavaScript`**, using a stub harness that
mimics the page's real `$()`, `esc()`, `attr()` exactly (including their
real quirks, like `esc()` not escaping quotes — a stricter stub would hide
the exact class of bug noted above). Pattern used throughout this project's
history:

1. Extract the relevant function(s) from `index.html`'s `<script>` block with
   Python string slicing between known anchor comments/function signatures.
2. Wrap in a harness that stubs `$()`/`esc()`/`attr()`/DOM methods, feeding
   in a real API response (fetched live with `curl` against the deployed
   endpoint, or a hand-built fixture for edge cases like an empty year or a
   retention-purged year).
3. Run via `osascript -l JavaScript -e '...'` or with the code in a temp file
   read via `NSString`, capture the rendered HTML.
4. Assert on the output: no empty tooltips, column counts match between
   `<thead>`, body rows and `<tfoot>` (a silent off-by-one here misaligns
   every value in a table), no orphaned CSS classes (grep every class used
   in markup against every class defined in `<style>`, both directions), no
   dangling references to identifiers removed in the same edit (`grep` every
   deleted function/variable name across the *whole* file, not just the
   section touched).
5. Always verify against a **live** API response before pushing, not just a
   synthetic fixture — several real bugs here only showed up against actual
   Meta/WeTravel data shapes (typo'd campaign names, week-count edge cases,
   duplicate project codes).

After pushing, **poll the live deployment** (`curl` in a retry loop, Vercel
deploys aren't instant) and diff its hash against the local file before
declaring something done.

## Security notes

- **The GitHub repo is public** and **the live site has no authentication.**
  Both were flagged to Anton; he explicitly chose to proceed anyway (budget
  spreadsheets are tracked in git on purpose, per his instruction to remove
  the `.gitignore` rule that had excluded `*.xlsx`).
- **Two GitHub PATs and a Slack webhook URL were pasted into chat and are
  exposed in the conversation transcript.** Anton was told to rotate them
  and explicitly said to ignore that. They remain live/unrotated as of the
  last check — worth a periodic reminder, not a blocking concern.
- Git identity for commits from this project: `nomu-git` /
  `info@nomuhub.com` (a work account set up alongside Anton's personal
  `advjr` account, specifically for this repo).

## Leads (in progress)

The full roadmap for lead counts, qualified leads and Instagram engagement
stats lives in **`docs/LEADS-PLAN.md`**. Read it before touching anything
leads-related. Short version: Phase 1 (now) reads Marina's hand-maintained
Excel workbook live from its OneDrive share link and draws it as a new
Leads tab; Phase 2 (later) replaces the hand count with ManyChat or Meta
webhooks.

- `lib/xlsx.js` is a zero-dependency .xlsx reader (zip + XML, cached formula
  values, date-formatted cells returned as ISO dates). Verified against
  `Updated Budget.xlsx` value for value.
- `lib/sheet.js` (`fetchWorkbook(envVar)`) fetches a workbook from the
  share link held in the named env var (`LEADS_SHEET_URL`,
  `ENGAGEMENT_SHEET_URL`, `TRIPS_SHEET_URL`, `FEEDBACK_SHEET_URL`), a OneDrive/SharePoint link shared as **"Anyone
  with the link can view"**. Links never go in the code: the repo is public.
  Any other sharing setting answers 200 with a Microsoft sign-in page
  rather than an error; the zip-signature check turns that into a clear
  message. **SharePoint grants anonymous access through a guest cookie set
  on the first redirect**, and the next hop 403s without it; `fetch`
  doesn't carry cookies across redirects, so they're followed by hand.
- `lib/tabs/leads.js` builds the **Leads tab** (Ad Campaign group). The workbook
  ("Leads Feedback & Report_Nomuhub _2026", in the nomuhub1 SharePoint site
  under `02. Marketing/01 B2C/1. Volunteer Database`) has three kinds of
  tab, detected by their headers, not their names:
  - per-lead logs (`Q1 leads`, `Q2 leads`, `July`): one row per lead with
    Date, Source (IG/WA), Trip. **Stops at 21 Jul.** Column positions differ
    between tabs, so columns are found by header name.
  - weekly reports (`Q1/Q2/Q3 Report`): free-text week labels ("8/13 July",
    "28-3 Aug") parsed into dates, then IG / WA / IG+WA rows by project.
    **These are the weekly numbers shown**: they're Marina's official
    figures, and the only source for 22 Jul to 21 Sep.
  - a daily summary (`Leads Quality`): date rows from 23 Sep, IG+WA
    combined (no channel split). The reader also accepts **IG and WA rows
    under each date** (labelled like the weekly report, `Total No|IG` /
    `Total No|WA`, or just `IG` / `WA`), with or without the combined row
    alongside; the day then carries its split, per project too. Or, the
    lightest option for Marina: **two columns headed `IG` and `WA` past the
    Total column** (header on the Total row or the row above), giving the
    day's split but not per project. A week keeps a split only if every
    logged day in it has one; a project keeps one only if every day it had
    leads on split that project. A day whose project cells don't add up to
    its Total (28 Sep: 7 vs 6) is flagged, not corrected.
  Days come from the log (keeps the IG/WA split) or the daily summary. A
  week with no report row yet (the current one) is summed from its days,
  so it moves as Marina logs. Days no report covers are grouped into 7-day
  weeks of their own. Env: `LEADS_SHEET_URL` (required), `LEADS_CACHE_TTL_MS`
  (default 60s).
- **Tapping a day** in the daily chart shows that day's breakdown in the
  table, which sits directly under the daily chart (Muatasam: "When I press
  daily should show daily leads breakdown in table below"); tapping it
  again, or "Whole week", goes back. Each `days[]` entry in `/api/sheets?name=leads`
  carries its own `projects`. Shares are of the rows shown, so they always
  total 100% even when the sheet's own Total disagrees.
- The **Leads by project** table puts the count straight after the name,
  and shows WhatsApp/Instagram columns only when that week really has the
  split. Two columns of dashes read as "no breakdown at all" to Muatasam on
  his phone, with the numbers scrolled out of sight. On a phone the weekly
  chart scrolls to the selected week, since it opened on January.
- **The sheet has known inconsistencies, shown as warnings, not silently
  corrected**: 14/20 July (IG 18 + WA 104 ≠ IG+WA 92; the WA 31 on ZNZ|EX
  looks like a typo for 1), 21-27 July (31 + 124 ≠ 166), 18-24 Aug and
  24-31 Aug overlap on the 24th, and ~12 weeks where the per-lead log and
  the weekly report differ by a few leads. When IG + WA don't add up, the
  bar is drawn as one combined block rather than a split that isn't true.
- Chart colours (`--lead-wa` aqua, `--lead-ig` orange, `--lead-all` blue for
  "not split") were validated with the dataviz skill's
  `validate_palette.js` against `--track` (all pairs pass). Status green/red
  stay reserved.
- **The leads sheet may contain customer names or phone numbers. The site
  is public with no auth, so only aggregate counts may ever leave the API.
  Never add a raw-dump or debug endpoint that returns sheet rows.**

## Engagements tab

`lib/tabs/engagements.js`, same idea as Leads: mirrors **Maryam's** social media
workbook ("Marketing Data: Social Media Nomuhub", nomuhub1 SharePoint) live
from `ENGAGEMENT_SHEET_URL`. Two tabs, detected by headers: **Posts** (Content
Name, languages, Content Type, Post Date, Views, Likes, Comments, Shares,
Book marks, Engagement, CTA Present?, Cta Word) and **Story** (Content Name,
Language, Poll Type, Post Date, Views, Responses, Comments = poll result,
Story Engagement Question).

- Maryam's Engagement is exactly (likes + comments + shares + saves) / views
  on every post (checked 30 Sep); shown as she wrote it. The overall figure
  is total interactions over total views.
- Post Date is typed both as text ("3rd July", no year) and as real dates;
  the year comes from the real ones. A blank Book marks cell is "not
  recorded", shown as a dash, not 0.
- Story Responses can be text ("8 Link Clicks"): the number is kept and the
  unit shown under it. Response rate (responses / views) is computed here.
- **Filters: Month and Type** (Reel, Carousel, Static, Photo dump, plus any
  new type Maryam adds, in that order). They combine; the hero, chart and
  posts table all follow them, stories follow the month only (they have a
  poll type, not a content type). Each type shows its count for the chosen
  month; a type with none is hidden unless it's the one selected. Type is
  its own column on wide screens and moves under the post name on a phone.
- UI: month pills, hero (posts, views, engagement, best post), a
  views-per-post bar chart (single series, `--fill`), a posts table with an
  engagement bar per row, and a stories table. Chart width scales with the
  number of posts, not the Leads chart's fixed 620px.
- The long-term route is Instagram's own API (`instagram_basic` /
  `instagram_manage_insights`), blocked on connecting Instagram to Business
  Manager; about half the columns could come from it, the editorial ones
  (name, language, CTA) never will. See `docs/LEADS-PLAN.md`.

## Trips tab

`lib/tabs/trips.js` mirrors the **"NomuHub Trip Decision Dashboard"** workbook
("which products to grow, optimise, or stop") from `TRIPS_SHEET_URL`.

- The master tab is found by a header row with TRIP NAME and QUALITY (it
  sits under a title block, row 4 today); columns are matched by the name
  before each header's explanation ("REGION\r\n(ASIA or AFRICA...)" ->
  "region"). One row per trip product: category, region, destination,
  PIC, weeks, days, year, existing/new price, price change, quality,
  product status, R&D status and next step, requires update, detailed
  analysis, corrective actions, notes, profit/loss (empty today).
- **Counts are recomputed from the master rows, not scraped from the
  Executive Summary tab** (whose layout moves). They matched it exactly on
  30 Sep: 23 products, 53 departure weeks, High 4/22 wk, Medium 8/25, Low
  5/4, R&D 6/2, and every region row. The one thing read from the summary
  is its wording: the quality guide's "What it means" / "What we do with
  the calendar", and the per-trip "Calendar decision" from its products
  table, with the sheet's own text as fallback.
- **Two sub-tabs** (`tripsSub`), so the page isn't one long scroll:
  **Overview** (tiles, weeks bar, quality guide, quality by region, R&D
  pipeline) and **All products** (filters + the product list). Filters and
  opened Details are kept across switches.
- UI in the summary's reading order: tiles + a weeks-by-quality bar +
  the quality guide; quality by region (with a weeks mini-bar); R&D
  pipeline; all products with Region / Quality / Status filters (each
  button counts what it would show given the other two) and a Details
  toggle under each trip name opening analysis, corrective actions, notes
  and R&D next step. On a phone the opened text is sticky-pinned to the
  visible part of the scroll box.
- **R&D pipeline is a board**, not a table: columns Not started → In
  progress → Complete, with On hold set apart (dashed). Each trip is a card
  with a 3-step stepper, owner initial, target-year badge (the current year
  in yellow) and its next step, above a labelled stage strip and a
  "launching 2026 / 2027" count. Stages use the brand accent only, never
  the quality colours, which already mean High/Medium/Low on this tab.
  "Not sure (unknown)" as a PIC shows as "No owner yet". A status the board
  doesn't know gets its own row rather than disappearing.
- Quality colours `--q-high/med/low` are the dataviz skill's fixed status
  steps; the dashboard's own green/amber/red failed the normal-vision
  floor (amber vs red 14.6). R&D is neutral blue. Every use has a glyph
  (▲ ■ ▼ ◆) and the label.
- **This tab puts pricing, internal analysis and corrective actions on a
  public URL with no login.** Flagged to Anton when it was built.

## Feedback tab

`lib/tabs/feedback.js` mirrors the **"NomuHub — 2026 Feedback"** workbook (trip
survey results) from `FEEDBACK_SHEET_URL`. Two of its tabs are read, found
by their content, not their names:

- **Summary**: the YEAR-TO-DATE SATISFACTION / TRIPS REPORTED / RESPONSES
  COUNTED labels with values on the row below, then one row per surveyed
  trip under month headings ("Aug 2026").
- **By Programme**: one block per survey template (Building / Medical,
  Teaching, Wellness, Explorer). Each block is the programme name on the
  line above a `Trip | Month | ...` table of per-question 1–5 scores, then
  "<programme> — what people wrote" (its first line is the sheet's own
  summary of the asks, then "Trip, Mon YYYY (N comments ...)" headings and
  `Kind — Source[ — ESCALATE]` / text rows), then an `Item | Type | Score`
  itinerary table of named hotels and excursions. Text cells in the score
  table ("2/2 positive", "Penglipuran 3.00") are kept as facts; "Not asked"
  goes in the trip's `notAsked` list and "—" is dropped. Each programme
  carries its `questions` in the sheet's column order. Trips join across
  tabs on name + month.
- **Pitfall, hit once:** the fixed leading columns (Trip, Month,
  Responses..., Overall..., Satisfaction %) are matched **whole** (`FIXED`
  in `lib/tabs/feedback.js`). A prefix match on "trip" silently dropped the
  "Trip Manual / On-boarding Pack" and "Trip Testimonials" questions from
  every survey until the Ratings view listed them. The build was
  cross-checked afterwards: all 105 numeric question cells in the sheet
  reach the payload.
- **Coverage Gaps** (trips with no survey) is **not read**. It had its own
  "No survey" sub-tab and an Overview tile at first; Anton had both removed
  (30 Sep 2026).

Verified against the live sheet on 30 Sep 2026: 94.5% satisfaction, 10 of
11 trips reported, 29 of 29 responses, 11 trips, 49 comments (1 escalated).

- **Escalated comments are shown in full, by Anton's explicit decision (30
  Sep 2026).** The one there today (KUMSA, Aug 2026) describes harassment of
  female participants near the hotel, a staff member's clinical
  qualifications and inflated costs, and the sheet says to escalate it
  "outside this dashboard". It was first built held back at the API; Anton
  was told the site is public, unauthenticated and indexable, was offered
  hidden / collapsed options, and chose to show it verbatim. Don't re-hide
  it without being asked. It's flagged ⚑ Escalate with a red edge, and the
  Overview's red callout has a "Read it" button that opens What people
  wrote. The sheet's "Notes" bullets are still not sent (nothing uses them).
- UI, three sub-tabs (`fbSub`: `'overview' | 'ratings' | 'comments'`):
  - **Overview**: tiles (Satisfaction with a bar, Trips reported,
    Responses), a red escalation callout, a By trip table grouped by month
    (Trip | Overall 1–5 | Responses | Response rate | Comments with a red
    ⚑ count), Details under each name opening every question score, the
    hotel/activity scores and the text facts, and a Lowest scores list
    (everything under 4.0, lowest first; matches the sheet's own "weakest
    items" note).
  - **Ratings** (Anton asked to see every question per trip): one table
    per survey (Building / Medical, Teaching, Wellness, Explorer), a row per
    question and a column per trip, Overall satisfaction first. Scores get
    a band-coloured bar and the number; text answers show as the sheet has
    them; "Not asked" / "—" per cell. A question none of the survey's trips
    was asked is left out. The question column is sticky so trips scroll
    under it on a phone. A trip with no answers (Bali Building MKS B2B) is
    named under its table instead of getting an empty column.
  - **What people wrote**: Programme and Type filters (each button counts
    given the other), comments grouped programme > trip, verbatim.
- Score bars use the sheet's own bands (4.0+ / 3.0–3.9 / under 3.0) in the
  Trips tab's status colours `--q-high/med/low`, number beside every bar.
  Response rate is neutral slate (`--text-3`), not the brand amber, because
  amber on this tab means a 3.0–3.9 score. Overall sits straight after the
  trip name so it's on screen on a phone.
- Classes are prefixed `fb-`; `.flag` already exists elsewhere, hence
  `fb-flag`.
- **This tab puts verbatim customer comments, including the escalated
  KUMSA complaint, and staff names (Salim, Surti, Maria, Roy) on a public
  URL with no login.** No traveller names are in the sheet. Flagged to
  Anton when it was built; he chose to proceed.

## Trip Revenue tab

`lib/tabs/revenue.js` mirrors the **"NomuHub Trips 2026"** revenue workbook
from `REVENUE_SHEET_URL` (Operations group, `data-view="revenue"`).

- **PERCENTAGES ONLY, NO AMOUNTS, NO PEOPLE (Muatasam, 4 Oct 2026):** "Pls
  hide this page for now immediately. Just show percentage not values at
  all. Remove the ones against ppl too. Like salim and roy." Enforced in the
  **API**, not the page, because the site is public: the payload carries no
  revenue / expense / profit figure, no currency and no project manager,
  only `margin`, `figures` (has any numbers), `result` (Gain / Loss /
  Break-even / Not entered) and trip counts. **Never add an amount or a
  manager back to the payload** without Muatasam saying so; grep the live
  `/api/sheets?name=revenue` output for `revenue"`, `profit"`, `manager`
  and staff names before shipping any change here.
- The **Trips** sheet is the source: found by a header row with Trip,
  Revenue and Expenses; columns matched by name. The TOTAL row is skipped;
  totals and the month / programme breakdowns are recomputed from the rows
  (amounts are summed internally to get each group's margin, then dropped).
  Verified against the sheet's own Dashboard on 30 Sep 2026 (32.4% margin
  overall, all month / programme rows match).
- UI, two sub-tabs (`rvSub`: `'overview' | 'trips'`), layout kept as built
  at Anton's request: Revenue / Expenses / Net profit tiles and columns read
  **"Hidden"**; Margin is the headline; Trips count with "N not entered
  yet"; a year bar split "Expenses 67.6% / Profit 32.4% of revenue"; an
  amber callout listing trips that have ended with no figures; By month and
  By programme tables (programme sorted by margin). **All trips**:
  Programme / Result filters, rows grouped by month, no footer total (a
  filtered total would need amounts). The By project manager table, the
  Manager column and filter were removed.
- Each bar is **that row's own revenue as 100%**, split by its margin:
  expenses (1 − m) in `--q-none` slate plus profit (m) in `--q-high` green;
  on a loss the bar is the expenses, with revenue 1/(1 − m) in slate and the
  overrun in `--q-low` red. Bars deliberately don't share a scale, so they
  show no amount and no row's size against another's. Result shows a glyph
  + label (▲ Gain, ▼ Loss, ■ Break-even, ○ Not entered). True minus (−).
  Classes prefixed `rv-`.
- Sheet quirks, shown as the sheet has them, not corrected: ~10 trips that
  didn't run (or whose figures are missing) read "Break-even" with no
  figures; "Bali| Building, B2B Trip MKS" has Destination ZNZ; two rows
  are both numbered 6.

## Campaign on/off alerts (Slack)

Asked for by Anton/Muatasam, 4 Oct 2026: a Slack message whenever a
campaign is switched on or off, worded exactly as agreed:
"Campaign: <name> has been switched off at 8:20 AM on Sun 4 Oct (Muscat),
by Maryem Sayed. Please review the changes: <dashboard>/#campaigns".

- **Meta can't push this.** Its ad-account webhook fields are
  ads_async_creation_request, creative_fatigue, ad_recommendations,
  in_process_ad_objects, product_set_issue and with_issues_ad_objects; none
  is a campaign's on/off status (checked against Meta's docs; some blogs
  claim otherwise). Anton wanted it "not scheduled"; told him real push
  isn't possible and he approved polling.
- **What runs:** **cron-job.org** calls `GET /api/campaign-alerts` every 2
  minutes with `Authorization: Bearer $CAMPAIGN_ALERT_SECRET`. It reads each
  ad account's activity log (`/act_…/activities`, the Ads Manager History
  page) for the last 60 minutes (`CAMPAIGN_ALERT_LOOKBACK_MIN`) and posts
  one Slack message per new event to the same `SLACK_WEBHOOK_URL` as the
  daily bookings message (living-room). Alerts land about 1–3 minutes after
  the change. The time shown is the event's own `event_time`, in **Muscat**
  time; Ads Manager shows the ad account's time zone, an hour earlier.
- **History of the trigger:** first built on a GitHub Actions workflow
  (`*/5` schedule, "seen" list in the Actions cache). On 4 Oct 2026 GitHub
  had not started a single scheduled run 5 hours after it was added (only
  the manual run), so it was replaced with cron-job.org + Upstash and the
  workflow deleted.
- **Which rows count:** `event_type === 'update_campaign_run_status'` (or
  translated "Campaign status updated"), with `extra_data` old/new values:
  on = became "Active", off = stopped being "Active" (paused or deleted
  while running). Campaigns only, never ad sets or ads (Meta moves ads
  through review states constantly). Includes who did it (`actor_name`).
- **New campaigns alert too** (added 4 Oct 2026 at Anton's request):
  "Campaign: X has been created at <time> (Muscat), by <who>, and is
  currently on". Meta logs a creation as raw `create_campaign_group`
  (translated "Campaign created", confirmed live) with no status in it, and
  a campaign created live never gets a status-change row, so the on/off
  alert alone missed it. The current status is fetched (`effective_status`
  on the campaign) only for creations about to be posted; if that lookup
  fails the message goes out without the status. Renames
  (`update_campaign_name`) don't alert. Key suffix `:created`.
- **"Already posted" lives in Upstash Redis** (`lib/kv.js`, REST over
  `fetch`, no package; env `KV_REST_API_URL` / `KV_REST_API_TOKEN` from
  Vercel's Upstash integration, or the `UPSTASH_REDIS_REST_*` pair). Each
  event in the window is **claimed** with `SET campaign-alerts:<key> 1 NX EX
  172800` in one pipeline; only claims that return `OK` are posted, so two
  overlapping calls can't double-post (tested). A failed Slack post `DEL`s
  its claim so the next call retries. Until `campaign-alerts:ready` exists
  (first call, or a wiped store), a call claims everything in the window
  and posts nothing (`bootstrap: true`), so old events are never replayed.
  Keys are `account:objectId:eventTimeMs:on|off|created`. Store missing =
  HTTP 500, nothing posted.
- **Auth:** running a check needs `Authorization: Bearer
  $CAMPAIGN_ALERT_SECRET` (Vercel env var; the same value is set as a header
  on the cron-job.org job). A GitHub repo secret of the same name was also
  set for the old workflow and is now unused. `?preview=1` (plus
  `&hours=N`, up to 240) only reads, and also lists the raw Meta event names
  it saw (`eventTypes`); it's open while the secret is unset and needs the
  secret once it's set (it is, in Vercel, since 4 Oct 2026).
- Verified live 4 Oct 2026: the production Meta token can read
  `/activities` on both accounts, and a 48-hour preview returned Maryem's
  four 8:19–8:20 AM switches-off with the right names.

- Meta load: every 2 minutes x 2 accounts = ~60 activity-log calls an hour
  per account, well inside the Marketing API limits; don't go to every
  minute without a reason.

**Function budget: 10 of Vercel Hobby's 12** (sheets merged into one;
`campaign-alerts` added). New sheet tabs don't add to it.

## Open items waiting on Muatasam

- Missing destinations/programmes for the project-code scheme (listed
  above) — 87 of 232 historical trips still show their raw WeTravel title.
- Whether the `$500` flat assumed budget on History is acceptable given it
  makes most historical campaigns read as 100–400%+ over budget (flagged,
  not yet confirmed either way).
- What to do about a trip whose title names two programmes at once (e.g.
  "Salalah | Wellness & Explore") — currently resolves to whichever
  programme is listed first in `PROGRAMMES` (`WL` before `EX`), confirmed
  correct for that specific case but not stated as a general rule.

## Session workflow notes

- User does most work through this Claude session's Bash tool directly
  (heredocs, `python3` string-surgery on `index.html`, `git`) rather than
  the Edit/Write tools, since `index.html` is large and edits are often
  precise multi-point replacements best done with `assert old in s` guards
  against drift.
- Commit messages here are written in full prose explaining *why*, not just
  *what* — matches the codebase's own comment style (every non-obvious
  design decision in the code has a comment explaining the reasoning, not
  just the mechanism). Keep that up; it's what makes the "known pitfalls"
  section above possible to write accurately.
- After significant changes, Anton typically asks for a short Slack-ready
  update message to Muatasam — see "Muatasam's standing preferences" above
  for tone (short, direct, no em dashes, explain briefly why when something
  might look surprising).
- **Anton also edits and commits directly outside a Claude session**
  (his own VS Code, not this harness) — e.g. commit `9916706` ("up", 30 Sep
  2026) reverted the R&D pipeline's big full-size sub-tab straight back to
  the two-sub-tab version, in both `index.html` and this file, between one
  Claude session ending and the next starting. **Don't assume the repo only
  changes through a Claude session's own commits** — if something built in
  an earlier session looks reduced or missing, check `git log`/`git show`
  for a commit that isn't attributed to that session's work before treating
  it as a bug or re-adding it. This file is kept in sync with whatever
  `index.html` actually does, even when the change that got it there wasn't
  Claude's.
