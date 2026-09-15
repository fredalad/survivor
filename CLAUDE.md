# Survivor Sheets — working notes for Claude sessions

Read this before README.md. README is the operator's manual; this is the context a new session needs so it does not
re-derive decisions. Keep it free of anything that should not sit in a public repo: no keys, no Stripe ids, no
account or billing status, no purchase details. Those live on Nick's machine and in the Firebase/Stripe consoles.

## What the product is

A paid planning tool for the Circa Survivor NFL contest (20 legs, every team once, Thanksgiving and Christmas are
their own legs, a tie is a loss). Users plan a full 20-leg pick path against live DraftKings lines, share it live
with their pool, and submit their real picks at Circa themselves. We take no entries and hold no money.

Live at **https://survivorsheets.com** (Firebase Hosting, project `survivor-2026-34ce6`). Repo
`github.com/fredalad/survivor`, branch **`paid`**. The `main` branch is the old free single-board version and is
what GitHub Pages serves at fredalad.github.io/survivor; Nick and his friends still use that board. Do not merge
`paid` into `main` without being asked, because that would swap the Pages site.

## Vocabulary (this matters, it changed twice)

* **Sheet** = one 20-leg pick plan. The paid unit, $10 one-time for the season. In code it is still a `path`
  (`state.paths`, `boards/{id}/paths`); only user-facing text says "sheet".
* **Board** = the container that holds a user's sheets. Free, created on first purchase, one per user, named
  "My sheets". Users never see the word "board" except in the FAQ.
* **Slot** = a purchased right to one sheet, at `users/{uid}/slots/{pathId}`. The rules refuse to write a path whose
  id is not a slot on the owner's account. Deleting a path frees its slot.
* **Seat** = one extra person, $5 one-time. Seats belong to the owner's **account**, not to a sheet.
* **Pool** = everyone the owner has let in. Anyone in the pool sees and edits **every** sheet the owner has, now or
  later. Data: `users/{uid}/team/{memberUid}`, `users/{uid}/invites/{emailKey}`, `users/{memberUid}/memberOf/{ownerUid}`.
* **Optimal default** = a fixed, read-only reference path solved from the season-opening lines, baked into the page
  from `src/optimal.json`. It is the free preview's content and the marketing funnel. Its picks never change.

## Decisions, in order

1. Monetize at $10 per sheet and $5 per extra seat.
2. Odds refresh every 10 minutes from ESPN's public scoreboard (DraftKings lines, no key, free) via a scheduled Cloud
   Function into `odds/2026`; the page streams it. Season-opening lines stay baked into the page as the fallback.
3. Seats are one-time for the season, not monthly.
4. Only the owner can buy seats and invite.
5. Refunds within 7 days if no picks were made on the sheet (or nobody joined on the seat). Manual:
   `tools/admin.py refund-check`, then refund in Stripe.
6. The free read-only Optimal path is the funnel; every edit attempt in the free preview opens the buy prompt.
7. Owners can add seats or sheets at any time.
8. Same Firebase project for the old free board and the paid product. The legacy board `FcNiUIfqtOT6tBjo` has an
   explicit open-access exception in `database.rules.json` so the GitHub Pages site keeps working. Remove it only
   when Nick retires the old board.
9. Stay on Firebase this season; revisit for 2027 if relational features are needed.
10. Seats grant access to all of the owner's sheets, not to one sheet (reworked from per-board membership).
11. The paid unit is one path, not one board (reworked from "board with unlimited paths" to per-path slots).
12. Call everything a sheet in the UI; skip the home page when a user has only one place to go. The "All sheets"
    chooser appears only if they are also in someone else's pool.
13. Sharing must be obvious: black "Share" button in the header and sheet actions; a 3-step dialog (buy seats,
    invite by email, send your link); a one-time "Playing with a group?" nudge until the owner has shared. One
    invite link (`/?join=<ownerUid>`) both invites new people and lets existing members back in all season.
14. Domain survivorsheets.com (GoDaddy, no email or extras) on Firebase Hosting; bare and www both serve over HTTPS.
    `authDomain` is `survivorsheets.com` so Google sign-in shows the real domain.
