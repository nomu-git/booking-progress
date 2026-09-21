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
  `<script>`, no bundler. ~86,000 characters. Five tabs in two categories
  (`.segrow` at the top of the page):
  - **BOOKING**: Dashboard, Report, Previous Projects
  - **AD CAMPAIGN**: Campaigns, History
- `api/*.js` — CommonJS Vercel functions (`module.exports = async (req, res) => {...}`).
  Each also exports `build()` separately where another function needs its
  logic (e.g. `slack-notify.js` calls `booking-report.js`'s `build()`).
- No `package.json` dependencies really used — Node's built-in `fetch`.
  `node_modules/` in git is leftover cruft from an old Google Sheets version;
  ignore it.
- `vercel.json` — one cron: `/api/slack-notify` daily at 04:00 UTC (08:00
  Muscat).

### Booking side

| File | Role |
| --- | --- |
| `api/wetravel.js` | Shared WeTravel client. `WETRAVEL_API_KEY` is a **refresh token**, exchanged here for a 1-hour access token (cached, retried on 429/401). Also exports `mapWithConcurrency`. |
| `api/trips-progress.js` | Dashboard tab — live/upcoming departures, per-week booking bars. Keeps a departure for its whole month, drops it once the month passes. |
| `api/previous-trips.js` | Previous Projects tab — the complement of trips-progress: everything whose month has already passed. `end < monthStart` is the exact filter, so a trip is never in both views or neither. |
| `api/booking-report.js` | Report tab — flat list of booking events, last 300 days by default. Exports `build()`, reused by `slack-notify.js`. |
| `api/slack-notify.js` | Cron target — posts the day's new bookings to Slack. `?preview=1` renders without posting. Gated by `CRON_SECRET` if set. |
| `api/announcement.js` | Banner text from env vars, editable without a code change. |
| `api/trip-code.js` | **Shared** by both booking and ad-campaign sides — see "Project code scheme" below. |

Full env-var reference for the booking side (required/recommended/optional,
with defaults) is in **`README.md`** — don't duplicate it here, it's kept
current there. The one thing worth repeating: **changing an env var in
Vercel requires a redeploy to take effect** — this has bitten the project
before (a blank dashboard after an account migration turned out to be an
env var that was set but never redeployed).

### Ad Campaign side

| File | Role |
| --- | --- |
| `api/meta-ads.js` | Shared Meta Graph API client. `graphGet`/`graphGetAll` (follows Meta's cursor pagination), `getAccountMeta`, `toReportCurrency`/`budgetToReportCurrency` (USD→SAR conversion), `AD_ACCOUNTS` (env `META_AD_ACCOUNT_IDS`, default two accounts), `REPORT_CURRENCY` (env `META_CURRENCY`, default `SAR`), `USD_SAR` (env `META_USD_SAR`, default `3.75`). Token comes from whichever of `META_ACCESS_TOKEN` / `META_ACCESS_KEY` / `META_API_KEY` is set. |
| `api/campaigns.js` | **Campaigns tab.** Current year only (env `META_YEAR`, defaults to current calendar year — so this auto-rolls into 2027 with no code change). Every campaign gets its own budget (see "Budget matching" below), live spend/results/purchases from Meta. |
| `api/campaign-history.js` | **History tab.** One full calendar year at a time, picked via `?year=`. **Deliberately excludes the current year** — that's what Campaigns is for. Offers years back to Meta's retention floor (~37 months, env `META_RETENTION_MONTHS`). Every campaign uses a flat assumed budget (env `META_DEFAULT_BUDGET_USD`, default `$500`) since there's no budget sheet for past years. |
| `api/media-plan.js` | Reads `Updated Budget.xlsx` — hardcoded `ROWS` array transcribed **verbatim** from the spreadsheet's "Media Plan" sheet. This is the *plan*, not measured data. If the spreadsheet changes, this array has to be hand-updated to match — there's no live file parsing. |
| `api/trip-code.js` | The project-code generator — see below. |

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
to match ad campaigns to budget lines. Lives in `api/trip-code.js`, shared by
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
  Campaigns tab must reflect what Meta says *right now*.
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

## Testing without Node

**There is no Node runtime available in this environment.** Parse-checking
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
