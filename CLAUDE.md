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
  `<script>`, no bundler. ~350,000 characters. Thirteen views.
  **Sidebar restructured 19 Oct 2026** (Muatasam: "so much information
  scattered in the website but not as focused. Please restructure on a way
  that can be executive and clear focused"; Shakir's advice: overview first,
  details in tabs): the sidebar (`<nav id="viewSeg">`) has **five entries,
  `data-section` buttons: Dashboard, Sales, Marketing, Operations,
  Corporate** (+ Settings). Each section's pages are **underlined tabs
  across the top** (`#secTabs`, `.sec-tabs`), built by `setView()` from the
  `SECTIONS` array in `index.html`: Sales = Booking / Previous Sales / Report
  / Leads; Marketing = Campaign Ads / Campaign History / Engagements;
  Operations = Trips & R&D / Feedback / Trip Revenue / Impact; Corporate = KPIs /
  Monday Tasks. A section reopens on the page it last showed (`secLast`).
  The old `#bookSub` / `#adsSub` bars are gone (the section tabs replace
  them); pages with their own pill sub-tabs inside (Trips, Feedback,
  Revenue, Engagements) keep them. **The header title is the section name**
  (`#pageTitle`); the booking date range shows only on Booking
  (`#rangeWrap`), and the New in 24h / Last Week / Weekly Target figures only
  on Booking, Previous Sales and Report (`#headStats`). Every `data-view`
  value and `#hash` is unchanged. The grouping before that (4 Oct 2026),
  kept for history:
  - **OVERVIEW**: Dashboard (`data-view="overview"`, 19 Oct 2026), the
    executive overview and **the first screen** for a device with nothing
    saved. See "Dashboard tab (executive overview)" below. Not to be confused
    with the Booking tab, which was labelled "Dashboard" until 30 Sep 2026.
  - **SALES**: Booking, Report, Leads. **Previous Sales is a sub-tab of
    Booking** (Muatasam, 5 Oct 2026: "add previous projects under sales ...
    Call the tab Previous Sales ... combine ... as new tab under booking"):
    `#bookSub` (Upcoming / Previous Sales, above `#announce`) switches
    `setView('board')` / `setView('previous')`, and the Booking sidebar
    button stays lit for both. Previous Projects is no longer in the
    sidebar; `#previous` still opens it.
  - **OPERATIONS**: Trips & R&D, Feedback, Trip Revenue
  - **MARKETING**: Campaign Ads, Engagements. **History Campaign is a
    sub-tab of Campaign Ads**, not a sidebar item: `#adsSub` (a `.seg.subtabs` bar above
    `#campaignsWrap`/`#historyWrap`, shown for either view) switches between
    `setView('campaigns')` and `setView('history')`; the Ads sidebar button
    stays lit for both. Both views keep their own hash (`#campaigns`,
    `#history`), so old links still work.
  - **CORPORATE**: KPIs (`data-view="kpis"`, 12 Oct 2026, see "KPIs tab"
    below) and Monday (`data-view="pending"`, added 5 Oct 2026 as
    "Pending Task", sidebar label renamed to "Monday" the same day; the page
    title inside is still "Pending Tasks"; see "Pending Task tab" below).

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
  (`leads`, `engagements`, `trips`, `feedback`, `revenue`, and `pending`,
  which reads monday.com rather than a workbook). Each tab's builder lives in
  `lib/tabs/<name>.js` and exports `{ build, envVar, ttl }`, or `{ build,
  load, ttl }` when its data isn't a workbook;
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
| `api/trips-progress.js` | Booking tab (sidebar label; was "Dashboard") — live/upcoming departures, per-week booking bars. Keeps a departure for its whole month, drops it once the month passes. **No cut-off date**: every departure WeTravel has open shows, however far out (`SEASON_END` defaulted to 2026-12-31 until 5 Oct 2026, which hid five January 2027 trips WeTravel already had on sale; Anton: "show all trips that is available currently in wetravel"). If `SEASON_END` is set it still applies. The header's "<today> to <month>" is the last departure on the board. **`?audit=1`** (needs `Authorization: Bearer $CAMPAIGN_ALERT_SECRET`) lists every upcoming WeTravel trip with why it is or isn't shown: excluded, past the season end, no booking record, or no weeks set up. Use it first when asked "why isn't trip X showing". **Unavailable = Cancelled (Anton, 13 Oct 2026)**: a week WeTravel has at 0 seats (its "Unavailable") is sent as `unavailable` and drawn as a red, struck-through CANCELLED week, bookings or not; a trip whose weeks are all unavailable (or in `CANCELLED_TRIP_UUIDS`) is a red CANCELLED card (Thai | Wellness and SA | Explore, Nov 2026). **SOLD OUT** only when every week still on sale has seats (> 0) and all are taken; before this, a 0-seat week with bookings read as Sold out. Hidden **on purpose**, don't "fix": the charters and **Korea Explore 24–31 Oct 2026** (hidden by an earlier decision, see `EXCLUDED_TRIP_UUIDS` in the README). |
| `api/previous-trips.js` | Previous Sales (Booking sub-tab; was the Previous Projects tab) — the complement of trips-progress: everything whose month has already passed. `end < monthStart` is the exact filter, so a trip is never in both views or neither. Also returns **`sales`**: bookings taken per month (`{ 'YYYY-MM': { n, byDay[31], cats } }`, `cats` = per project `"TH|WL"` / `"ZNZ"` / `"Other"` for the Dashboard's category filter, Muscat day of `created_at`, each order's `active_count`, charters left out, `charterExcluded` count) across **every** trip, upcoming ones included (their orders are fetched for this only). Counted exactly like the Report's "bookings taken"; checked 5 Oct 2026, all 11 months in the Report's window match. Data starts 2019-04; 2020 is all zero. |
| `api/booking-report.js` | Report tab — flat list of booking events, last 300 days by default. Exports `build()`, reused by `slack-notify.js`. |
| `api/slack-notify.js` | Cron target — posts the day's new bookings to Slack. `?preview=1` renders without posting. Gated by `CRON_SECRET` if set. |
| `api/announcement.js` | Banner text from env vars, editable without a code change, **plus dated reminders** in its `REMINDERS` array (Anton, 6 Oct 2026: decide on Thailand Wellness by Mon 12 Oct, South Africa Explore by Mon 19 Oct). The API sends `items` (env banner first, then reminders by due date) and drops a reminder after its due day (Muscat), so it disappears on its own. The Booking tab shows each as its own card in `#announce` (now an `.announce-list` grid): amber edge, a countdown pill ("6 days left · Mon 12 Oct", red from 2 days out). To add or remove one, edit `REMINDERS`. **Emptied on 13 Oct 2026** (Anton: "remove the announcements"); with nothing to show, the banner area is hidden entirely (no "No current announcement" placeholder). |
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
| `api/campaigns.js` | **Campaign Ads tab** (sidebar label; was "Campaigns", then "Ads"). Current year only (env `META_YEAR`, defaults to current calendar year — so this auto-rolls into 2027 with no code change). Every campaign gets its own budget (see "Budget matching" below), live spend/results/purchases from Meta. **Table (Anton, 15 Oct 2026):** a **Show: Running · N / All · N** filter, Running by default (`campShow`), with the TOTAL row summing the rows shown (the year hero keeps every campaign); and a **Daily Spend** column after Status = the campaign's daily budget in Meta (`dailyBudget`, summed over its active ad sets since CBO is off), running campaigns only, dash otherwise. It's what's set per day, not what was actually spent today (flagged to Anton). |
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

## Previous Sales charts

Above the previous-projects list (`psHtml()` in `index.html`, Report chart
classes reused, `ps-` prefix for the rest):

- **Same month, year on year** (Muatasam: "Mainly Im looking for same month
  comparison against previous years ... Sep progress this year vs sep last
  year vs years before of same month"): month pills (default the current
  month, `psMonth`), one bar per year from the first year of data to now.
  The current month's bar is hatched "so far"; years before the data starts
  or months not reached yet show "—". The line under it: for the current
  month, "so far" vs **last year by the same day of the month** (`byDay`)
  and last year's full month; for other months, the latest one vs the year
  before and the average of earlier years. Up ▲ green / down ▼ red.
- **Bookings taken by month**: Last 12 / 24 / 36 (`psRange`), like the
  Report's monthly chart; scrolls sideways when wider than 12 bars.

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
- **Chart axis labels must not set the column width.** The Report's
  `.caxis` labels had no `min-width: 0`, so on a phone "Nov 2025" was wider
  than its bar and every label slid right; in a screenshot Muatasam sent,
  July's 34 sat under "May 2026". Fixed 5 Oct 2026: labels keep their bar's
  width and centre on it (flex column), spilling evenly if too wide. Never
  use `overflow-wrap: anywhere` there (it broke "Nov" into "No v").
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

**Best option now (19 Oct 2026): a real WebKit browser from the command
line**, `tools/webkit-shot.js` (JXA: an offscreen `WKWebView`, runs the
page's real JS, `evaluateJavaScript`, then a PNG snapshot):

```bash
osascript -l JavaScript tools/webkit-shot.js <page.html> <stub.js> <out.png> <width> <height> <light|dark> <view> '<optional JS to run first>'
```

`stub.js` is a user script injected before the page: it replaces `fetch`
with live API responses saved to disk (`curl` them with the Bearer secret)
and sets the saved view; build it as `window.fetch = async (u) => ({ ok,
status, json })` over a `{ '/api/...': payload }` map. It prints the page
height, visible chip bars, "Show all" buttons and any script errors (add a
`window.onerror` collector to the copy of the page). Width 390 gives a true
phone layout (media queries apply, unlike Quick Look). Use this before Quick
Look for anything interactive.

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
  carries its own `projects`. (The share column that used to sit there was removed.)
- **Daily targets on the daily chart** (Anton, 6 Oct 2026: "a target line
  per day, 20 for overall leads and 10 for high potential leads, a colour
  line for each"): `LEADS_DAILY_TARGET = 20` and `HP_DAILY_TARGET = 5` at
  the top of `dailyChart()` in `index.html`. A dashed line each, light blue
  (`--tgt-leads`) for leads and brand yellow (`--tgt-hp`) for HP, each ending
  in a glowing round cap with its label ("20 LEADS" / "5 HP") as a small
  pill in a **gutter to the right of the bars** (`.lplot.tg` / `.laxis.tg`,
  84px), so a tall bar never runs under a label. Don't put a CSS `mask` or
  `filter` on the dashed layer: in Quick Look it turned the dashes white,
  and a mask also clips the label and cap if they share the element. The
  scale always reaches the leads target. Each day also gets a thin yellow **HP bar** beside its
  lead bar (same scale, with its count) so the HP line has something to
  measure; days or weeks with no HP recorded draw neither the HP bars nor
  the HP line. A legend sits under the chart, and each day's tooltip says
  whether the target was reached ("✓ reached" / "N short") and "HP n of
  10". Only the daily chart has targets; the weekly chart doesn't. If the
  targets change, edit those two constants.
- **Week picker is a dropdown, weeks are Sunday to Saturday** (Anton, 6 Oct
  2026): the Prev / This week / Next buttons were replaced by a **Week**
  dropdown (`#leadsWeekSel`, newest first, "Sun 4 Oct – Sat 10 Oct · this
  week"); tapping a bar in the weekly chart still selects that week. In
  `lib/tabs/leads.js`, days with no report week are grouped **Sunday to
  Saturday** (the Report's week, so Bookings / Conversion line up), and a
  report row Marina hasn't filled in yet (a placeholder like "22-30 Sep") is
  **not a week**: its days are cut from the daily entries until her figures
  arrive. **Weeks that come from her weekly reports are kept exactly as she
  reported them** (Mon–Sun in the spring, Tue–Mon from July, some 9 days
  long; labelled "weekly report" in the dropdown): they're her official
  totals, and ~12 of them differ slightly from the per-lead log, so re-cutting
  their days Sunday to Saturday would change the numbers. Sunday to Saturday
  therefore holds from 22 Sep on (and for 1–11 Jan, before the first report
  week: Thu 1–Sat 3, Sun 4–Sat 10, Sun 11). 22 Jul to 21 Sep has no daily
  entries at all, so it can't be re-cut. Totals checked unchanged (2,306
  leads, 1,289 in daily entries) before and after the change.
- **High potential (HP)** (Anton, 6 Oct 2026: Marina added an HP column):
  counted from two places in `lib/tabs/leads.js`: **"HP" in the Status
  column of the per-lead logs** (Q1 / Q2 / July, to 21 Jul) and, from 23 Sep,
  the **free-text HP column** of the daily sheet ("Leads Quality", header
  "HP" past Total, on row 0), written beside a day's IG or WA row, like
  "2 med|1 vn", "1 SL+1 BL", "3 znz BL", "1 kenya". `readHp()` splits on
  `| + , ; &` / "and", reads "<number> <project>", and `hpProject()` matches
  the project to that sheet's codes (direct code first, then
  destination / programme words; a match must be unique) or counts it as
  "Other". Days / weeks get `hp` (null when nothing records HP: the weekly-
  report-only weeks, late Jul to mid Sep), `hpOther` (HP naming no project,
  or a project with no leads in that period: shown only in the TOTAL, with a
  note) and per-project `hp`. UI: a "High potential" tile (N, % of leads)
  and an **HP** column after Leads (yellow pill), hidden with a note when
  the period has no HP recorded. Checked 6 Oct 2026: 52 HP this year; 22–30
  Sep 10, 1–7 Oct 7. Only counts leave the API, as ever.
- **HP by channel** (Anton, 8 Oct 2026: "separate each high potential per
  channel like WA or IG ... rather than showing overall HP"): Marina writes a
  day's HP in the HP column of that day's **IG row or WA row**, so
  `readHp(..., channel)` in `lib/tabs/leads.js` credits it to that channel
  (per-lead logs use the lead's Source). Days, weeks and projects carry
  `hpIg` / `hpWa` beside `hp`; they're **null when any HP in the period has
  no channel** (HP written on the combined row only), and the page then falls
  back to the single HP column. Table: **HP · WhatsApp** and **HP · Instagram**
  columns replace the one HP column (TOTAL row too); the HP tile keeps the
  overall number with "WhatsApp 4 · Instagram 1" under it; the daily chart's
  HP bar stays one yellow bar (it measures the overall 5 target) and its
  tooltip lists HP WhatsApp / HP Instagram. Live 8 Oct 2026: this week HP 5 =
  WhatsApp 4 + Instagram 1; since 23 Sep nearly all HP is WhatsApp. The
  Campaign Ads lead-quality panel still uses overall HP per project.
- The daily sheet now also has **IG and WA rows under each date** (from 23
  Sep), which the reader already handled, so days and weeks since then are
  split WhatsApp / Instagram. Its headers changed spelling ("ZNZ|MD",
  "ZNZ |EX", "Kenya", "Sri Lanka", "TH/WL") and **VN|EX appears twice**
  (both columns are added together); `ALIASES` folds them onto the codes.
- **No Share column** (Anton, 5 Oct 2026, "remove this", with a screenshot of
  the Share of week bars): the Leads by project table is Project | Leads |
  WhatsApp | Instagram (when split) | Bookings | Conversion. The old Share of
  week / Share of day column and its glossary entries are gone.
- The **Leads by project** table puts the count straight after the name,
  and shows WhatsApp/Instagram columns only when that week really has the
  split. Two columns of dashes read as "no breakdown at all" to Muatasam on
  his phone, with the numbers scrolled out of sight. On a phone the weekly
  chart scrolls to the selected week, since it opened on January.
- **Bookings and Conversion columns** (Anton, 5 Oct 2026): the Leads by
  project table shows, for each project, the bookings taken in the **same
  week** (or the day picked) and Conversion = bookings ÷ leads, with a TOTAL
  of all bookings that period ÷ all leads. Bookings come from the Report's
  events (`/api/booking-report`), which now carry `pd`/`pg` (destination /
  programme code, via `trip-code.js` `classify()` plus a leads-only alias
  list in `booking-report.js` for South Africa → SA, Morocco → MO, AlUla →
  ALAULA, which aren't on Muatasam's code list). A lead code "ZNZ|BL"
  matches both; "SL" / "KN" (no programme in Marina's code) match the
  destination alone; "NA" has no rate. Charters left out, as on the Report.
  "Nomuhub payments" (a general payment link) has no project, so it counts
  only in the TOTAL. Bookings for a project with no leads that week only
  show in the TOTAL. **It's same-period, not cohort**: a booking this week
  may come from a lead weeks ago, so a project can read over 100%; the
  column's tooltip says so. The Report only looks back 300 days, so leads
  weeks older than that would show 0 bookings. Checked 5 Oct 2026: 1–7 Oct
  = 4 bookings / 55 leads (7.3%), matching the Report.
- **Overall weekly conversion** (Muatasam, 8 Oct 2026, relayed by Anton: keep
  the per-project conversion, and add one across everything: total bookings
  ÷ total leads, **weekly** (daily makes no sense), **target at least 10%**;
  around 10% means lead quality needs to improve). `CONV_TARGET = 0.10` and
  `weekConv(w)` in `index.html` use `leadBookings(w.start, w.end).all` (the
  Report's events, charters out, same as the table's TOTAL row) over the
  week's leads. Shown as a **Conversion** tile in the Leads hero ("▼ 9.1%",
  "6 bookings ÷ 66 leads · target 10%", green ▲ / red ▼) and a **Weekly
  conversion** panel between the daily chart and Weekly leads: one bar per
  week, green (`--q-high`) at 10%+, red (`--q-low`) under, a dashed 10%
  target line, tooltip with bookings / leads / rate. Uses the same weeks as
  the dropdown, so Marina's report weeks keep their own dates. Spring weeks
  read high (up to 46%) because only 5–15 leads a week were logged then;
  that's the sheet, not a bug. Same-week, not cohort, as the tooltip says.
  Both weekly charts scroll to the selected week on a phone.
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

## Leads: automatic count from ManyChat (in parallel), 21 Oct 2026

Anton: "Lets do first with Marina the leads tab ... make sure the high
potential and leads are accurately fetched." Meta Business verification is
done. Built to run **beside** Marina's sheet, not replace it yet: the Leads
tab has a third chip, **ManyChat check**, comparing the two per day.

- **`lib/manychat.js`**: ManyChat's API can't list new contacts per day, so
  ManyChat **pushes** each event (Automation rules with an External Request)
  to `POST /hooks/manychat` (vercel.json → `api/advisor.js?route=manychat`;
  middleware lets it through), header `X-NomuHub-Key: $MANYCHAT_SECRET`,
  body `{ event: lead | hp | hp_removed | trip, contact, channel, trip }`.
- **Counting rules** (tested locally, all 10 cases): a lead = a new contact,
  **once per person per 30 days** (`MANYCHAT_DEDUP_DAYS`), on the Muscat day
  it arrived; **HP = the HP tag in ManyChat**, applied by whoever is
  chatting, counted on the day it's applied, once per contact;
  `hp_removed` takes it back off that day; a `trip` event (a "Trip: ZNZ|BL"
  tag or field) moves the contact's lead and HP to that project on the days
  they were counted; an HP or trip event for a contact we haven't seen (wrote
  before the rules went live, or over 30 days ago) counts the HP but **not**
  a new lead (changed 21 Oct 2026, before go-live, so the first weeks don't
  read above Marina's); untagged leads are NA, as in the sheet. Trip text is read as a
  code ("ZNZ|BL", "ZNZ-BL") or words ("Zanzibar Building" via `classify()`).
- **Storage (Upstash)**: `mc:c:<hash>` per contact (`{d, ch, p, hp}`; the
  ManyChat id is HMAC-hashed with the secret, nothing personal stored),
  `mc:d:<date>` hash of `lead|wa|ZNZ|BL` / `hp|ig|NA` counters, `mc:first`,
  `mc:last`, `mc:events:<date>`.
- **Read side**: `/api/sheets?name=manychat` (`lib/tabs/manychat.js`, 30 s
  cache) → per-day leads / HP / WA / IG / per project since the first event.
  The panel (`mcCheckPanel()`, classes `mc-`) shows the last 14 days: sheet
  vs automatic vs difference for leads and HP (within 1 = ✓), plus the
  automatic WA / IG split; before any event it says "Not receiving from
  ManyChat yet".
- **Next, once they agree for 1–2 weeks**: switch the Leads tab (and the
  Dashboard / KPIs / alerts that read it) to the automatic count, keeping the
  sheet for anything ManyChat can't see.
- **ManyChat as set up by Cowork (21 Oct 2026)**: plan Pro; WhatsApp
  (+966 53 291 9603) and Instagram (@nomuhub) both connected, so both
  channels count. 17 rules, built as drafts: "New lead, WhatsApp" and "New
  lead, Instagram" both on the trigger **New contact created** (it can't be
  limited by channel), with the condition WhatsApp ID has a value /
  Instagram Username has a value; a contact with both fires both, and the
  30-day dedup counts them once. "HP added" (Tag applied: HP), "HP removed"
  (Tag removed: HP), and one "Trip: XX" rule per trip tag. Each rule has
  its own External Request, so the key sits in 17 headers.
- Setup (Anton + Cowork, 21 Oct 2026): `MANYCHAT_SECRET` in Vercel; ManyChat
  gets an **HP** tag, **Trip: <code>** tags with Marina's codes (ZNZ|BL,
  ZNZ|EX, ZNZ|TA, ZNZ|MED, SA|EX, SL, BA|TA, BA|WL, BA|EX, TH|EX, TH|WL,
  VN|EX, KN), and rules: new contact → lead (per channel), HP applied → hp,
  HP removed → hp_removed, trip tag applied → trip.

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
- **Posts | Stories tabs replaced the Type filter** (Anton, 5 Oct 2026:
  "I only want to show Posts and Stories", with a screenshot of the old
  Type pills): `engSub` switches between a Posts view and a Stories view,
  each with its own heading figures. The only filter left is **Month**
  (shared by both). **Content type is no longer a filter** but stays as the
  Type column in the posts table (and under the name on a phone), and its
  tooltip no longer says to pick one above.
- **Top performing** (Anton: "have also like top performing"): a panel in
  each view with the best three, ranked 1–3 with a bar scaled to the best:
  **posts by engagement rate**, **stories by response rate** (responses ÷
  views). Zero or blank values are excluded; ties go to more views. The sort
  menus also have it as an option ("Top performing (engagement)" / "(response
  rate)").
- **Sort by** (Anton, 5 Oct 2026): a dropdown beside the Month / Type
  filters (`engSort`): Newest / Oldest first, or Views, Engagement, Likes,
  Comments, Shares, Saves each high to low or low to high (stories: Newest /
  Oldest, Top performing = response rate, Views, Responses; `storySort`).
  It orders the **table only** (the views chart stays chronological). A row
  with no value for the field goes last either way (e.g. a blank Book marks
  cell), ties fall back to date.
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
  - **Three groups, not four surveys** (Anton, 5 Oct 2026: "only show and
    filter Volunteering, Wellness, and Explore ... no need to split per
    programme"): `fbGroupName()` maps the sheet's surveys to **Volunteering**
    (Building / Medical + Teaching), **Wellness** and **Explore** (the
    Explorer survey). The comments filter ("Type of trip"), the Ratings
    tables, the trip subtitles and the Details header all use the groups; the
    API still sends the four surveys, so a new survey whose name matches none
    of the patterns shows under its own name. A group's summary line joins
    its surveys' summaries.
  - **Ratings** (Anton asked to see every question per trip): one table
    per group, a row per question and a column per trip, Overall
    satisfaction first. Volunteering merges Building / Medical and Teaching
    questions (union in the sheet's order, so Teaching's extras sit at the
    bottom); a trip whose own survey lacks a question shows "Not asked", and
    a dash means it had the question but nobody answered. Scores get
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
- **Filters (Anton, 19 Oct 2026)**: Year / Month / Programme / Trip
  dropdowns under the sub-tabs (`fbF`, `.fb-filters`), shared by Overview,
  Ratings and What people wrote; each lists only what exists given the
  others, with counts, plus Clear. The comments view's "Type of trip" pills
  went (Programme does that); its Type pills stay. Filtered, the Overview
  tiles are **recomputed from the trips shown**: satisfaction weighted by
  responses, which reproduces the sheet's own 93.9% exactly when nothing is
  filtered (checked), "N of M trips", responses, escalations.
- **Details now include the trip's comments** ("What people wrote · N",
  verbatim cards) under its scores, hotels and facts; the button reads
  Details / Hide details.
- **The open Details panel was a dark navy slab in light mode**
  (`rgba(22,41,74,.55)`, a leftover from the navy theme) with its headings
  nearly invisible. Now `var(--card-2)` with a teal edge, headings in
  `--text-2`.
- **This tab puts verbatim customer comments, including the escalated
  KUMSA complaint, and staff names (Salim, Surti, Maria, Roy) on a public
  URL with no login.** No traveller names are in the sheet. Flagged to
  Anton when it was built; he chose to proceed.

## Impact tab (Operations), 20 Oct 2026

Anton: a tab under Operations called Impact, from the "NomuHub Impact
Dashboard" workbook on SharePoint (link in **`IMPACT_SHEET_URL`**, Vercel
only; the repo is public). `lib/tabs/impact.js`, served as
`/api/sheets?name=impact` (5 min cache), `data-view="impact"`,
`#impactWrap`, classes `im-`.

- The workbook: a **Summary** tab and one tab per region (**Africa**,
  **Asia**, **Other Regions**), each one row per trip since 2017: No. |
  Year | Region | Destination | Trip Code | Client | Trip Type | Theme |
  Start | End | Travellers | Officer in Charge | Village / School | Impact
  Description | Status. Region tabs are found by that header row (Impact
  Description + Status), not by name, so a new region tab is picked up.
- **Counts are recomputed from the rows and match the Summary tab exactly**
  (checked 20 Oct 2026): 193 trips (Africa 109, Asia 75, Other 9), 174 with
  impact recorded, every year and theme row. "Impact recorded" = Recorded
  (incl. "Recorded (recovered…)") **plus "No impact"**, as the Summary's
  own note says. "… to fill" statuses (7 missing trips, 12 missing impact)
  are the gaps; "Possible duplicate" rows would be left out of everything.
- Dates come both as real dates and typed "21/10/2023" / "28/8/24"; dates
  before 2015 (typos like 2002-07-09) are dropped, not shown. Destinations
  "To confirm" are counted but left out of By destination.
- UI, rebuilt for finding things (Anton, 21 Oct 2026: "easy to navigate and
  easy to use and filter ... not too complicated"). Two sub-tabs (`imSub`):
  **Overview**: a search box (Enter opens Find with that search), four tiles
  (Trips opens every trip), an "Impact recorded" bar, an amber "N trips
  still need details · See them ›" button, then Trips per year (stacked by
  region, `--lead-wa` / `--lead-all` / `--lead-ig`), By theme and By
  destination. **Every bar, row and tile there is a button that opens Find
  a trip filtered to it** (`imGo()`), with "Tap a bar to see …" hints.
  **Find a trip**: one search box (`imQ`, every word must match the
  destination, trip code, school / village, officer, theme, type, client,
  year or impact text; matches highlighted), one-tap **Region** and
  **Status** chips with counts (a chip with nothing left hides), Year /
  Destination / Theme dropdowns (counted given everything else), then "N of
  193 trips" with each active filter as a pill that removes with × and Clear
  all. Rows are compact (destination, year, status, type · theme ·
  travellers, 📍 place, two lines of impact) and open on tap to the full
  text plus dates · trip code · client · "Led by …" (`imOpen`). Typing
  redraws only `#imResults`, so the search box keeps focus. 10 rows, then
  Show all (the shared fold).
- Also in the Claude connector (`get_impact`, year / destination filters)
  and the AI Adviser's snapshot.
- **Officer in Charge names are shown** (as Feedback shows staff names);
  the page is behind the login. Ask before hiding them.

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
- **No "Hidden" placeholders (Anton, 5 Oct 2026):** the Revenue / Expenses /
  Profit tiles and columns are gone entirely, not shown as "Hidden". The
  page has no column, tile, tooltip or word for an amount.
- **Three groups, not six programmes** (Anton, 5 Oct 2026, "the same goes
  with Trip revenue tab", after the Feedback request): `groupOf()` in
  `lib/tabs/revenue.js` turns the sheet's Program column into **Volunteering**
  (Building + Medical + Teaching), **Wellness** (Wellness, and "Wellness &
  Explore", which resolves WL-first like the project codes) and **Explore**,
  so the Programme filter, the By programme table, the trip subtitles and the
  Suggestions all use them. Margins are recomputed per group from the
  amounts, so nothing else changed (39 trips, 32.4%).
- UI, two sub-tabs (`rvSub`: `'overview' | 'trips'`): Margin is the
  headline; Trips count with "N not entered yet"; a year bar split "Expenses
  67.6% / Profit 32.4% of revenue"; an amber callout listing trips that have
  ended with no figures; then **Suggestions**; then By month and By
  programme tables (Margin | bar | Trips; programme sorted by margin).
  **All trips**: Programme / Result filters, rows grouped by month (Trip |
  Margin | bar | Result), no footer total. The By project manager table, the
  Manager column and filter were removed.
- **Suggestions** (Anton: "put some AI suggestion based on profit or a
  suggestion to what to improve"): `suggest()` in `lib/tabs/revenue.js`,
  sent as `suggestions: [{ level, title, text }]`, shown as cards tagged
  Fix (red ▼) / Improve (amber ■) / Keep doing (green ▲) / Note (grey ○),
  highest priority first, at most 8. **They are rules over the sheet, not a
  live AI call**, and the panel says so in its tooltip. Rules: trips that
  lost money (expenses as a multiple of revenue); a programme that is a big
  share of trips but a small share of revenue; the lowest-margin programme;
  trips under 15% margin; the strongest programme and trips at 45%+; finished
  trips with no figures; the overall margin band (30%+ healthy, 15–30%
  workable, under 15% thin). Thresholds `THIN` / `HEALTHY` at the top of the
  file. **They are computed server-side from the real figures but written
  with percentages, ratios and trip names only**: never put an amount or a
  manager in a sentence (checked against the live output). A real Claude API
  version would need `ANTHROPIC_API_KEY` in Vercel and a cache, and was not
  built; offered to Anton.
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

## Cost per result alert (Slack + Campaign Ads)

Muatasam, 8 Oct 2026: "Add alert for higher cost per result for campaigns
... not more than 20 per result" (Anton read it as USD, built as $20), then
the same day: **"Alarm should be 25 SAR"**. The limit is now **SAR 25**, in
the report currency, no USD conversion.

- **Rule lives in `api/campaigns.js`**: `cprOver` = status Active **and**
  at least `CPR_ALERT_MIN_RESULTS` (5) results **and** year-to-date cost
  per result > `CPR_ALERT_LIMIT` (25, SAR). The payload carries
  `cprLimit: { report, minResults }`. Zero-result campaigns never count
  (no cost per result; the board already flags them). Min 5 results and no
  zero-result alert were defaults Anton accepted with the plan.
- **Board:** a line under "Budget vs actual by campaign" ("Cost per result
  limit: SAR 25 for running campaigns · none over" / "▲ N over: names") and
  a red `▲ 41.98` pill on the Cost / Result cell of each running campaign
  over it, with a tooltip. Classes `cpr-over`, `cpr-note`.
- **Slack:** `lib/cost-alerts.js`, run from `api/campaign-alerts.js` (the
  cron-job.org 2-minute job), gated to once per 10 minutes by
  `SET cpr-alerts:tick NX EX 600` (`CPR_ALERT_EVERY_S`). Fires when a
  campaign crosses, not on a schedule. One alert per crossing:
  `cpr-alerts:over:<account>:<id>` is claimed (no expiry) when it goes over
  and deleted once the campaign is no longer over (back under, paused),
  which re-arms it. Several crossing in one check share **one message**
  (a list), so a limit change doesn't flood the channel. A failed Slack post
  releases the claims. Runs after the on/off alerts and can't block them.
  `?preview=1` on campaign-alerts includes a `cpr` block.
- Message (one): "🚨 Campaign: <name> is over the cost per result limit.
  Cost per result is SAR 41.98 (limit SAR 25), after 12 results on SAR
  503.73 spent. Please review: <dashboard>/#campaigns". Several: "🚨 N
  campaigns are over the cost per result limit SAR 25:" then one bullet each.
- It's the **year-to-date** cost per result (what the board shows), so it
  moves slowly. When the limit went to SAR 25, all 5 running campaigns were
  over (25.88 to 74.05), so the first check posted them as one list.

## Running campaigns · lead quality (Campaign Ads)

Muatasam, 8 Oct 2026 (via Anton, with a spec drafted in Claude chat): link
high potential leads to campaigns, beside cost per result, to see which
running campaigns perform best. Panel between the budget hero and the
budget table: Campaign (project under it) | Status | Leads | High potential
| High potential rate (bar, `--tgt-hp`) | Cost / Result | Cost / HP lead,
best first (Good, Watch, Bad, then by cost per HP lead). No footer line under the table (Anton asked for it
removed, 8 Oct 2026); the average cost per HP lead is in the title's tooltip.

- **Built in `api/campaigns.js` (`addLeadQuality`)**, sent as each running
  campaign's `leadQuality` plus a payload-level `leadQuality` (`avgCostPerHp`,
  thresholds, `error`). It reads the leads workbook itself
  (`LEADS_SHEET_URL`, `lib/tabs/leads.js` `build()`), so the campaigns
  endpoint now depends on the leads sheet too; if that fails the panel shows
  the error and everything else still loads.
- **The link is by project, not by ad.** Meta can't say which lead came from
  which ad, so a campaign's project comes from its name via
  `booking-report.js` `leadProject()` (`classify()` + SA / MO / ALAULA):
  EB-ZNZ-EX-202612-01C -> ZNZ|EX, matched against Marina's daily project
  codes ("SL" / "KN" with no programme match on destination). Leads and HP
  are summed **from the campaign's start (Muscat day) to today**, so they
  include the project's leads from any source (organic too), and two
  running campaigns on one project read the same leads (`sharedWith`, shown
  as "shared"). A campaign with no project in its name (Winter Trips
  (Instagram Post Boost)) shows "Not linked". **Running campaigns only**:
  older ones fall in late Jul - Sep, which has no daily entries.
- **Status** (from the spec; 10% and "the average" are placeholders until
  Muatasam sets a cost per HP lead target): under 5 leads -> Watch (too
  early); 0 HP or HP rate under 10% -> Bad; cost per HP lead at or below the
  average of running campaigns with HP -> Good; otherwise Watch. Env:
  `LQ_MIN_LEADS` (5), `LQ_MIN_HP_RATE` (0.1). Cost per HP lead = the
  campaign's year-to-date spend / HP (= since start for these).
- First live read, 8 Oct 2026: ZNZ-EX 10 leads / 1 HP (Watch, above average),
  BA-TA 4 / 1 (Watch, too early), ZNZ-TA 9 / 0 and SL-EX 9 / 0 (Bad), Winter
  Trips not linked. Average cost per HP lead SAR 553.
- The daily leads (20) and HP (5) targets and their alert were **left as
  they are** (Anton: ignore the spec's suggestions on those).

## Leads target alert (Slack)

Asked for by Anton, 6 Oct 2026: `api/lead-alerts.js` posts to living-room
(`SLACK_WEBHOOK_URL`) when a day's leads miss **20 overall** or **5 high
potential** (`LEADS_DAILY_TARGET` / `HP_DAILY_TARGET`). Nothing posts when
both are met. Wording: "🚨 Leads alert · Sun 4 Oct / Overall leads: 21
(target 20) ✅ / High potential: 1 (target 5) ❌ / <which target> did not
meet the target (or "Both targets were missed."). Please review the Leads
tab: https://crm.nomuhub.com/#leads".

- **Runs from cron-job.org once a day at 11:30 PM Muscat**, GET with
  `Authorization: Bearer $CAMPAIGN_ALERT_SECRET`. Marina fills the day in
  around **6 PM Oman time**, once a day (she confirmed to Anton, 6 Oct 2026),
  so it's in by then. Each run also looks at yesterday, so a day logged
  after 11:30 PM is judged the next night; an unlogged day is reported as
  `waiting`.
- Each day is judged **once**: `SET lead-alerts:<date> NX EX 30d` in Upstash,
  pass or fail, so a later edit to the sheet doesn't re-alert. A failed
  Slack post deletes the claim so the next run retries.
  `LEAD_ALERTS_FROM` (default 2026-10-06) stops it replaying older days.
- Numbers come from `lib/tabs/leads.js`'s own `build()`, so the alert and
  the tab agree. No HP recorded for a day: judged on leads alone, the HP
  line says "not recorded".
- `?preview=1` (`&date=YYYY-MM-DD`) shows what would post, posting nothing;
  still needs the secret. Only counts leave it, never sheet rows.
- **HP target was 10, changed to 5 on 7 Oct 2026** (Anton: "I was asked to
  adjust the High potential target to 5"), on the chart and in the alert
  together. With 10 it was missed every day (best was 3); at 5, 30 Sep (3)
  and most days since still miss it, so alerts stay frequent. The 10 was
  also in the Leads tab text (target line, "N of 5" tooltip, legend), all
  driven by the one constant.

## KPIs tab (Corporate) + daily KPI / artwork messages

Muatasam via Anton, 12 Oct 2026: one tab with every **sales and marketing**
KPI (no operations ones for now), each just **Passed / Failed**, with **why**
and **what to do**; he doesn't want to check every tab. Plus one short daily
Slack message (passed / failed, no raw numbers) and an alert for marketing
artwork that isn't ready a week before its post.

- **`lib/kpis.js`** computes everything from the same builders as each tab:
  `booking-report.js` `build()`, `lib/tabs/leads.js`, `api/campaigns.js`
  `build()` (cost per result, lead quality, budget), `lib/tabs/engagements.js`
  and `lib/calendar.js`. Sources load in parallel and each fails on its own
  (row reads "Not checked"). Served as `/api/sheets?name=kpis`
  (`lib/tabs/kpis.js`, 5 min cache); `vercel.json` gives `api/sheets.js`
  and `api/slack-notify.js` `maxDuration: 60` since this reads every source.
- **KPIs and targets** (`T` at the top of `lib/kpis.js`; env overrides):
  Sales: bookings this week on pace for 12 (12 ÷ 7 × days gone, as the
  Report), leads per day ≥ 20, HP per day ≥ 5, conversion ≥ 10% (bookings ÷
  leads, as the Leads tab), leads sheet up to date (yesterday logged).
  Marketing: **cost per result per running campaign** ≤ SAR 25 (one KPI per
  campaign, `cprOver`, judged from 5 results), no running campaign rated Bad
  on lead quality, no running campaign over budget (engagement rate ≥ 1% was here until
  19 Oct 2026, removed at Anton's request), posts in the last 7
  days ≥ 3 (proposed; **since 18 Oct 2026 counted from the monday calendar**:
  posts marked Posted, or Scheduled with a date already reached, in the last 7
  days, `calendar.published`; it read Maryam's sheet before, which she updates
  weekly, so it showed 0 posts between updates and she flagged it), artwork ready 7 days before posting,
  posts planned for the next 14 days ≥ 6 (proposed). "Proposed" targets are
  flagged in the tab until Muatasam confirms them.
- **Removed (Anton, 12 Oct 2026)**: bookings last week, high potential
  rate, leads tagged with a trip, story response rate. Don't add them back.
- **Every KPI has a hover explanation** (`ABOUT` in `lib/kpis.js`, sent as
  `about`, shown on the KPI name): what it measures and where from.
- **Campaign spend within budget** = each running campaign's **year-to-date
  spend, live from Meta**, against its **budget from the media plan**
  (`Updated Budget.xlsx` via `media-plan.js`, matched by project), or the
  assumed **$500** (`META_DEFAULT_BUDGET_USD`) when it has no plan line; USD
  at 3.75. Not Meta's own ad-set budget. Live 12 Oct: SL-EX and Winter
  Trips are on the $500 default.
- **Lead-based KPIs use the Leads tab's weeks**: this week once it has 3+
  logged days, otherwise last week (so a Sunday doesn't read as a fail).
  Engagement and stories use this month, or last month if nothing is
  recorded yet (each on its own).
- **Marketing calendar (`lib/calendar.js`)**: monday month boards in the
  Marketing workspace (`121351`; "July 2026" ... "December 2026" in folder
  `3231011`), found by their **month-year name** from last month on, so a
  new month board is picked up by itself. Columns differ by month (Oct+:
  Posting Date + Artwork Status; Nov adds Post Status; Sep: one Status), so
  the first date column is the post date and a post is **ready if any
  status column says Posted / Scheduled / Approved / Done / Complete**;
  Working on it, Pending Review, Revision Needed or blank are not. Groups
  Hashtag Bank / Ideas / Archive aren't posts; items without a date are
  skipped. Scope: today onwards, plus past posts still not ready. Artwork
  is due 7 days before the post (`ARTWORK_LEAD_DAYS`); not ready on or after
  that = **late**. Live 12 Oct: 3 late (14, 15, 18 Oct, Working on it).
- **UI**: summary (a pass-rate ring, Passed / Failed boxes, Sales and Marketing
  x / y chips, and one glowing segment per KPI with its name on hover; the
  explanatory note under it was removed at Anton's request, 12 Oct), then Sales and
  Marketing tables (KPI + target | Status | Why | What to do), failed first.
  **The per-campaign cost rows sit in one accordion row** ("Cost per result ·
  running campaigns", Failed if any campaign fails; click to open,
  `kpOpen`), and counts treat it as one KPI. Made obvious on 12 Oct (Anton:
  "more visible that there is inside of it"): yellow-tinted row with a dashed
  bottom edge, a yellow caret badge, a "5 campaigns inside" chip and a
  "Show the 5 campaigns" button; the opened campaigns are indented with └. The lead-quality and budget
  KPIs stay separate rows, outside it (Anton).
  Rows with a list (late artwork, campaign lead quality, planned posts) show
  it on hover ("▸ See the list"). Classes `kp-`.
- **Slack**: the separate artwork alert is **off since 13 Oct 2026** (Anton: the
  KPIs tab already covers it); only the KPI message posts. `slackArtwork()`
  is still in `lib/kpis.js` if it's wanted back.
  `api/slack-notify.js` (Vercel cron, 8 AM Muscat) now also posts
  `slackKpis()` (Failed / Passed names only, per-campaign cost rows joined
  into one line) and `slackArtwork()` (only when something is late: name,
  post day, status). `?preview=1` shows them as `kpiMessages`. A KPI
  failure never blocks the bookings message.
- A temporary secret-gated `calendar-discover` tab was used to read the
  board layout and removed; `api/sheets.js` keeps the generic `secret` gate.
- **Redesigned 19 Oct 2026** (Anton: "more clean and clear and not too
  hurting to the eye"): a quiet summary (small ring "4 of 11", "N of M KPIs
  passed", two soft chips, Sales / Marketing bars on a neutral track); then
  an **All / Failed / Passed** filter (`kpShow`); then one list per area,
  failed first, each row a small ✓ / ✗ icon, the KPI and its target, why,
  and for a failure "Next step" (the action). No tables, no glowing boxes,
  no 11-block red/green strip. The cost-per-result campaigns are still one
  row that opens (`kpOpen`, "Show the 4 campaigns"), indented when open.
  Classes `kp-`; the old `kp-table` / `kp-seg` / `kp-stat` styles are gone.
- Not built: a monday **board** for KPIs (needs write access; the tab is the
  board for now). Operations KPIs were left out as asked.

## AI Adviser (live, 15 Oct 2026)

A chat bubble on every tab (bottom-left corner, `#adv`, classes `adv-`) that
answers questions about the dashboard's data and strategy, run by Claude.
Anton's rules (15 Oct 2026): **dashboard / strategy questions only, read-only
(an adviser, never an agent), 10 questions a day, no passcode.**

- **`api/advisor.js`** (the **12th and last** Vercel function; there's no
  slot left, so the next new endpoint means merging two). `GET` returns
  `{ connected, limit, used, remaining }`; `POST { question, history }`
  returns `{ answer, kind, remaining }`.
- **Read-only by construction**: the model receives a text snapshot and **no
  tools**, so it can't change anything; its system prompt also refuses code
  and change requests.
- **Snapshot (`lib/advisor-context.js`)**: built from the dashboard's **own
  endpoints over HTTP** (`/api/trips-progress`, `booking-report`,
  `previous-trips`, `campaigns`, and `sheets?name=` leads / engagements /
  trips / feedback / revenue / pending / kpis), so it sees exactly what the
  tabs show, already sanitised (revenue in percentages only, no lead
  details). Summarised to about 10-11k tokens; cached 5 minutes per warm
  instance. Base URL `DASHBOARD_URL` or the request host.
- **Credit protection**: (1) a Claude **Haiku 4.5** gate sees only the
  question (plus the previous one) and answers DATA / CHANGE / OFF; CHANGE and
  OFF get a fixed reply without the snapshot ever being sent. (2) **10
  questions a day, shared** (`ADVISOR_DAILY_LIMIT`), Upstash
  `advisor:count:<Muscat date>`, counted before answering so two people can't
  both take the last one; every send counts, including off-topic ones; a
  technical failure `DECR`s it back. (3) Questions up to **20,000 characters**
  (was 800; Anton, 19 Oct 2026: no small limit), history the last 6 turns,
  each up to the same length.
- **Model routing (Anton, 15 Oct 2026)**: the Haiku gate answers SIMPLE /
  COMPLEX / CHANGE / OFF. SIMPLE goes to Sonnet 5.5; COMPLEX (root causes,
  several areas together, comparisons, forecasts, plans, full reviews) goes to
  **Opus 5.5** (`ADVISOR_DEEP_MODEL`), at most `ADVISOR_DEEP_LIMIT` (4) a day
  (`advisor:deep:<date>`), then Sonnet. Opus answers carry a "Deep analysis"
  tag in the chat. Each still counts as one of the 10.
- **Model**: Claude **Sonnet 5.5** (`ADVISOR_MODEL`), effort `medium`,
  `max_tokens` 8000, the snapshot block cached (`cache_control`) so a
  follow-up within minutes re-reads it cheaply, and server-side refusal
  fallbacks on (`server-side-fallback-2026-07-01`, `fallbacks: "default"`).
  Uses the official **`@anthropic-ai/sdk`**, the project's only npm dependency
  (`package.json`; Vercel installs it, it can't be required locally).
- **Key**: `ANTHROPIC_API_KEY` in Vercel, created by Anton in the Claude
  Console under the **NomuHub Dashboard** workspace (monthly limit $30), key
  name crm-dashboard, expires 31 Dec 2027, linked to Anthony's account (it
  stops if he leaves the org). The org ("Anthony's Individual Org") holds a
  **$25 free credit expiring 16 Oct 2027** and **no card**, so $25 is the real
  ceiling until someone adds funds. Expected cost about $0.03-0.07 a question.
- **UI**: greeting + 4 starter questions, user messages in yellow on the
  right, answers rendered from a small safe markdown subset (escape first, then
  bold / headings / bullets / numbered), a "Reading the dashboard…" indicator,
  and "N of 10 questions left today" under the box; at 0 the box locks until
  midnight Muscat. History is kept in `sessionStorage` (`nomuAdvisor`).
- **No passcode** (Anton's call, after being told anyone with the link can use
  the 10 a day).
- **Timeouts (19 Oct 2026)**: a long multi-part question went to Opus and
  ran past the function's 60 s; Vercel cut it off, the chat showed
  "Something went wrong" and the question wasn't given back. `api/advisor.js`
  now has `maxDuration: 300` (vercel.json) and stops the Claude call itself
  at a 280 s budget (`BUDGET_MS`, SDK `timeout`, no retries), answering with
  a clear "took too long, split it" message and returning the count. The page
  also says so on a bare 502 / 504 instead of the generic message.

## Install as an app (PWA), 18 Oct 2026

Anton dropped the Windows `.exe` (the `desktop/` Electron app, its GitHub
Actions build and `.vercelignore` were deleted; the v1.0.0 GitHub Release with
`NomuHub-CRM-Setup-1.0.0.exe` may still exist and can be deleted on GitHub).
Instead the site installs **as an app from the browser** (a Progressive Web
App): its own icon on the desktop / Dock / Start menu / home screen and its own
window, on Windows and Mac (Chrome, Edge; Safari "Add to Dock") and phones.

- `manifest.webmanifest` (name "NomuHub CRM", standalone, theme `#2099ac`,
  icons `brand/icon-192.png` / `brand/icon-512.png`, also maskable) and
  `sw.js`, a service worker that **caches nothing** (the app always shows the
  live site; navigations that fail offline get a small "You're offline"
  page). Both are let through the login gate (they hold no data).
- **Install buttons**: a banner on the **login page** (styled after a HASA
  EMMS example Anton sent: "Install NomuHub CRM on this device", Install, ×;
  × remembered in `localStorage` `nomuInstallHide`) and **Settings › Install
  app** in the sidebar (`#installApp`; the group was "Account", renamed back
  to Settings). Chrome / Edge get their native prompt via
  `beforeinstallprompt`; elsewhere the steps are shown (iPhone: Share › Add to
  Home Screen; Mac Safari: File › Add to Dock; Firefox can't install). Both
  hide when already running installed (`display-mode: standalone`).
- Updates need nothing: the installed app loads the live site each time.

## Dashboard tab (executive overview), 19 Oct 2026

Anton, after a meeting with Shakir Khatti (who built HASA Energy's EMMS) and
a HASA screenshot as the reference: "an overall Dashboard ... what the
executives want to check and they can see the details to each when they
press a particular card". Shakir's advice used: bookings in the last 24
hours / this week / this month against target, a feedback card, trip
revenue, a bookings-by-month graph filterable by category and 6/12/24
months, quick overview first and the detail one tap away, easy on the eyes.

- **Sidebar**: new first category **Overview › Dashboard**
  (`data-view="overview"`, `#overviewWrap`, `#overview`). `let view =
  'overview'` is the default; a device with a saved tab still reopens it.
- **No new endpoint** (12 of 12 functions used). `renderOverview()` reads
  the data each tab already loads (`latest`, `report`, `previousTrips`,
  `leads`, `campaigns`, `engagements`, `feedback`, `revData`, `monData`,
  `kpiData`); opening the tab loads whatever's missing, and every loader
  calls `ovSoon()` so cards fill in as their source arrives ("Loading …"
  until then). A card and its tab can't disagree.
- **KPI scorecard first** (Muatasam, 19 Oct 2026: "Also pls in dashboard.
  Add daily, weekly, monthly KPIs"; `ovScore()`): one row per KPI, three
  columns, each cell the value "of target", ✓ / ✗, a bar (with the pace mark
  where it applies) and a line. **Daily = yesterday** (the last whole day,
  and the one Marina has logged), **Weekly = this week so far** (Sun–Sat,
  Muscat), **Monthly = this month so far**, judged on pace. Rows: Bookings
  (**2 a day** — a round 2, Anton 19 Oct 2026, not 12 ÷ 7 — / 12 a week /
  12 × days ÷ 7 a month, "N in the last 24 hours" under the name), Leads (20
  × days logged), High potential (5 × days with HP), Conversion (10%;
  **daily added 19 Oct 2026** at Anton's request, though Muatasam had said
  on 8 Oct daily makes no sense: a day's bookings rarely come from that
  day's leads, so it swings). "N of M on target" in the title. **Pickers per
  column (Anton, 19 Oct 2026)**: Daily (today and the last 60 days:
  "Yesterday", "Today so far", then dates), Weekly (Sunday–Saturday, this
  week and the 39 before) and Monthly (this month and the 11 before) each
  have a dropdown in the heading with the exact dates in small text under it
  (`ovPickDay` / `ovPickWeek` / `ovPickMonth`, null = default; `ovPicker()`).
  A **finished** period is judged against its whole target ("N short" /
  "Target reached", no pace mark); the current one on pace. A month's
  bookings come from `previousTrips.sales` (whole month, back past the
  Report's 300 days); a day / week from the Report's events. Leads data
  starts 1 Jul 2026, so earlier periods read "Nothing logged". Checked: last
  week = 38 leads, 2 bookings, 5.3%, same as the KPIs tab. **The engagement rate
  KPI was removed everywhere** (Anton, 19 Oct 2026): Dashboard scorecard,
  KPIs tab, daily Slack KPI message, AI Adviser targets; `lib/kpis.js` no
  longer reads the engagements sheet and `KPI_ENGAGEMENT` is gone. The
  Engagements page itself (Maryam's posts and stories) is unchanged. The earlier This week / month / year toggle was
  removed: the three columns replace it. Rows link to their page. On a phone
  the name sits above the three cells.
- **At a glance** (`ovGlance()`, `ovCard()`: icon, name, pill, number "of
  N", bar, one line; whole card links to its page), three per row: **Cost
  per result** (running campaigns within SAR 25, `cprOver`), **Ad budget
  used** (YTD spend ÷ media-plan budget, mark = share of the year gone),
  **Guest satisfaction** (YTD + latest surveyed month, escalations), **Trip
  margin** (**percentage only**, Muatasam's rule; 30%+ healthy mark), **All
  KPI checks** (the KPIs tab's pass count, cost-per-result rows as one),
  **Pending tasks** (monday statuses as a stacked bar in monday's colours,
  overdue count). **PDF** button = `print()`, with an `@media print` block.
- **Bookings by month** (`ovChart()`): `previousTrips.sales.months`, a
  **Monthly / Yearly** switch (`ovGran`, Anton 19 Oct 2026: yearly = one bar
  per year from the first year of data, 2019, to now; the current year
  hatched "so far"; target 12 × days in the year ÷ 7; the headline is this
  year so far plus the total since 2019); in monthly, 6 / 12
  / 24 months (`ovMonths`), category filter (`ovCat`: All, a destination, a
  programme, or a destination + programme). Needs **`cats`** per month, added
  to `api/previous-trips.js` `salesByMonth()` this day (`"TH|WL"`, `"ZNZ"`,
  or `"Other"`, via `booking-report.js` `leadProject()`). Dashed target per
  month (12 × days ÷ 7) only for All; the current month is hatched.
- **Upcoming departures** (`ovDepartures()`): every upcoming departure week
  as Sold out / At target (10+) / Below target / Cancelled, seats booked,
  and the next four trips out.
- **Flagged to Anton**: Shakir suggested showing revenue amounts
  ("$5,000 target, $2,300 achieved"); not done, because Trip Revenue is
  percentages only until Muatasam says otherwise. And with the 12-a-week
  target the year reads 116 of 626 (19%), so the bookings cards will be red
  most of the time; that's the agreed target, not a bug.
- **Booking filters** (Shakir: filter by month and by trip, "so only
  existing items populate"; 19 Oct 2026): above the board, **month pills**
  (All months / Nov 2026 / Dec 2026 …, each with its count) and a **Trip**
  dropdown (All trips, then Destination / Programme / Trip groups, each with
  its count), built from the departures on the board, so an option with
  nothing in it is never offered and counts follow the other filter. A
  Clear button when filtered. `bkMonth` / `bkCat` / `bkFilterBar()` in
  `index.html`; needs **`pd` / `pg` per trip, added to
  `api/trips-progress.js`** the same day (via `booking-report.js`
  `leadProject()`); without them the Trip dropdown just doesn't show.
- Not done yet from the meeting: push notifications once installed.
- Classes `ov-`. Checked in both themes, at phone width (2 cards a row, 1
  under 360px), against live data for all three periods.

## Claude connector (MCP server), 19 Oct 2026

Anton: an API with read access to the whole CRM, connected to Claude as a
connector "like the Meta connector", so he can chat with the data from
Claude itself. Built as a **remote MCP server** (Streamable HTTP, stateless
JSON-RPC) at **`https://crm.nomuhub.com/mcp`**; add it in Claude under
Settings › Connectors › Add custom connector (URL only, no client ID).

- **`lib/mcp.js`**, run **inside `api/advisor.js`** (12 of 12 functions
  used): `vercel.json` rewrites `/mcp`, `/oauth/register|authorize|token`
  and `/.well-known/oauth-protected-resource`, `oauth-authorization-server`,
  `openid-configuration` (and their `/…` suffixed forms) to
  `/api/advisor?route=…`, and the handler hands those to `lib/mcp.js`.
  `middleware.js` lets those paths past the login gate.
- **Sign-in is OAuth 2.1 with PKCE and dynamic client registration**, all
  stateless: the client_id is a signed blob carrying its redirect URIs;
  `/oauth/authorize` is a NomuHub page asking for the **dashboard password**
  (same 10-per-15-minutes limit, `login-fail:<ip>`); codes (5 min), access
  tokens (30 days) and refresh tokens (180 days) are HMAC-signed with
  `SESSION_SECRET`/`CAMPAIGN_ALERT_SECRET` **plus the password**, so changing
  `DASHBOARD_PASSWORD` disconnects every connector. No token = 401 with
  `WWW-Authenticate: Bearer resource_metadata=…`, which starts Claude's
  sign-in.
- **Read-only by construction**: 13 tools, all `readOnlyHint`, each reading
  one of the dashboard's own endpoints with the Bearer secret (same data the
  tabs show: revenue percentages only, leads as counts):
  `get_crm_overview` (the AI Adviser's text snapshot, `lib/advisor-context.js`),
  `get_upcoming_departures` (destination / month filters),
  `get_bookings_taken` (from / to), `get_sales_history` (year; `byDay`
  dropped to keep it small), `get_leads`, `get_ad_campaigns`
  (running_only), `get_campaign_history` (year), `get_social_engagement`,
  `get_trip_products`, `get_guest_feedback`, `get_trip_margins`, `get_impact`,
  `get_kpis`, `get_pending_tasks`. No write tool exists.
- Nothing here costs Claude API credit: the user's own Claude does the
  thinking; the dashboard only serves data.
- **Use crm.nomuhub.com, not bookingprogress.vercel.app**: Vercel's
  Security Checkpoint started answering scripted requests on the vercel.app
  domain with 403 on 19 Oct 2026.

## Shorter pages and the phone layout (19 Oct 2026)

Anton: "check each tab and make sure to avoid having long scrolls, have a
filter if needed ... specially the mobile version ... more mobile friendly".
Done generically, in one block at the end of the script ("shorter pages"),
so no page's own render code changed:

- **A `MutationObserver`** watches every page wrap (`pvWraps`); after any
  render it runs `pvTidy(wrap)` on a `setTimeout(0)` (**not**
  `requestAnimationFrame`: rAF doesn't run in a background tab, and the
  chips never appeared in testing). Its own bars and buttons are ignored, so
  it doesn't loop.
- **Page chips** (`PV`, `.pv-bar`): a page made of several panels shows one
  part at a time. **Every screen**: Leads (This week | Trends) and Previous
  Sales (Charts | Projects). **Phones only (≤ 700px)**: Dashboard (KPIs | At
  a glance | Bookings), Campaign Ads (Budget | Lead quality | Campaigns), and
  `auto` on Report, History, Engagements, Trips, Feedback, Revenue, KPIs (one
  chip per titled panel, named from the title before " · "; an untitled
  panel joins the one before). The chosen chip is kept across re-renders
  (`pvSel`). Sticky on phones.
- **Long lists fold** (`CLAMP`, `.pv-more` "Show all N ▾" / "Show fewer"):
  `table.ctable` bodies (not `.kp-table` / `.fb-matrix`) after 10 rows, the
  monday task list after 10, Previous Sales after 3 months, Feedback comments
  after 3 trips per programme, and **on phones only** the Booking board after
  its first month (on a desktop the board may be a wall display, so it never
  folds there). A list folds only if that hides more than a couple of rows;
  a month heading left with no rows showing is hidden too. Opened lists stay
  open (`pvOpen`).
- **Phone layout (≤ 700px)**: an app-style **bottom bar** with the five
  sections (`#botNav`, `.bn-item`, same `data-section` buttons as the
  sidebar; the ☰ drawer keeps Settings); a one-row header (title, Refresh,
  theme; the booking figures and PDF hidden); the AI Adviser bubble sits
  above the bar, smaller, without its cloud. Section tabs scroll sideways.
- The Adviser bubble's gradient was still the old yellow in dark mode; now
  teal.

## Colour and contrast pass (19 Oct 2026)

Anton: "make sure to always check the color so everything is visible and
not hurting the eye". **`tools/contrast-audit.js`** is run inside the real
page (pass it as the 8th argument to `tools/webkit-shot.js`): it walks every
visible text node, blends its colour over the real background stack, and
lists anything under WCAG 4.5:1 (3:1 for large/bold text) as
`window.__out`. **Run it on every page in both themes after any colour or
layout change.** Known false positives: chart axis numbers and the Report's
"TARGET 12/WEEK" flag sit on a 1–2px line element, so the audit reads the
line's colour as their background.

What it found and what changed:
- Light `--text-3` (#6d8792, 3.8:1 on white) → **#527079**; light accent
  `--yellow` (#1a8fa1, 3.8:1) → **#137483** (`--acc-rgb` follows; bars keep
  `--fill` #2099ac); light `--good-ink` → #0f7a3a.
- **Status colours as text** now use ink tokens per theme: `--target-ink`,
  `--warn-ink`, `--hp-ink`, `--fresh-ink` (amber on white was 1.6–1.9:1:
  "■ Watch", "Improve", "5 HP"); `--bad-ink` for late dates, "▼ −8%",
  cancellations. Inline status colours set in JS (Trips' quality glyphs,
  Revenue's result / suggestion tags) are mixed with the strongest ink:
  `color-mix(in srgb, <status> 50%, var(--strong))`, which darkens in light
  and lightens in dark. The Leads target-line labels do the same.
- Trips' quality pills and R&D strip had **white text on a pale tint** in
  light mode (invisible): now `var(--strong)`.
- Leftover navy literals: table borders and row hover
  (`rgba(52,81,124,…)`) → `var(--line)` / an accent tint; a few dividers.
- Cancelled week numbers: white on #b8342b in both themes.
- Rule for new CSS: **text never takes a status or chart colour directly**;
  use an ink token or the colour-mix above, and run the audit.

## Login gate, light / dark mode (18 Oct 2026)

Anton: password-only login (no username), stay signed in for a month while
the device keeps being used, a login page in the logo's teal; a light / dark
switch (light = NomuHub brand teal, dark = the original navy); and a New chat
button on the AI Adviser.

- **`middleware.js`** (Vercel Routing Middleware, Edge; uses
  `@vercel/functions/middleware` `next()`, pinned in `package.json`) gates
  **every path, page and `/api/*` alike**, because the site and repo are
  public and a page-only gate would leave the data endpoints open. The
  password is **only in Vercel: `DASHBOARD_PASSWORD`** (never in code: the
  repo is public). **Until it's set the gate is off**, so a deploy can't lock
  anyone out. Login page served by the middleware itself (teal gradient,
  white card, `/brand/logo.png`, show/hide, keeps the `#hash` you came to).
- **Session**: cookie `nomu_session = <exp>.<HMAC-SHA256>` keyed with
  `SESSION_SECRET` (or `CAMPAIGN_ALERT_SECRET`) **plus the password**, so
  changing the password signs every device out. 30 days, HttpOnly, Secure,
  Lax; a page visit with under 29 days left re-issues it (sliding 30 days).
  `/logout` clears it (sidebar Settings › Log out). Wrong passwords: 10 per IP
  per 15 minutes (`login-fail:<ip>` in Upstash), then "Too many tries".
- **Let through without a login**: `/api/campaign-alerts`, `/api/lead-alerts`,
  `/api/slack-notify` (they check their own secrets), `/manifest.webmanifest`
  and `/sw.js` (the app install files), any request with
  `Authorization: Bearer $CAMPAIGN_ALERT_SECRET` (the AI Adviser's snapshot
  in `lib/advisor-context.js` sends it), `HEAD /` (was for the removed desktop
  app's update check; harmless, no body), and `/brand/*`, favicon. Unauthenticated `/api/*`
  gets 401 JSON; the page wraps `fetch` and reloads to the login page on a
  401 from `/api/` (not the adviser).
- **Function budget**: middleware is not one of the 12 serverless functions
  (checked by the deploy succeeding; if a future deploy fails at 13, this is
  the first suspect).
- **Dark mode is now a dark version of the light theme** (Anton, 19 Oct
  2026: "make the dark mode ... a dark mode version of the light mode"): the
  `:root` tokens are deep teal (page `#0b1c20`, cards `#12292e`, lines
  `#22414a`) with the brand teal as the accent (`--yellow` `#3cc3d3`,
  `--fill` `#2db1c3`), and a dark teal sidebar gradient
  (`html:not([data-theme="light"]) .sidebar`). The old navy / yellow look is
  gone. Every hard-coded yellow tint (`rgba(242,178,51,…)` /
  `rgba(245,185,53,…)`) became `rgba(var(--acc-rgb),…)` /
  `rgba(var(--fill-rgb),…)`, two new RGB tokens set in both themes, so tints
  follow the accent. The one yellow kept on purpose is `--tgt-hp` (the HP
  target line and bars) and the `--q-med` status step.
- **Theme**: **light is the default** (Anton, 18 Oct 2026); dark is the
  `:root` tokens and applies when `localStorage` `nomuTheme` is `dark`. Light
  is `html[data-theme="light"]`, set before first paint. The switch is the
  sun / moon button **top right of every page** (`#themeToggle`, `.themebtn`,
  next to Refresh; it shows the mode it switches to), not in the sidebar. The
  sidebar loops select `button[data-view]` only, so non-tab buttons there
  (none now but Log out is a link) aren't tabs. To make light possible, colours that were
  hard-coded for the navy look became tokens: `--strong` (was `#fff` text),
  `--good-ink`, `--bad-ink`, `--bad-soft`, `--cancel-ink(2)`,
  `--cancel-track`, `--ov` (RGB for `rgba(var(--ov),a)` overlays, was white),
  `--well-rgb`, `--mix-ink`, `--tip-bg`. White text stays literal only on
  solid coloured badges (`.tag`, `.wcancel`, `.announce-due.soon`,
  `.trp-pill`, `.trp-strip-seg`). Light values: page `#eaf4f6`, cards white,
  accent `--yellow` = teal `#1a8fa1`, bars `--fill` `#2099ac`; the sidebar is a
  teal gradient with white text; status colours unchanged. **New CSS must use
  the tokens, not `#fff` / white overlays**, or it breaks in light mode.
- **AI Adviser panel follows the theme** (18 Oct 2026): dark is a dark teal
  panel (`--card-2`) with teal accents; light is a white panel, teal bubble / send button /
  your messages, pale teal answers. "New chat" doesn't wrap.
- **AI Adviser New chat** (`#advNew`): clears the conversation; it doesn't
  give back the day's question count.

## Pending Task tab (monday.com)

Asked for by Anton, 5 Oct 2026: a **Corporate** sidebar category with
**Pending Task**, listing every monday.com item that isn't done, with its
name, who it's assigned to and its status exactly as monday shows it.

- **Source is monday's API, not Slack.** Anton pointed at a Slack "Monday
  Reminders" channel; Cowork found it's an app with an empty message tab
  (most likely private DMs per person), so there was nothing to read. The
  monday GraphQL API (`lib/monday.js`, `API-Version: 2024-10` pinned, token
  in `MONDAY_API_TOKEN`) gives the items directly. Cowork is not allowed to
  create or enter API tokens, so Anton sets that one himself.
- **Boards** (`MONDAY_BOARD_IDS`, default, Anton's pick): Operations
  General `5102303383`, Asia `5102494784`, Africa `5102494871`, Marketing
  General `5103011662` and, from 13 Oct 2026, **Sales General `5105782939`**
  (Anton moved all sales tasks into the Sales workspace; the workspace
  Marketing & Sales is now just "Marketing"). The Sales workspace's B2B CRM
  and B2C Credit List boards are CRM data, not tasks, and stay out. Not included: Management (locked in monday),
  Corporate Admin / IT / Business Development, the monthly content
  calendars, CRM boards. Two boards are both named "General", so every
  board is labelled "<workspace> · <board>".
- **Pending = status is anything but "Done"** (`MONDAY_DONE_LABELS`).
  **An item with no status shows as "Not Started"** and counts as pending
  (Anton, 5 Oct 2026; 18 of the first 28 items had none, mostly on the
  Marketing board). It takes the board's own "Not Started" colour, else
  grey. "Done" is the only finished label on
  these boards; finished items stay in their groups (no Done group), so
  status is the only signal. Stuck, Not Started etc. all show, labelled as
  monday labels them (Anton: "Just show what exactly is in the status").
  **Main items only**, no sub-items (barely used anyway).
- Columns are found by **type**, not ID (the boards come from different
  templates): first `people` column; the `status` column titled "Status"
  (Marketing General also has a Priority status column); first `date`
  column as Due. Status colours come from the column's `settings_str`
  (`labels_colors` by the value's `index`). Each item gets an "open ↗" link
  to `https://<account slug>.monday.com/boards/<id>/pulses/<item>` (needs a
  monday login to open). Descriptions, files and updates are never read.
- **UI, modelled on a list-view mock-up Anton shared (5 Oct 2026)**, in the
  dashboard's navy instead of the mock-up's white (assumption, flagged to
  Anton). Title "Pending Tasks" with the count; underline text tabs
  **Marketing / Sales / Operations**, **no "All" tab** (removed at Anton's
  request, 5 Oct 2026; it opens on Marketing) (`monTab`, via
  `monSection()`): **the tabs are simply the monday workspaces** (since 13 Oct
  2026; before that Sales was a "Sales" group on the Marketing & Sales board),
  and any other workspace gets its own tab after these. The Board column shows the group; a **Show** dropdown on the right
  (`monWho`: Everyone, each person with their count on that tab, No one
  assigned; resets to Everyone if the person has nothing on the tab). Then a
  header row and one rounded row per task: **Task | Status | Due date |
  Board | Assignees | ↗** (open in monday). Status is monday's label in its
  own colour (text lightened for contrast, with a dot); overdue dates in red
  with ▼. On a phone the header hides and each row stacks (task + avatars,
  status + due, board + link). The earlier tiles, By person / By board
  panels and card grid were all removed.
- **Per-person colour:** `MON_PEOPLE` (12 light hues for dark initials on
  navy), assigned alphabetically over everyone on the boards so a person
  keeps their colour on every tab. Shown as overlapping initials badges
  (up to 3, then "+N"; overlap kept small so initials stay readable), with
  the full names in the badge tooltip and in the Show menu. Rows are sorted
  by first assignee so each person's colour runs together; unassigned last
  (dashed "?" badge). More than 12 people would repeat colours.
- **Public page, no login: task names and people's names are readable by
  anyone with the link.** Flagged to Anton; he chose "Show names and tasks
  as asked" (5 Oct 2026).
- Due dates are sparse on these boards (Cowork: 1 of 17 on Operations
  General), so Overdue will usually read low; that's the data, not a bug.

**Function budget: 12 of Vercel Hobby's 12 (FULL)** (sheets merged into one;
`campaign-alerts`, `lead-alerts` and `advisor` added; the Claude connector
shares `advisor`). New sheet tabs don't add
to it; a new endpoint needs two existing ones merged first.

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
