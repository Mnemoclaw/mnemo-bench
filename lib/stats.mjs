// stats.mjs — moteur statistique publication-grade, zéro dépendance.
// Réutilise le code éprouvé de mc-double-blind-bench (Wilson, Fisher, Holm,
// permutation, cluster bootstrap) et ajoute : métriques IR (Recall/MRR/nDCG/P@k),
// kappa de Cohen, McNemar exact, Wilcoxon signed-rank, bootstrap apparié seedé.
// Toute aléatoire est déterministe (xorshift, graine fixe) → runs reproductibles.

const Z95 = 1.959963985;

// ---------- PRNG déterministe (xorshift32) ----------
export function prng(seed = 0x9e3779b9) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s ^= s >>> 7; s ^= s << 17;
    return (s >>> 0) / 4294967296;
  };
}

// ---------- Proportions ----------
export function wilson(k, n, z = Z95) {
  if (!n) return null;
  const p = k / n, z2 = z * z;
  const d = 1 + z2 / n;
  const c = p + z2 / (2 * n);
  const r = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { p, lo: Math.max(0, (c - r) / d), hi: Math.min(1, (c + r) / d) };
}

// ---------- log-gamma (Lanczos) + Fisher exact 2×2 ----------
const G = 7;
const LGP = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = LGP[0];
  for (let i = 1; i < G + 2; i++) x += LGP[i] / (z + i);
  const t = z + G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const lchoose = (n, k) => (k < 0 || k > n || n < 0) ? -Infinity : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

// Fisher exact bilatéral sur [[a,b],[c,d]]
export function fisherExact(a, b, c, d) {
  const n = a + b + c + d, r1 = a + b, r2 = c + d, cc = a + c;
  const prob = (x) => Math.exp(lchoose(r1, x) + lchoose(r2, cc - x) - lchoose(n, cc));
  const pObs = prob(a);
  const lo = Math.max(0, cc - r2), hi = Math.min(cc, r1);
  let p = 0;
  for (let x = lo; x <= hi; x++) { const px = prob(x); if (px <= pObs * (1 + 1e-9)) p += px; }
  return Math.min(1, p);
}

// ---------- Holm-Bonferroni step-down ----------
export function holm(pvals) {
  const m = pvals.length;
  const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adj = new Array(m).fill(1);
  let prev = 0;
  idx.forEach(([p, i], rank) => { const a = Math.min(1, (m - rank) * p); prev = Math.max(prev, a); adj[i] = prev; });
  return adj;
}

// ---------- Test de permutation bilatéral (différence de proportions) ----------
export function permTest(k1, n1, k0, n0, iters = 10000, seed = 0x2545f491) {
  if (!n1 || !n0) return null;
  const succ = Array(n1).fill(1).concat(Array(n0).fill(0));
  const dObs = Math.abs(k1 / n1 - k0 / n0);
  const next = prng(seed);
  let count = 0;
  for (let it = 0; it < iters; it++) {
    let kA = 0;
    for (let i = 0; i < n1; i++) { const j = i + Math.floor(next() * (succ.length - i)); [succ[i], succ[j]] = [succ[j], succ[i]]; if (succ[i]) kA++; }
    if (Math.abs(kA / n1 - (k1 + k0 - kA) / n0) >= dObs - 1e-12) count++;
  }
  return count / iters;
}

// ---------- Cluster bootstrap du lift (clusters = tâches/queries) ----------
export function clusterBootstrapLift(rows, { arms = ['c1', 'c0'], iters = 5000, seed = 0x9e3779b9 } = {}) {
  const byTask = {};
  for (const r of rows) {
    if (r.error || r.kind !== 'issue') continue;
    if (!arms.includes(r.arm)) continue;
    byTask[r.taskId] ??= {};
    byTask[r.taskId][r.arm] ??= { k: 0, n: 0 };
    byTask[r.taskId][r.arm].n++;
    if (r.pass) byTask[r.taskId][r.arm].k++;
  }
  const tasks = Object.keys(byTask).filter((t) => byTask[t][arms[0]] && byTask[t][arms[1]]);
  if (!tasks.length) return null;
  const next = prng(seed);
  const lifts = [];
  for (let it = 0; it < iters; it++) {
    let k1 = 0, n1 = 0, k0 = 0, n0 = 0;
    for (let i = 0; i < tasks.length; i++) {
      const t = byTask[tasks[Math.floor(next() * tasks.length)]];
      k1 += t[arms[0]].k; n1 += t[arms[0]].n; k0 += t[arms[1]].k; n0 += t[arms[1]].n;
    }
    if (n1 && n0) lifts.push(k1 / n1 - k0 / n0);
  }
  lifts.sort((a, b) => a - b);
  return {
    lift: lifts.reduce((a, b) => a + b, 0) / lifts.length,
    lo: lifts[Math.floor(0.025 * lifts.length)],
    hi: lifts[Math.floor(0.975 * lifts.length)],
  };
}

// ---------- Métriques IR (qrels gradués 0/1/2) ----------
// ranked: [docId,…] par rang décroissant ; gains: Map docId→grade
const REL = (gains, id) => gains.get(id) || 0;

