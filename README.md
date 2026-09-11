# Survivor Sheet (2026)

Paid pick planner for the Circa Survivor contest. One static page (`public/index.html`) backed by Firebase
(Auth + Realtime Database + Cloud Functions + Hosting) and Stripe Checkout.

* **Path** = one full 20-leg pick plan, $10 one-time for the season. The board that holds them is free and created on first purchase; each path occupies a purchased slot on the owner's account.
* **Seat** = one more person in your pool, $5 one-time. Everyone in the pool sees every sheet the owner has, now or later. Owners invite by email; only invited addresses can join.
* **Free preview** = the fixed Optimal path, read-only, with live lines. Every edit prompts to buy.
* **Lines** = DraftKings lines from ESPN's public scoreboard, refreshed every 10 minutes by a scheduled
  function into `odds/2026`; the page streams them and flashes cells whose win % moved. Finished games show W/L.

## Layout

| Path | What |
|---|---|
| `src/template.html` | the whole app (CSS + HTML + JS) with `__PLACEHOLDERS__` |
| `src/games.json` | fallback schedule + lines baked into the page (refresh with `tools/fetch_odds.py`) |
| `src/optimal.json`, `src/names.json` | the fixed Optimal path and team names |
| `src/legal.html` | terms / refunds / privacy, rendered to `public/terms.html` |
| `app-config.json` | product name, tagline, prices, support email |
| `build.py` | renders `public/` |
| `database.rules.json` | who can read/write what (members-only boards, owner-only invites, public odds) |
| `functions/` | `createCheckout`, `stripeWebhook`, `fetchOdds` (every 10 min), `refreshOdds` (manual) |
| `tools/fetch_odds.py` | ESPN fetcher: bakes `src/games.json`, can also push live odds with a service account |
| `tools/admin.py` | claim the pre-paywall board, comp sheets/seats, refund checks |
| `board-id.txt` | id of the original shared board (`FcNiUIfqtOT6tBjo`), kept for the migration below |

Database shape: `users/{uid}/{email,boards,slots,seats,team,invites,memberOf}`, `boards/{id}/{meta,paths}`, `odds/2026/{meta,games}`,
`purchases/{stripeSessionId}`. A board is readable by its owner and by anyone in the owner's `team`. Invite keys are the
invitee's email with `.` replaced by `,`; the invite link is `/?join=<ownerUid>`.

## Build

```
python tools/fetch_odds.py     # optional: refresh the baked fallback lines
python build.py                # writes public/index.html and public/terms.html
python -m http.server 8765 --directory public   # local preview (free-preview mode works without deploying)
```

## One-time setup (in order)

1. **Node 22 LTS** (the functions run on the nodejs22 runtime), then `npm i -g firebase-tools` and `cd functions && npm install`.
2. `firebase login` (project is already set in `.firebaserc`). The project must be on the **Blaze** plan for
   Cloud Functions and the scheduler.
3. Firebase console → Authentication → Sign-in method: enable **Email link (passwordless)** and **Google**.
   Under Authorized domains add your custom domain (localhost and `*.web.app` are there by default).
4. Stripe → Products: create **Path** ($10 one-time, one pick sheet) and **Seat** ($5 one-time). Copy the two `price_...` ids
   into `functions/.env` (see `functions/.env.example`), with `APP_URL` = your hosting URL and a random
   `ODDS_REFRESH_KEY`.
5. Secrets: `firebase functions:secrets:set STRIPE_SECRET_KEY` (sk_test_... first, sk_live_... at launch).
6. Deploy rules + functions + hosting: `python build.py && firebase deploy`.
7. Stripe → Developers → Webhooks → add endpoint
   `https://us-central1-survivor-2026-34ce6.cloudfunctions.net/stripeWebhook`, event
   `checkout.session.completed`. Copy its signing secret: `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`,
   then `firebase deploy --only functions` again.
8. Prime the odds once: open `https://us-central1-survivor-2026-34ce6.cloudfunctions.net/refreshOdds?key=...`
   (or `python tools/fetch_odds.py --push` with a service-account key). The schedule keeps it fresh from then on.
9. Migrate the original board: sign in once on the new site, then
   `python tools/admin.py claim-board --board FcNiUIfqtOT6tBjo --email you@example.com --name "My sheet"`.
   Until then the old GitHub Pages copy keeps working only in local-only mode, because the new rules block it.
10. Test-mode purchase end to end (card 4242 4242 4242 4242), then switch the Stripe key and prices to live.

## Ops

* Redeploy the page: `python build.py && firebase deploy --only hosting`.
* Comp a friend: `python tools/admin.py grant-paths --email friend@example.com --n 2 --seats 1`.
* Refund request: `python tools/admin.py refund-check --board ID` (7 days, no picks), then refund in Stripe.
* Logs: `firebase functions:log`. Local emulators: `firebase emulators:start`, then open the page with `?emu`.
