# Booking Progress — WeTravel dashboard + Slack notifier

A wall dashboard for Nomu's booking pipeline. Everything is read live from the
**WeTravel Partner API** — there is no database, no Google Sheet, no webhook to
register. A once-daily Vercel cron posts a summary to Slack.

## What's in here

| File | Role |
| --- | --- |
| `index.html` | The dashboard. Polls `/api/trips-progress` every 30s, plus a Report tab backed by `/api/booking-report`. |
| `api/wetravel.js` | Shared WeTravel client. Exchanges the Partner API key (a *refresh* token) for a 1-hour access token, caches it, retries on 429/401. |
| `api/trips-progress.js` | Per-departure / per-week booking bars for the Dashboard tab. |
| `api/booking-report.js` | Flat list of booking events (last 300 days) for the Report tab. Also exports `build()` for the Slack job. |
| `api/slack-notify.js` | Cron target. Posts the day's new bookings to Slack. `?preview=1` renders the message without posting. |
| `api/announcement.js` | Serves the banner text from env vars, so it can be changed without a code edit. |
| `vercel.json` | One cron: `/api/slack-notify` daily at `04:00 UTC` = **08:00 Muscat**. |

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (tick
Production, Preview and Development), then **redeploy** — Vercel only picks up
env-var changes on a new deployment.

### Required

| Variable | Where to get it |
| --- | --- |
| `WETRAVEL_API_KEY` | WeTravel Pro → **Account → Profile → Partner API key**. This is a refresh token; `api/wetravel.js` trades it for access tokens. Without it every endpoint returns `500 {"error":"WETRAVEL_API_KEY is not set"}` and the board is blank. |
| `SLACK_WEBHOOK_URL` | api.slack.com/apps → your app → **Incoming Webhooks** → Add New Webhook to Workspace → pick the living-room channel. Looks like `https://hooks.slack.com/services/T…/B…/…`. |

### Strongly recommended

| Variable | Why |
| --- | --- |
| `CRON_SECRET` | Any long random string. Vercel sends it as `Authorization: Bearer <value>` on cron calls, and `slack-notify` rejects anything else. **If it is unset the check is skipped entirely** and anyone who knows the URL can post to the channel. |
| `DASHBOARD_URL` | The deployment URL used in the Slack message's "Open dashboard" link. Defaults to `https://bookingprogress.vercel.app`; change it if the project's domain changed. |

### Optional — all have working defaults baked into the code

| Variable | Default | Effect |
| --- | --- | --- |
| `WETRAVEL_API_BASE` | `https://api.wetravel.com/v2` | Override only if WeTravel moves the API. |
| `SEASON_END` | `2026-12-31` | Latest departure date shown on the board. |
| `BOOKING_TARGET` | `10` | Seats-per-week target marker on each bar. |
| `WEEKLY_BOOKING_TARGET` | `12` | New bookings/week target in the Report tab (Sun–Sat, Muscat). |
| `EXCLUDED_TRIP_UUIDS` | `8612103268,9638755524,10127626` | Departures hidden from the board. |
| `CANCELLED_TRIP_UUIDS` | *(empty)* | Departures kept on the board but stamped CANCELLED. |
| `CHARTER_TRIP_UUIDS` | `8612103268,9638755524,0885576464` | Counted separately and left out of the Slack total. |
| `REPORT_SKIP_UUIDS` | `10127626,17245052` | Broken/duplicated records dropped from every view. |
| `REPORT_LOOKBACK_DAYS` | `300` | How far back the Report tab scans. |
| `CACHE_TTL_MS` | `60000` | Dashboard cache. |
| `REPORT_CACHE_TTL_MS` | `180000` | Report cache. |
| `ANNOUNCEMENT_TITLE` / `ANNOUNCEMENT_BODY` | *(empty)* | Banner at the top of the dashboard. Empty = "No current announcement". |

## Verifying the setup

After deploying with the env vars in place:

```bash
# 1. WeTravel — should return JSON with a "trips" array, not an error
curl -s https://<your-domain>/api/trips-progress | head -c 400

# 2. Report data — should return "events"
curl -s https://<your-domain>/api/booking-report | head -c 400

# 3. Slack message, rendered but NOT posted
curl -s "https://<your-domain>/api/slack-notify?preview=1"

# 4. Slack for real — only if the preview above looked right.
#    Needs the CRON_SECRET header if you set one.
curl -X POST https://<your-domain>/api/slack-notify \
  -H "Authorization: Bearer $CRON_SECRET"
```

`{"error":"WETRAVEL_API_KEY is not set"}` on step 1 means the variable is
missing **or** was added without redeploying afterwards.

## Notes

- **Cron on Hobby vs Pro** — Vercel's Hobby plan runs cron jobs once a day at an
  approximate time. The single 04:00 UTC job here fits, and `slack-notify`
  tolerates ±30 min of drift when picking its reporting window. Pro runs it on
  the minute.
- **No double-posting** — each run reports exactly the 24h since the previous
  scheduled boundary, so consecutive messages tile the day without overlap.
  There's no stored state; the windows simply never repeat.
- **Timezone** — Oman is UTC+4 year-round. Day and week boundaries are computed
  against Muscat's calendar, not the server's UTC clock.
- **`node_modules/` is committed but unused** — leftover `googleapis` packages
  from an earlier Google Sheets version. Nothing imports them; the functions use
  Node's built-in `fetch`. Safe to delete along with adding a `.gitignore`.