export function recallAtK(ranked, gains, k) {
  const totRel = [...gains.values()].filter((g) => g > 0).length;
  if (!totRel) return null;
  let hit = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (REL(gains, ranked[i]) > 0) hit++;
  return hit / totRel;
}

export function precisionAtK(ranked, gains, k) {
  let hit = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (REL(gains, ranked[i]) > 0) hit++;
  return hit / k;
}

export function mrrAtK(ranked, gains, k) {
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (REL(gains, ranked[i]) > 0) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(ranked, gains, k) {
  const dcg = (list) => {
    let s = 0;
    for (let i = 0; i < Math.min(k, list.length); i++) s += (Math.pow(2, REL(gains, list[i])) - 1) / Math.log2(i + 2);
    return s;
  };
  const ideal = [...gains.entries()].filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const idcg = dcg(ideal);
  return idcg > 0 ? dcg(ranked) / idcg : null;
}

// Moyenne d'une métrique IR sur N queries + IC 95 % (bootstrap par query —
// la query est le cluster naturel : les erreurs y sont corrélées).
export function meanWithBootstrapCI(perQueryValues, { iters = 10000, seed = 0x9e3779b9 } = {}) {
  const v = perQueryValues.filter((x) => x != null);
  if (!v.length) return null;
  const next = prng(seed);
  const means = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[Math.floor(next() * v.length)];
    means.push(s / v.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    lo: means[Math.floor(0.025 * means.length)],
    hi: means[Math.floor(0.975 * means.length)],
    n: v.length,
  };
}

// Delta apparié entre deux systèmes (mêmes queries) : bootstrap CI + Wilcoxon
export function pairedDelta(perQueryA, perQueryB, { iters = 10000, seed = 0x9e3779b9 } = {}) {
  const pairs = perQueryA.map((a, i) => [a, perQueryB[i]]).filter(([a, b]) => a != null && b != null);
  const n = pairs.length;
  if (!n) return null;
  const d = pairs.map(([a, b]) => a - b);
  const meanD = d.reduce((x, y) => x + y, 0) / n;
  const next = prng(seed);
  const boots = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(next() * n)];
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  return {
    mean: meanD,
    lo: boots[Math.floor(0.025 * boots.length)],
    hi: boots[Math.floor(0.975 * boots.length)],
    wilcoxonP: wilcoxonSignedRank(d).p,
    n,
  };
}

// ---------- Wilcoxon signed-rank (approximation normale, correction continuité) ----------
export function wilcoxonSignedRank(diffs) {
  const nz = diffs.filter((x) => x !== 0);
  const n = nz.length;
  if (!n) return { W: 0, p: 1, n: 0 };
  const ranked = nz.map((x) => ({ x, abs: Math.abs(x) })).sort((a, b) => a.abs - b.abs);
  // rangs moyens pour les ex-aequo
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && ranked[j + 1].abs === ranked[i].abs) j++;
    const r = (i + j + 2) / 2;
    for (let t = i; t <= j; t++) ranks[t] = r;
    i = j + 1;
  }
  let Wp = 0;
  ranked.forEach((e, idx) => { if (e.x > 0) Wp += ranks[idx]; });
  const Wm = n * (n + 1) / 2 - Wp;
  const W = Math.min(Wp, Wm);
  const mu = n * (n + 1) / 4;
  const sigma = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24);
  const z = (W - mu - 0.5) / sigma;
  const p = 2 * normalCdf(z); // bilatéral
  return { W, Wp, Wm, z, p, n };
}

function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x) { // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

// ---------- McNemar exact (apparié binaire) ----------
export function mcnemarExact(b, c) {
  // b = [A réussit, B échoue], c = [A échoue, B réussit]
  const n = b + c;
  if (n === 0) return { p: 1, b, c };
  const k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(lchoose(n, i) - n * Math.LN2);
  return { p: Math.min(1, 2 * p), b, c };
}

// ---------- Kappa de Cohen (accord inter-juges, pondération nulle) ----------
export function cohensKappa(raterA, raterB, labels) {
  const n = raterA.length;
  if (!n || n !== raterB.length) return null;
  const lab = labels || [...new Set([...raterA, ...raterB])];
  const idx = new Map(lab.map((l, i) => [l, i]));
  const O = Array.from({ length: lab.length }, () => new Array(lab.length).fill(0));
  for (let i = 0; i < n; i++) O[idx.get(raterA[i])][idx.get(raterB[i])]++;
  let diag = 0;
  for (let i = 0; i < lab.length; i++) diag += O[i][i];
  const po = diag / n; // accord observé = diagonale uniquement
  const rowSum = O.map((r) => r.reduce((a, b) => a + b, 0) / n);
  const colSum = lab.map((_, j) => O.reduce((a, r) => a + r[j], 0) / n);
  const pe = rowSum.reduce((a, w, i) => a + w * colSum[i], 0);
  return { kappa: pe === 1 ? 1 : (po - pe) / (1 - pe), po, pe, n };
}

const fmtCI = (w) => (w ? `${(w.p * 100).toFixed(1)} % [${(w.lo * 100).toFixed(1)} ; ${(w.hi * 100).toFixed(1)}]` : 'n/a');
export { fmtCI };