15. Support email is set in `app-config.json`. Forwarding from support@survivorsheets.com was deferred.
16. Stripe runs in live mode; no test mode was used.
17. Product name "Survivor Sheets", not "Circa Survivor" (Circa owns that name). Terms say we are not affiliated with
    Circa, the NFL, ESPN or DraftKings and take no wagers.
18. **Once a game has kicked off, its line is frozen** (2026-09-15). `fetchOdds` and `tools/fetch_odds.py --push`
    keep the stored spread/moneylines/total for any game past `pre` and only update status and score, so a decided
    game's win % never moves. **Picks are never locked**: a sheet must stay fully editable so someone who buys in
    mid-season can fill in earlier legs and pool members can record what they actually played. (A per-game pick
    lock was tried and removed the same day.)

## Architecture in one screen

```
public/index.html      built by build.py from src/template.html + games.json + names.json + optimal.json
public/faq.html        built from src/faq.html
public/terms.html      built from src/legal.html
functions/index.js     createCheckout (callable), stripeWebhook (https), invite (callable),
                       fetchOdds (every 10 min), refreshOdds (https, key-guarded; effectively disabled, see below)
database.rules.json    odds public-read; boards readable/writable by owner + owner's team; paths need a slot;
                       users/{uid} readable by self; slots readable by self + team; server-only writes for
                       slots, seats, invites-create, purchases; legacy board FcNiUIfqtOT6tBjo fully open
tools/fetch_odds.py    same ESPN mapping as the function; refreshes src/games.json; --push writes odds/2026
tools/admin.py         claim-board, grant-paths, add-seats, refund-check, list-boards (service-account key)
```

Page modes: `demo` (signed out, free preview) → `home` (only when >1 destination) → `board` → `gate`
(invited / not shared). Routing is in `route()` near the bottom of `src/template.html`.

Database shape: `users/{uid}/{email,boards,slots,seats,team,invites,memberOf}`, `boards/{id}/{meta,paths}`,
`odds/2026/{meta,games}` (game key `{week}_{AWAY}_{HOME}` with ESPN abbreviations), `purchases/{stripeSessionId}`.
Email keys replace `.` with `,`.

## How odds and results reach the board

The page's W/L markers and win percentages come **only** from the live doc at `odds/2026/games/...`; the baked
`src/games.json` carries lines but no results. `fetchOdds` runs every 10 minutes: last, current and next week each
run (so a week that just ended keeps getting its finals), all 18 weeks once an hour. Weeks are fetched one at a
time with a pause; a week ESPN refuses is skipped and listed in `odds/2026/meta.failed` rather than aborting the
run. `currentWeek()` comes from ESPN's default scoreboard.

ESPN sits behind a bot filter whose rules change. At launch it accepted Node's bare user-agent and refused
browser-like ones. From Sunday night 2026-09-13 (first logged failure 05:33Z Sep 14) until Tuesday afternoon
Sep 15 it answered every request from the function with HTTP 403 while still answering `Python-urllib` from a
home IP; that is why Week 1's Sunday-night and Monday finals were missing while the afternoon games had theirs.
The block lifted on its own: the first run of the fallback code (Sep 15 ~18:00Z) succeeded with the plain request
and no fallback has been used since. `scoreboard()` in `functions/index.js` nevertheless tries, in order: plain
request, `Python-urllib` UA, full browser headers, and the `cdn.espn.com` copy of the scoreboard, remembers what
worked, and logs `espn: switching to "..."` when it changes — grep the function log for `switching` to see
whether the fallbacks are ever in use. If all four are refused from Google Cloud, the fetcher has to run
somewhere else (plan: GitHub Actions cron running `tools/fetch_odds.py --push` with the service-account key as a
repo secret). Silent failure is the thing to watch for: a run that fails still logs an error, but nobody reads
the log — checking `odds/2026/meta.updated` is the quick health check.

