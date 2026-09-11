// Cloud Functions for the paid survivor sheet.
//   createCheckout  (callable)  - starts a Stripe Checkout for paths ($10 each) or for pool seats ($5 each)
//   stripeWebhook   (https)     - fulfils paid checkouts: adds path slots (and the board on first purchase) / adds seats
//   invite          (callable)  - owner invites an email to their pool; the server enforces the seat count
//   fetchOdds       (schedule)  - every 10 minutes, DraftKings lines + scores from ESPN -> odds/2026
//   refreshOdds     (https)     - manual odds refresh, guarded by ODDS_REFRESH_KEY
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const crypto = require("crypto");
const Stripe = require("stripe");

initializeApp({ databaseURL: "https://survivor-2026-34ce6-default-rtdb.firebaseio.com" });
setGlobalOptions({ region: "us-central1", maxInstances: 5 });

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const STRIPE_PRICE_SHEET = defineString("STRIPE_PRICE_SHEET");
const STRIPE_PRICE_SEATS = defineString("STRIPE_PRICE_SEATS");
const APP_URL = defineString("APP_URL", { default: "https://survivor-2026-34ce6.web.app" });
const ODDS_REFRESH_KEY = defineString("ODDS_REFRESH_KEY", { default: "" });

const SEASON = 2026;
// ESPN returns 403 for custom or browser-like user-agents; Node's default fetch UA is accepted, so send none.
const db = () => getDatabase();

// ---------------------------------------------------------------- payments
exports.createCheckout = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const { kind } = req.data || {};
  const boardId = (req.data && req.data.boardId) || null;
  const qty = Math.max(1, Math.min(20, parseInt(req.data && req.data.qty, 10) || 1));
  const uid = req.auth.uid;
  const email = req.auth.token.email || undefined;
  const metadata = { uid, kind, qty: String(qty) };
  let price;

  if (kind === "path" || kind === "sheet") {
    price = STRIPE_PRICE_SHEET.value(); // one path = one 20-leg pick sheet
  } else if (kind === "seats") {
    price = STRIPE_PRICE_SEATS.value(); // seats belong to the buyer's pool, not to one sheet
  } else {
    throw new HttpsError("invalid-argument", "Unknown purchase.");
  }
  if (!price) throw new HttpsError("failed-precondition", "Stripe prices are not configured yet.");

  const stripe = new Stripe(STRIPE_SECRET_KEY.value());
  const base = APP_URL.value().replace(/\/$/, "");
  const back = boardId ? `&b=${encodeURIComponent(boardId)}` : "";
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price, quantity: qty }],
    customer_email: email,
    client_reference_id: uid,
    metadata,
    allow_promotion_codes: true,
    success_url: `${base}/?paid=${kind === "sheet" ? "path" : kind}${back}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/?canceled=1${back}`,
  });
  return { url: session.url };
});

exports.stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  const stripe = new Stripe(STRIPE_SECRET_KEY.value());
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET.value());
  } catch (err) {
    console.error("webhook signature failed", err.message);
    res.status(400).send("bad signature");
    return;
  }
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const s = event.data.object;
      if (s.payment_status === "paid") await fulfil(s);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("fulfilment failed", err);
    res.status(500).send("fulfilment failed"); // Stripe retries on 5xx
  }
});

function newBoardId() {
  return crypto.randomBytes(9).toString("base64url"); // 12 chars, all legal in a database key
}

async function fulfil(s) {
  const ref = db().ref(`purchases/${s.id}`);
  if ((await ref.get()).exists()) return; // Stripe may deliver the same event twice
  const meta = s.metadata || {};
  const uid = meta.uid, kind = meta.kind, boardId = meta.boardId || null;
  const qty = parseInt(meta.qty, 10) || 1;
  const email = (s.customer_details && s.customer_details.email) || s.customer_email || null;
  const now = Date.now();
  const created = [];

  if ((kind === "path" || kind === "sheet") && uid) {
    // The board is free and made once; each purchase adds path slots to the buyer's account.
    let boardId = Object.keys((await db().ref(`users/${uid}/boards`).get()).val() || {})[0] || null;
    if (!boardId) {
      boardId = newBoardId();
      await db().ref().update({
        [`boards/${boardId}/meta`]: { name: "My sheets", owner: uid, ownerEmail: email, created: now },
        [`users/${uid}/boards/${boardId}`]: true,
        [`users/${uid}/email`]: email,
      });
      created.push(boardId);
    }
    const slotWrites = {};
    for (let i = 0; i < qty; i++) slotWrites[`users/${uid}/slots/p${crypto.randomBytes(4).toString("hex")}`] = { at: now, purchase: s.id };
    await db().ref().update(slotWrites);
  } else if (kind === "seats" && uid) {
    await db().ref(`users/${uid}/seats`).transaction((v) => (v || 0) + qty);
  } else {
    console.error("unknown purchase", s.id, meta);
  }
  await ref.set({ uid, kind, boardId, boards: created, qty, amount: s.amount_total, currency: s.currency, email, at: now });
}

