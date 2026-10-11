// test-stats.mjs — validation des propriétés du moteur statistique (0 appel réseau).
// Chaque test = valeur de référence connue ou propriété mathématique. Doit passer à 100 %.
import {
  wilson, fisherExact, holm, permTest, mrrAtK, recallAtK, precisionAtK, ndcgAtK,
  meanWithBootstrapCI, pairedDelta, wilcoxonSignedRank, mcnemarExact, cohensKappa,
  clusterBootstrapLift,
} from './stats.mjs';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('\n── Wilson ──');
const w = wilson(0, 10);
check('wilson(0,10) centre 0', near(w.p, 0));
check('wilson(0,10) borne haute ≈ 0.2775', near(w.hi, 0.27753, 1e-4), `hi=${w.hi.toFixed(5)}`);
check('wilson(0,0) → null', wilson(0, 0) === null);
const w5 = wilson(5, 10);
check('wilson(5,10) contient 0.5', w5.lo < 0.5 && w5.hi > 0.5);

console.log('\n── Fisher exact ──');
const p1 = fisherExact(0, 10, 10, 0);
check('séparation parfaite 0/10 vs 10/10 → p<0.001', p1 < 1e-3, `p=${p1.toExponential(2)}`);
const p2 = fisherExact(5, 5, 5, 5);
check('table équilibrée → p=1', near(p2, 1), `p=${p2}`);
check('symétrie', near(fisherExact(1, 9, 3, 7), fisherExact(3, 7, 1, 9)));

console.log('\n── Holm ──');
const adj = holm([0.01, 0.04, 0.03]);
check('Holm([.01,.04,.03]) = [.03,.06,.06] (monotonie imposée)', near(adj[0], 0.03) && near(adj[1], 0.06) && near(adj[2], 0.06), JSON.stringify(adj));
check('Holm monotone', adj[0] <= adj[1] && adj[1] <= adj[2]);

console.log('\n── IR metrics (qrels gradués) ──');
// query de référence : 3 docs pertinents (2,1,2) parmi 10
const gains = new Map([['d1', 2], ['d2', 1], ['d3', 2]]);
const rankedPerfect = ['d1', 'd3', 'd2', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];
const rankedWorst = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'd1', 'd2', 'd3'];
check('recall@3 parfait = 1', near(recallAtK(rankedPerfect, gains, 3), 1));
check('recall@3 pire cas = 0', near(recallAtK(rankedWorst, gains, 3), 0));
check('P@3 parfait = 1', near(precisionAtK(rankedPerfect, gains, 3), 1));
check('MRR@10 pire cas = 1/8', near(mrrAtK(rankedWorst, gains, 10), 1 / 8));
check('nDCG@10 parfait = 1', near(ndcgAtK(rankedPerfect, gains, 10), 1));
check('nDCG@10 < nDCG@10 inversé', ndcgAtK(rankedWorst, gains, 10) < ndcgAtK(rankedPerfect, gains, 10));
const ndcgWorst = ndcgAtK(rankedWorst, gains, 10);
// DCG = 3/log2(9)+1/log2(10)+3/log2(11) = 2.1146 ; IDCG = 3+3/log2(3)+1/2 = 5.3928
check('nDCG@10 pire cas ≈ 0.3921 (valeur calculée à la main)', near(ndcgWorst, 0.3921, 1e-3), `ndcg=${ndcgWorst.toFixed(4)}`);

console.log('\n── Bootstrap CI (déterministe, seedée) ──');
const ci = meanWithBootstrapCI([0.8, 0.7, 0.9, 0.6, 1.0, 0.5, 0.9, 0.8, 0.7, 0.6]);
check('CI contient la moyenne', ci.lo <= ci.mean && ci.mean <= ci.hi, `mean=${ci.mean.toFixed(3)} [${ci.lo.toFixed(3)};${ci.hi.toFixed(3)}]`);
const ci2 = meanWithBootstrapCI([0.8, 0.7, 0.9, 0.6, 1.0, 0.5, 0.9, 0.8, 0.7, 0.6]);
check('deux runs identiques (déterminisme)', near(ci.mean, ci2.mean) && near(ci.lo, ci2.lo) && near(ci.hi, ci2.hi));