Manual backfill from Nick's machine (proven to work):
`$env:GOOGLE_APPLICATION_CREDENTIALS="C:\Users\Nick\survivor\service-account.json"; python tools\fetch_odds.py --push --no-bake`.

`refreshOdds` is a manual-trigger URL guarded by `ODDS_REFRESH_KEY`. No key was ever set, so it returns 403 to
everyone; that is a safe state and it is not needed.

## Things that bit us

* ESPN returns 403 to custom or browser-like User-Agent strings from some networks, and to Node's default from
  others. See above; do not assume any one request style keeps working.
* `firebase-admin` v14 has no `admin.database()`; use `getDatabase()` from `firebase-admin/database` and pass
  `databaseURL` to `initializeApp`.
* Node 20 runtime is decommissioned 2026-10-30; functions run on `nodejs22`.
* A Cloud Functions param and a Secret Manager secret cannot share a name. `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` are secrets only; never put them in `functions/.env`.
* Functions deploy sometimes times out during code discovery; set `FUNCTIONS_DISCOVERY_TIMEOUT=120` first.
* The Firebase CLI skips functions whose source hash matches the last upload ("Skipped (No changes detected)"). If
  a function is genuinely stale, `firebase experiments:disable skipdeployingnoopfunctions` then deploy again.
* RTDB rules have no `numChildren()`; seat counting is done in the `invite` function, not in rules.
* Chrome keeps a "Not secure" flag for the whole browser session after a certificate warning; restart the browser.
* The Firebase custom-domain wizard's redirect checkbox is easy to get backwards. Both hosts are served sites.

## What is NOT in the repo (on purpose)

* `functions/.env` — Stripe price ids, `APP_URL`, `ODDS_REFRESH_KEY`. Recreate from `functions/.env.example`.
* Stripe secret key and webhook signing secret — Google Secret Manager.
* Firebase CLI login and `service-account.json` (gitignored) — Nick's machine only.
* **A cloud Claude session can edit, build and push but cannot deploy** and cannot reach ESPN or the database
  (its egress proxy blocks both). Deploys run from Nick's Windows machine in PowerShell:

  ```powershell
  git checkout paid; git pull --ff-only origin <claude-branch>; git push origin paid
  $env:FUNCTIONS_DISCOVERY_TIMEOUT = "120"
  firebase deploy --only functions,hosting
  firebase functions:log --only fetchOdds
  ```

  `public/` is committed, so a deploy does not need `python build.py` unless `src/` changed without a rebuild.

## Open items

1. `fetchOdds` is healthy again as of 2026-09-15 (writes every 10 minutes, `failed: {}`). If it goes dark again
   and all four request styles 403, move the fetcher to GitHub Actions. Consider an alert on a stale
   `odds/2026/meta.updated` so the next outage is noticed before Sunday.
2. Stripe account and product setup — status and naming are tracked in the Stripe dashboard, not here.
3. End-to-end seat test: buy a seat, invite a second Google account, join via the link, confirm it sees the
   sheets, then refund.
4. Sign-in email still comes from the default Firebase sender and lands in spam. Fix: Authentication → Templates →
   customize sender domain, plus DNS at GoDaddy. Google sign-in is the workaround, listed first in the FAQ.
5. Optimal path is static. Idea: re-solve nightly from live lines and show "changed since yesterday" — past legs
   must stay fixed.
6. Old GitHub Pages board keeps working without live odds. Migrate with `tools/admin.py claim-board --board
   FcNiUIfqtOT6tBjo --email <owner>` when Nick wants, then remove the rules exception.

## Style notes for UI work

Fonts: Barlow Condensed for display, IBM Plex Sans body, IBM Plex Mono for numbers. Gold accent `#B98A12`.
Light and dark themes via CSS variables at the top of `src/template.html`. All UI copy says "sheet", never "path"
or "board". Share buttons are `.btn.primary.share`. New pages are built by `build.py` and use the same
`__APP_NAME__` / `__SUPPORT_EMAIL__` / `__PRICE_*__` placeholders as `src/faq.html`. Rebuild and commit `public/`
after changing anything in `src/`.