// ---------------------------------------------------------------- invites (server-side so the seat count is enforced)
const emailKey = (e) => String(e || "").trim().toLowerCase().replace(/\./g, ",");
exports.invite = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const email = String((req.data && req.data.email) || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[#$\[\]\/]/.test(email)) throw new HttpsError("invalid-argument", "Enter a valid email address.");
  if (email === (req.auth.token.email || "").toLowerCase()) throw new HttpsError("invalid-argument", "That's your own address.");
  const u = (await db().ref(`users/${uid}`).get()).val() || {};
  const team = u.team || {}, invites = u.invites || {};
  if (Object.values(team).some((m) => (m.email || "").toLowerCase() === email)) throw new HttpsError("already-exists", `${email} is already in your pool.`);
  const key = emailKey(email);
  if (invites[key]) throw new HttpsError("already-exists", `${email} is already invited.`);
  const used = Object.keys(team).length + Object.keys(invites).length;
  const seats = u.seats || 0;
  if (used >= seats) throw new HttpsError("resource-exhausted", "No seats left. Buy a seat first.");
  await db().ref(`users/${uid}/invites/${key}`).set({ email, at: Date.now(), ownerEmail: req.auth.token.email || null });
  return { ok: true, left: seats - used - 1 };
});

// ---------------------------------------------------------------- odds
const ESPN = (w) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${w}&seasontype=2&dates=${SEASON}`;
const ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "numeric", minute: "2-digit", hour12: true,
});

function eastern(iso) {
  const p = {};
  ET.formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, day: p.weekday, time: `${p.hour}:${p.minute} ${p.dayPeriod}` };
}
function moneyline(s) {
  if (s == null) return null;
  s = String(s).trim().toUpperCase();
  if (s === "EVEN" || s === "PK" || s === "+100") return 100;
  const n = parseInt(s.replace("+", ""), 10);
  return Number.isFinite(n) ? n : null;
}
function parseEvent(e, w) {
  const c = e.competitions[0];
  const side = {};
  c.competitors.forEach((x) => { side[x.homeAway] = x; });
  const away = side.away.team.abbreviation, home = side.home.team.abbreviation;
  const t = eastern(e.date);
  if (c.timeValid === false) t.time = "TBD";
  const o = (c.odds && c.odds[0]) || {};
  let spread = o.spread == null ? null : Number(o.spread);
  const ps = o.pointSpread && o.pointSpread.home && o.pointSpread.home.close && o.pointSpread.home.close.line;
  if (ps != null && ps !== "" && Number.isFinite(Number(ps))) spread = Number(ps);
  const ml = o.moneyline || {};
  const st = c.status.type || {};
  return {
    w, date: t.date, day: t.day, time: t.time, away, home, spread,
    mlAway: moneyline(ml.away && ml.away.close && ml.away.close.odds),
    mlHome: moneyline(ml.home && ml.home.close && ml.home.close.odds),
    ou: o.overUnder == null ? null : Number(o.overUnder),
    neutral: c.neutralSite ? 1 : 0,
    status: st.state || "pre", done: !!st.completed,
    as: parseInt(side.away.score, 10) || 0, hs: parseInt(side.home.score, 10) || 0,
    book: (o.provider && o.provider.name) || null,
  };
}
async function fetchWeek(w) {
  const r = await fetch(ESPN(w));
  if (!r.ok) throw new Error(`ESPN week ${w}: HTTP ${r.status}`);
  const d = await r.json();
  return (d.events || []).map((e) => parseEvent(e, w));
}
async function currentWeek() {
  try {
    const d = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard").then((r) => r.json());
    return (d.week && d.week.number) || 1;
  } catch (e) { return 1; }
}

// Current and next week every run; the whole season once an hour (lines on far-off weeks barely move).
async function refreshOdds(all) {
  const cur = await currentWeek();
  const weeks = all ? Array.from({ length: 18 }, (_, i) => i + 1) : [...new Set([cur, Math.min(18, cur + 1)])];
  const updates = {};
  let n = 0;
  for (const w of weeks) {
    (await fetchWeek(w)).forEach((g) => { updates[`games/${g.w}_${g.away}_${g.home}`] = g; n++; });
  }
  updates.meta = { updated: Date.now(), source: "DraftKings via ESPN", season: SEASON, weeks, currentWeek: cur };
  await db().ref(`odds/${SEASON}`).update(updates);
  return { weeks, games: n, currentWeek: cur };
}

exports.fetchOdds = onSchedule({ schedule: "every 10 minutes", timeZone: "America/New_York", timeoutSeconds: 120 }, async () => {
  const r = await refreshOdds(new Date().getMinutes() < 10);
  console.log("odds refreshed", JSON.stringify(r));
});

exports.refreshOdds = onRequest(async (req, res) => {
  const key = ODDS_REFRESH_KEY.value();
  if (!key || req.query.key !== key) { res.status(403).send("forbidden"); return; }
  try { res.json(await refreshOdds(true)); } catch (err) { res.status(500).send(String(err)); }
});