console.log('\n── Delta apparié + Wilcoxon ──');
const A = [0.9, 0.8, 0.7, 0.9, 0.6, 0.9, 0.8, 0.7, 0.9, 0.8];
const B = [0.3, 0.2, 0.4, 0.3, 0.2, 0.4, 0.3, 0.2, 0.4, 0.3];
const dAB = pairedDelta(A, B, { iters: 2000 });
check('delta A-B = +0.50', near(dAB.mean, 0.5, 1e-9), `mean=${dAB.mean}`);
check('CI exclut 0 (systèmes séparés)', dAB.lo > 0, `lo=${dAB.lo.toFixed(3)}`);
check('Wilcoxon p<0.01', dAB.wilcoxonP < 0.01, `p=${dAB.wilcoxonP}`);
const dNoise = pairedDelta([0.5, 0.4, 0.6, 0.5, 0.4, 0.6, 0.5, 0.4], [0.4, 0.5, 0.6, 0.5, 0.5, 0.4, 0.6, 0.4]);
check('bruit symétrique → p non-significatif', dNoise.wilcoxonP > 0.05, `p=${dNoise.wilcoxonP.toFixed(3)}`);
const wl = wilcoxonSignedRank([1, 2, 3, 4, 5, 6, 7, 8].map((x) => x));
check('wilcoxon tous positifs → p<0.01', wl.p < 0.01, `p=${wl.p.toFixed(4)}`);

console.log('\n── McNemar exact ──');
check('b=10,c=1 → p<0.05', mcnemarExact(10, 1).p < 0.05, `p=${mcnemarExact(10, 1).p.toFixed(4)}`);
check('b=c=5 → p=1 (symétrie)', near(mcnemarExact(5, 5).p, 1));
check('b=0,c=0 → p=1', near(mcnemarExact(0, 0).p, 1));

console.log('\n── Kappa de Cohen ──');
const ka = cohensKappa(['y', 'y', 'n', 'n', 'y', 'n'], ['y', 'y', 'n', 'n', 'y', 'n']);
check('accord parfait → κ=1', near(ka.kappa, 1));
const kb = cohensKappa(['y', 'y', 'y', 'y'], ['n', 'n', 'n', 'n']);
check('désaccord total → κ=0 (po=0, pe=0)', near(kb.kappa, 0) && near(kb.po, 0), `κ=${kb.kappa.toFixed(3)}`);
// cas manuel : 8 accords/10 → po=0.8 ; pe=(0.4×0.4)+(0.6×0.6)=0.52 ; κ=0.28/0.48≈0.5833
const kc = cohensKappa(
  ['y', 'y', 'n', 'n', 'y', 'n', 'y', 'n', 'n', 'n'],
  ['y', 'n', 'n', 'n', 'y', 'n', 'y', 'y', 'n', 'n'],
);
check('κ cas manuel ≈ 0.5833', near(kc.kappa, 0.5833, 1e-3), `κ=${kc.kappa.toFixed(4)} po=${kc.po} pe=${kc.pe.toFixed(3)}`);

console.log('\n── Cluster bootstrap (contrat double-aveugle) ──');
const rows = [];
for (let s = 1; s <= 10; s++) {
  rows.push({ taskId: 't1', arm: 'c0', kind: 'issue', pass: false }, { taskId: 't1', arm: 'c1', kind: 'issue', pass: true });
  rows.push({ taskId: 't2', arm: 'c0', kind: 'issue', pass: false }, { taskId: 't2', arm: 'c1', kind: 'issue', pass: true });
}
const lift = clusterBootstrapLift(rows, { arms: ['c1', 'c0'], iters: 2000 });
check('lift parfait = +1, CI exclut 0', near(lift.lift, 1) && lift.lo > 0, `lift=${lift.lift} [${lift.lo};${lift.hi}]`);

console.log(`\n${fails ? `❌ ${fails} ÉCHEC(S)` : '✅ TOUS LES TESTS PASSENT'}\n`);
process.exit(fails ? 1 : 0);
