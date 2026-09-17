#!/usr/bin/env node
// Run the Optimal solve by hand, from your machine, ignoring the weekly cadence gate.
//
//   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Users\Nick\survivor\service-account.json"
//   node functions\solve-now.js            re-solve from live lines now and write odds/2026/optimal
//   node functions\solve-now.js --dry      show what would change, write nothing
//   node functions\solve-now.js --seed     compare against the season-opening seed instead of the last solve, and start
//                                          the change history over (use once, to clean up after a bad solve)
//
// Uses the same optimal.js the Cloud Function uses, so the answer is identical to what a scheduled pass would write.
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const optimal = require("./optimal");
const SEED = require("./optimal-seed.json");

const SEASON = 2026;
const args = new Set(process.argv.slice(2));
initializeApp({ credential: applicationDefault(), databaseURL: "https://survivor-2026-34ce6-default-rtdb.firebaseio.com" });

(async () => {
  const db = getDatabase();
  const games = (await db.ref(`odds/${SEASON}/games`).get()).val() || {};
  const prev = (await db.ref(`odds/${SEASON}/optimal`).get()).val() || {};
  const current = args.has("--seed") ? SEED : { ...SEED, ...(prev.picks || {}) };
  const leg = optimal.currentLeg(games);
  const r = optimal.solve(games, current);
  const now = Date.now(), changes = args.has("--seed") ? {} : { ...(prev.changes || {}) }, moved = [];
  optimal.LEG_IDS.forEach((l) => {
    if (r.picks[l] !== current[l]) { changes[l] = { from: current[l] || null, to: r.picks[l] || null, at: now }; moved.push(`${l}: ${current[l] || "-"} -> ${r.picks[l] || "-"}`); }
  });
  console.log(`games in db: ${Object.keys(games).length}   leg in play: ${leg ? leg.id + (leg.started ? " (started)" : " (not started)") : "none"}`);
  console.log(`fixed legs: ${r.fixed.join(", ") || "none"}   survive-all-20 prob: ${(r.prob * 100).toFixed(3)}%`);
  console.log(moved.length ? `changes vs ${args.has("--seed") ? "seed" : "last solve"}:\n  ${moved.join("\n  ")}` : `no changes vs ${args.has("--seed") ? "seed" : "last solve"}`);
  optimal.LEG_IDS.forEach((l) => console.log(`  ${l.padEnd(5)} ${r.picks[l] || "-"}${r.fixed.includes(l) ? "  (fixed)" : ""}`));
  if (args.has("--dry")) { console.log("dry run, nothing written"); process.exit(0); }
  await db.ref(`odds/${SEASON}/optimal`).set({ picks: r.picks, fixed: r.fixed, prob: r.prob, updated: now, changes, lockedLeg: leg && leg.started ? leg.id : null });
  console.log("written to odds/%d/optimal", SEASON);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
