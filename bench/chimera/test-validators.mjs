// test-validators.mjs — tests des validateurs structurels Chimera (fixtures, 0 réseau).
import {
  validateExpansion, validatePruned, perspectiveDistinctness, validateFusion,
} from './validators.mjs';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const sub = (name, score) => ({ name, details: 'variant details', alternatives: ['alt1', 'alt2'], requirements: ['req'], compatibility_score: score });
const branch = (approach, score) => ({ approach, description: `description of ${approach} with enough text`, sub_options: [sub(`${approach}-a`, score), sub(`${approach}-b`, score * 0.8)], compatibility_score: score });
const tree = { domain: 'code', task_summary: 'refactor auth', branches: [branch('jwt-rotation', 0.9), branch('session-table', 0.7), branch('oauth-proxy', 0.5), branch('hybrid-cache', 0.4)], total_combinations: 8, expansion_notes: 'explored all paths' };

console.log('\n── Slime Mold : expansion ──');
check('arbre valide accepté', validateExpansion(tree).ok, JSON.stringify(validateExpansion(tree).errors));
check('trop de branches rejeté', !validateExpansion({ ...tree, branches: Array.from({ length: 9 }, (_, i) => branch(`b${i}`, 0.5)), total_combinations: 9 }).ok);
check('score > 1 rejeté', !validateExpansion({ ...tree, branches: [branch('x', 1.5)], total_combinations: 1 }).ok);
check('total_combinations incohérent rejeté', !validateExpansion({ ...tree, total_combinations: 0 }).ok);

console.log('\n── Slime Mold : élagage ──');
const prunedGood = { pruned_branches: [branch('jwt-rotation', 0.9), branch('session-table', 0.7), branch('oauth-proxy', 0.5)] };
check('élagage valide (3 branches ⊆ source)', validatePruned(prunedGood, tree).ok, JSON.stringify(validatePruned(prunedGood, tree).errors));
check('trop peu de survivantes rejeté', !validatePruned({ pruned_branches: [branch('jwt-rotation', 0.9)] }, tree).ok);
check('branche inventée rejetée', !validatePruned({ pruned_branches: [...prunedGood.pruned_branches, branch('quantum-auth', 0.9)] }, tree).ok);
check('doublon rejeté', !validatePruned({ pruned_branches: [branch('jwt-rotation', 0.9), branch('jwt-rotation', 0.9), branch('session-table', 0.7)] }, tree).ok);
check('score altéré rejeté', !validatePruned({ pruned_branches: [branch('jwt-rotation', 0.1), branch('session-table', 0.7), branch('oauth-proxy', 0.5)] }, tree).ok);

console.log('\n── PRISM : distinctness ──');
const sol = (t) => ({ solution: { summary: t } });
(async () => {
  const distinct = await perspectiveDistinctness([
    sol('Use a background worker queue with exponential backoff for retry handling and dead letter storage.'),
    sol('Embed a vector database for semantic caching, monitoring latency percentiles and memory budgets.'),
  ]);
  check('perspectives distinctes acceptées', distinct.ok, `mean=${distinct.mean.toFixed(3)}`);
  const collapsed = await perspectiveDistinctness([
    sol('Use a background worker queue for retries with backoff.'),
    sol('Use a background worker queue for retries with backoff.'),
  ]);
  check('perspectives identiques rejetées (effondrées)', !collapsed.ok, `mean=${collapsed.mean.toFixed(3)}`);

  console.log('\n── PRISM : fusion ──');
  const srcA = sol('JWT rotation with short-lived tokens stored in an httpOnly cookie, refresh via secure endpoint.');
  const srcB = sol('Session table with server-side revocation, indexed lookups, and rate limiting on refresh.');
  const fusionGood = sol('JWT rotation carried in httpOnly cookie combined with a server-side revocation table for instant kill, rate limiting on the refresh endpoint, indexed session lookups for audit.');
  check('fusion valide (syncrétisme méritocratique)', validateFusion(fusionGood, [srcA, srcB]).ok, JSON.stringify(validateFusion(fusionGood, [srcA, srcB])));
  check('copie d\'une source rejetée', !validateFusion(srcA, [srcA, srcB]).ok);
  check('résumé « Perspective 1 said » rejeté', !validateFusion(sol('Perspective 1 said JWT; Perspective 2 said sessions. Both are good options to consider.'), [srcA, srcB]).ok);

  console.log(`\n${fails ? `❌ ${fails} ÉCHEC(S)` : '✅ TOUS LES TESTS PASSENT'}\n`);
  process.exit(fails ? 1 : 0);
})();
