# Leads & engagement plan

The roadmap for getting lead counts (WhatsApp and Instagram DM), qualified
leads, and Instagram engagement/impression stats onto the NomuHub CRM
dashboard. Kept in the repo so any session, on any Claude account, knows
where this stands. **Update the "Status" section whenever something moves.**

## What Muatasam asked for

Slack, 28 Sep 2026:

- "Work with Anthony to make sure all weekly leads are available in dashboard
  easy to view"
- "Visualisation of daily leads are poor. We need it to be available all time"
- "I need to be able to see weekly leads for all this year whatever available
  in sheet"
- "Also I need to see daily leads for every existing week. As in daily leads
  for this week then daily leads for next week when we pass toward following
  week"
- "Daily leads important indicator that we should be focused more in"
- Wanted it done the same day. His first choice was a Cowork HTML page; the
  fallback he named was a new tab on the booking-progress dashboard. Anton
  chose the new tab.

Earlier (same month), in a thread with Marina: "We need to get daily
reporting for numbers... Weekly are very long and we cant act quickly." He
wants to see how the campaigns are working and what to do next.

## Who does what today

- **Marina** counts leads by hand. WhatsApp leads are counted by applying
  labels manually inside WhatsApp; Instagram DMs are counted by hand too.
  She records them in an Excel workbook on OneDrive, **"Leads Feedback &
  Report"**, with tabs `Q1 leads`, `Q1 Report`, `Q2 leads`, `Q2 Report`,
  `July Report`, `Q3 Report`, `Task`.
- The Report tabs break leads down by week and by project, using the same
  destination|programme codes as the rest of the dashboard (`ZNZ|BL`,
  `ZNZ|TA`, `ZNZ|MED`, `ZNZ|EX`, `SA|EX`, `BA|TA`, `BA|EX`, `BA|WL`,
  `VN|EX`, `TH|WL`, `SL`), grouped under Africa and Asia. Each week has three
  rows: `Total No|IG`, `Total No|WA`, and `IG+WA`.
- **Maryam** presents weekly engagement statistics. We haven't seen the
  contents of that report yet.

## Phase 1 — Marina's sheet as the database (now)

Marina keeps updating her workbook exactly as she does today. The dashboard
reads it and draws it. Nothing changes for her.

- New **Leads** tab on the CRM, reading the workbook live (no copy-paste,
  no re-export).
- Shows weekly leads for the whole year, split by Instagram vs WhatsApp and
  by project, plus daily leads for the current week (rolling forward as each
  new week starts), since that's the number Muatasam called the priority.
- Limitation: it can only be as current, and as accurate, as the sheet. It
  isn't automatic counting yet; it's automatic *reporting* of a manual count.

## Phase 2 — automatic counting (later)

Replace the manual count with counts pulled straight from the platforms.
Only counts and metadata are captured, never message content (Anton's
explicit requirement).

- **What gets counted:** new conversations per channel (WhatsApp vs
  Instagram DM), per day, deduplicated per contact.
- **Attribution:** a conversation that starts from a Click-to-WhatsApp or
  Click-to-Instagram ad carries a `referral` object naming the ad, so it can
  be tagged to a campaign automatically. Organic messages have no ad to
  attribute to.
- **Qualified leads:** "qualified" means genuinely interested, not someone
  who asked one question and left. No API can tell that, and we're not
  reading message content, so it can't be inferred. Agreed approach: an
  automatic pre-filter surfaces conversations where the contact replied 2+
  times, then whoever is talking to the lead marks it qualified or not with
  one tap.
- **Two possible routes:**
  1. **ManyChat first.** The WhatsApp account is billed through ManyChat,
     which already handles WhatsApp and can handle Instagram DMs. If its
     reporting or API already exposes counts by channel, that's far less to
     build. **Check this before building anything else.**
  2. **Build it ourselves** with Meta webhooks (WhatsApp Cloud API +
     Instagram Messaging API), which needs a small database this project
     doesn't have yet.

## Instagram engagement / impression stats (Maryam's weekly report)

Two very different things depending on what the report actually contains:

- **Ad engagement** (likes, comments, shares, video views, link clicks on
  paid posts): possible **now** with the Marketing API access this dashboard
  already uses in `api/meta-ads.js`. Just more fields on a request that
  already works.
- **Organic account engagement** (posts that aren't ads, stories, profile
  visits, follower growth, organic reach and impressions): needs
  `instagram_basic` / `instagram_manage_insights`, and the Instagram account
  connected to Business Manager, which it currently isn't.

Need a screenshot of Maryam's report to know which.

## Access audit (via Cowork, 28 Sep 2026)

- Anton (`deverajranthony@gmail.com`) has **full Admin** on NomuHub's
  Business Manager. So does "NomuHub Main" (`volunteer@nomuhub.com`). Abin
  Reji and Mo Mohyy have partial access.
- **Business verification: unverified, not started.** This is the main
  blocker for Instagram messaging access and higher WhatsApp tiers.
- **WhatsApp:** already a proper WhatsApp Business Account connected to
  Business Manager, named "Nomuhub" (ID `556059437528335`), status Approved,
  one number `+966 53 291 9603`, billed via a ManyChat credit line. The
  WhatsApp account itself also shows unverified.
- **Meta app:** "NomuHub Ads Dashboard" (App ID `1981072809269122`), in
  development, Anton is Administrator. Only use case: "Create & manage ads
  with Marketing API". Permissions: `ads_management`, `ads_read`,
  `business_management`, `pages_read_engagement`, `pages_show_list`,
  `public_profile`. Marketing API access tier: Limited. **No WhatsApp or
  Instagram messaging permissions.** The "Connect with customers through
  WhatsApp" use case is available but has never been added.
- **Instagram: not connected.** No Instagram account in Business Settings;
  Business Suite shows a "Connect Instagram" prompt.

## Status

- [x] Access audit done (above)
- [x] Phase 1 Leads tab: building now, reading Marina's sheet
- [ ] ManyChat check: Cowork prompt sent, waiting on results
- [ ] Screenshot of Maryam's engagement report, to decide ad vs organic
- [ ] Start Meta Business verification (Business Settings > Security Center)
- [ ] Connect the Instagram account (Professional) to the Facebook Page and
      Business Manager
- [ ] Phase 2 decisions: ManyChat vs own webhooks; budget for any paid tier
