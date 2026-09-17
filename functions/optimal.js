// Re-solve the Optimal reference path from live lines.
//
// A path is one distinct team per leg. "Optimal" = the assignment that maximizes the product of de-vigged win
// probabilities, solved exactly (Hungarian algorithm on -log p). Legs whose current pick has already kicked off are
// held as they are and that team is consumed; in open legs only teams whose game is still "pre" are candidates.
// Leg ids and the Thanksgiving/Christmas split mirror src/template.html.
const SEASON = 2026;
const isTG = (g) => g.w === 12 && g.date <= `${SEASON}-11-27`;
const isXM = (g) => g.w === 16 && g.date <= `${SEASON}-12-25`;

function legOf(g) { return isTG(g) ? "tg" : isXM(g) ? "xmas" : `w${g.w}`; }
const LEG_IDS = (() => {
  const ids = [];
  for (let w = 1; w <= 18; w++) { if (w === 12) ids.push("tg"); if (w === 16) ids.push("xmas"); ids.push(`w${w}`); }
  return ids;
})();

const impl = (ml) => (ml == null ? null : ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));

// { legId: { TEAM: { p, status } } } for every team that plays in the leg. status comes from the schedule alone;
// p is null when the game has no line (ESPN drops odds from finished games), so a played leg is still recognised.
function legTable(games) {
  const T = {}; LEG_IDS.forEach((l) => { T[l] = {}; });
  Object.values(games).forEach((g) => {
    if (!g || !g.away || !g.home || g.w < 1 || g.w > 18) return;
    const leg = legOf(g), pa = impl(g.mlAway), ph = impl(g.mlHome), st = g.status || "pre";
    const s = pa != null && ph != null ? pa + ph : null;
    T[leg][g.away] = { p: s ? pa / s : null, status: st };
    T[leg][g.home] = { p: s ? ph / s : null, status: st };
  });
  return T;
}

// Hungarian algorithm (minimization) for an n x m cost matrix with n <= m. Returns row -> column.
function hungarian(cost) {
  const n = cost.length, m = cost[0].length, INF = Number.POSITIVE_INFINITY;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const assign = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) assign[p[j] - 1] = j - 1;
  return assign;
}

// games: the odds/{season}/games map. current: { legId: TEAM } (last solve, or the seed).
// Returns { picks, fixed: [legIds], prob } where prob is the product of win % over legs with a pick.
function solve(games, current) {
  const T = legTable(games);
  const picks = {}, fixed = [], used = new Set();
  LEG_IDS.forEach((l) => {
    const t = current && current[l], e = t && T[l][t];
    if (e && e.status !== "pre") { picks[l] = t; fixed.push(l); used.add(t); }
  });
  const open = LEG_IDS.filter((l) => !picks[l]);
  const teams = [...new Set(Object.values(T).flatMap((x) => Object.keys(x)))].filter((t) => !used.has(t)).sort();
  if (open.length && teams.length) {
    const BIG = 1e6;
    const cost = open.map((l) => teams.map((t) => {
      const e = T[l][t];
      return e && e.status === "pre" && e.p != null && e.p > 0 ? -Math.log(e.p) : BIG;
    }));
    const a = hungarian(cost);
    open.forEach((l, i) => { const j = a[i]; if (j >= 0 && cost[i][j] < BIG) picks[l] = teams[j]; });
  }
  let prob = 1;   // over legs that still have a line; played legs with no stored line are left out
  LEG_IDS.forEach((l) => { const e = picks[l] && T[l][picks[l]]; if (e && e.p != null) prob *= e.p; });
  return { picks, fixed, prob };
}

// The leg in play: the first one (in leg order) with a game not yet final. { id, started } where started means at
// least one of its games has kicked off. Null once the season is over.
function currentLeg(games) {
  const legs = {}; LEG_IDS.forEach((l) => { legs[l] = { any: false, allDone: true, started: false }; });
  Object.values(games).forEach((g) => {
    if (!g || g.w < 1 || g.w > 18) return;
    const L = legs[legOf(g)]; L.any = true;
    if (!g.done) L.allDone = false;
    if ((g.status || "pre") !== "pre") L.started = true;
  });
  for (const l of LEG_IDS) { const L = legs[l]; if (L.any && !L.allDone) return { id: l, started: L.started }; }
  return null;
}

module.exports = { solve, legTable, LEG_IDS, legOf, currentLeg };
