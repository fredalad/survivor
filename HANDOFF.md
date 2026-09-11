# Survivor Sheets — project handoff

Written 2026-09-11 at the end of the initial paid build. This is the context a new session needs to keep working
on the product without re-deriving decisions. Read this before README.md; the README is the operator's manual.

## What the product is

A paid planning tool for the Circa Survivor NFL contest (20 legs, every team once, Thanksgiving and Christmas are
their own legs, a tie is a loss). Users plan a full 20-leg pick path against live DraftKings lines, share it live
with their pool, and submit their real picks at Circa themselves. We take no entries and hold no money.

Live at **https://survivorsheets.com** (Firebase Hosting, project `survivor-2026-34ce6`). Repo
`github.com/fredalad/survivor`, branch **`paid`**. The `main` branch is the old free single-board version and is
what GitHub Pages serves at fredalad.github.io/survivor; Nick and his friends still use that board. Do not merge
`paid` into `main` without being asked, because that would swap the Pages site.

## Vocabulary (this matters, it changed twice)

* **Sheet** = one 20-leg pick plan. The paid unit. $10 one-time for the season. In code it is still called a
  `path` (`state.paths`, `boards/{id}/paths`); only the user-facing text says "sheet".
* **Board** = the container that holds a user's sheets. Free, created on their first purchase, one per user,
  named "My sheets". Users never see the word "board" except in the FAQ.
* **Slot** = a purchased right to one sheet. Lives at `users/{uid}/slots/{pathId}`. The rules refuse to write a
  path whose id is not a slot on the owner's account. Deleting a path frees its slot for reuse.
* **Seat** = one extra person, $5 one-time. Seats belong to the owner's **account**, not to a sheet.
* **Pool** = everyone the owner has let in. Anyone in the pool sees and edits **every** sheet the owner has, now
  or later. Data: `users/{uid}/team/{memberUid}`, `users/{uid}/invites/{emailKey}`, `users/{memberUid}/memberOf/{ownerUid}`.
* **Optimal default** = a fixed, read-only reference path solved from the season-opening lines, baked into the
  page from `src/optimal.json`. It is the free preview's content and the marketing funnel.

## Decisions Nick made, in order

1. **Monetize at $10 per pick sheet and $5 per extra login** (2026-09-09).
2. **Odds refresh every 10 minutes.** Source is ESPN's public scoreboard endpoint, which carries DraftKings
   spreads, totals and moneylines for all 18 weeks, needs no key, and is free. Chosen over a paid odds API. A
   scheduled Cloud Function writes to `odds/2026`; the page streams it. Season-opening lines stay baked into the
   page as the fallback and for weeks the book hasn't priced.
3. **Seats are one-time for the 2026 season, not monthly.**
4. **Only the owner can buy seats and invite.**
5. **Refunds within 7 days if no picks were made** on the sheet (or nobody joined on the seat). Manual: use
   `tools/admin.py refund-check`, then refund in the Stripe dashboard.
6. **Free read-only Optimal path is the funnel.** Every edit attempt in the free preview opens the buy prompt.
7. **Owners can add seats or sheets at any time.**
8. **Keep the same Firebase project** for the old free board and the new paid product. The legacy board
   `FcNiUIfqtOT6tBjo` has an explicit open-access exception in `database.rules.json` so the GitHub Pages site
   keeps working unchanged. Remove that exception only when Nick retires the old board.
9. **Stay on Firebase** (not Supabase etc.) for this season; revisit for 2027 if relational features are needed.
10. **Seats grant access to all of the owner's sheets** (2026-09-10), not to one sheet. Reworked from
    per-board membership to account-level pools.
11. **The paid unit is one path, not one board** (2026-09-10). Reworked from "board with unlimited paths" to
    per-path slots.
12. **Call everything a sheet** in the UI; drop the board name from the interface; skip the home page when a
    user only has one place to go (their own sheets). "All sheets" chooser appears only if they are also in
    someone else's pool.
13. **Sharing must be obvious.** Prominent black "Share" button in the header and sheet actions; a 3-step
    dialog (buy seats, invite by email, send your link); a one-time "Playing with a group?" nudge on the board
    until the owner has shared with someone. One invite link (`/?join=<ownerUid>`) both invites new people and
    lets existing pool members back in all season.
14. **Domain survivorsheets.com** bought at GoDaddy. No GoDaddy email or extras. Connected to Firebase Hosting;
    both bare and www serve the site over HTTPS. `authDomain` in `firebase-config.json` is `survivorsheets.com`
    so Google sign-in shows the real domain. Redirect URI for the custom domain was added to the auto-created
    OAuth client in Google Cloud.
15. **Support email is Nick's Gmail** (`nick.manfreda885@gmail.com`) for launch, set in `app-config.json`.
    Forwarding from support@survivorsheets.com was deferred (GoDaddy doesn't include it; ImprovMX or Cloudflare
    later).
16. **Stripe is in live mode.** No test mode was used; the first real purchase ($10.64 with tax) succeeded and
    created Nick's board `a2fF5MdgshhJ`. His four pre-existing paths were granted slots by hand.
17. **Product name "Survivor Sheets"**, not "Circa Survivor" (Circa owns that name). Terms page says it is not
    affiliated with Circa, the NFL, ESPN or DraftKings, and that no wagers are taken. Stripe business category is
    "Software as a service".

## Architecture in one screen

```
public/index.html      built by build.py from src/template.html + games.json + names.json + optimal.json
public/faq.html        built from src/faq.html
public/terms.html      built from src/legal.html
functions/index.js     createCheckout (callable), stripeWebhook (https), invite (callable),
                       fetchOdds (every 10 min), refreshOdds (https, key-guarded)
database.rules.json    odds public-read; boards readable/writable by owner + owner's team; paths need a slot;
                       users/{uid} readable by self; slots readable by self + team; server-only writes for
                       slots, seats, invites-create, purchases; legacy board FcNiUIfqtOT6tBjo fully open
tools/fetch_odds.py    same ESPN mapping as the function; refreshes src/games.json (the baked fallback)
tools/admin.py         claim-board, grant-paths, add-seats, refund-check, list-boards (needs a service-account key)
```

Page modes: `demo` (signed out, free preview) → `home` (only when >1 destination) → `board` → `gate`
(invited / not shared). Routing is in `route()` near the bottom of `src/template.html`.

Database shape: `users/{uid}/{email,boards,slots,seats,team,invites,memberOf}`, `boards/{id}/{meta,paths}`,
`odds/2026/{meta,games}`, `purchases/{stripeSessionId}`. Email keys replace `.` with `,`.

## Things that bit us (so you don't repeat them)

* ESPN returns 403 to custom or browser-like User-Agent strings. Send none (Node/Python defaults work).
* `firebase-admin` v14 has no `admin.database()`; use `getDatabase()` from `firebase-admin/database` and pass
  `databaseURL` to `initializeApp` because it can't be inferred in the function runtime.
* Node 20 runtime is decommissioned 2026-10-30; functions run on `nodejs22`.
* A Cloud Functions param and a Secret Manager secret cannot share a name. `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` are secrets only; never put them in `functions/.env`.
* Functions deploy sometimes times out during code discovery on this machine; set
  `FUNCTIONS_DISCOVERY_TIMEOUT=120` in the environment before `firebase deploy`.
* RTDB rules have no `numChildren()`; seat counting is done in the `invite` function, not in rules.
* Chrome keeps a "Not secure" flag on a site after you click through a certificate warning, for the whole browser
  session, even once the real certificate lands. Restart the browser.
* The Firebase custom-domain wizard's redirect checkbox is easy to get backwards. Both hosts are now added as
  served sites.

## What is NOT in the repo (on purpose)

* `functions/.env` — `STRIPE_PRICE_SHEET=price_1UDrg66lRmALL9krAnsdzFkz`, `STRIPE_PRICE_SEATS=price_1UDrgQ6lRmALL9krhX9RKyz2`,
  `APP_URL=https://survivorsheets.com`, `ODDS_REFRESH_KEY=<random>`. Recreate from `.env.example` if lost.
* Stripe secret key and webhook signing secret — in Google Secret Manager for the project.
* Firebase CLI login and the service-account key for `tools/admin.py` — on Nick's machine only. A cloud session
  can edit and push but **cannot deploy**; deploys run from Nick's machine (`python build.py` then
  `firebase deploy`), unless a GitHub Actions deploy token is set up later.

## Open items as of handoff

1. **Stripe dashboard shows "1 required task is past due" and capabilities paused.** Nick needs to finish
   activation (identity / bank / website field). Purchases worked once already, so it may be a soft block.
2. **Rename the $10 Stripe product** from "Survivor Sheets · 2026 season" to "Sheet" so checkout matches the UI.
3. **End-to-end seat test not yet done:** buy a seat, invite a second Google account, join via the link, confirm
   the second account sees the sheets, then refund.
4. **Sign-in email still comes from `noreply@survivor-2026-34ce6.firebaseapp.com`** and lands in spam. Fix is
   Authentication → Templates → customize sender domain, plus DNS records at GoDaddy. Google sign-in is the
   workaround and is listed first in the FAQ's advice.
5. **Optimal path is static.** Idea on the table: re-solve nightly from live lines and show "changed since
   yesterday", not every 10 minutes.
6. **Nick's Chicago tax question**: Stripe showed Chicago lease tax on cloud software. Not enabled. Revisit only
   if volume becomes meaningful.
7. **Old GitHub Pages board** keeps working but has no live odds. Migrate with
   `tools/admin.py claim-board --board FcNiUIfqtOT6tBjo --email nick.manfreda885@gmail.com` when Nick wants,
   then remove the rules exception.

## Style notes for UI work

Fonts: Barlow Condensed for display, IBM Plex Sans body, IBM Plex Mono for numbers. Gold accent `#B98A12`.
Light and dark themes via CSS variables at the top of `src/template.html`. All UI copy says "sheet", never
"path" or "board". Share buttons are `.btn.primary.share`. New pages get built by `build.py` and use the same
`__APP_NAME__` / `__SUPPORT_EMAIL__` / `__PRICE_*__` placeholders as `src/faq.html`.
