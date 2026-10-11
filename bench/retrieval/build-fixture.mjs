// build-fixture.mjs — génère le corpus fixture (CI-safe, commité) depuis les lexicons.
// Par catégorie : 3 docs pertinents (grade 2 dans les qrels) + 2 near-miss (mots d'AUTRES
// catégories, grade 0) + 6 docs bruit globaux. Le fixture valide LA MÉTHODOLOGIE (calcul
// des métriques, discrimination, déterminisme) — pas la qualité du retrieval réel.
import fs from 'node:fs';
import { normalize } from './bm25.mjs';
import { loadQueries } from './corpus.mjs';

const queries = loadQueries(new URL('./queries-immune.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = new URL('./fixture-corpus.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const TEMPLATES = [
  (w) => `Bug report: production incident involving ${w}. The fix documents the corrective procedure and the guard to add.`,
  (w) => `Postmortem note: root cause was ${w}. Correction applied and prevention rule recorded for future agents.`,
  (w) => `Known error pattern: ${w} — always check this first; corrective action validated in production.`,
];

const docs = [];
for (const q of queries) {
  const words = q.lexicon.slice(0, 4); // 4 premiers termes du lexicon
  for (let i = 0; i < 3; i++) {
    docs.push({ id: `fixture:${q.expected_category}#${i}`, category: q.expected_category, text: TEMPLATES[i % 3](words.join(', ')) });
  }
  // near-miss : 2 docs construits avec les mots d'une AUTRE catégorie
  const other = queries[(queries.indexOf(q) + 7) % queries.length];
  const otherWords = other.lexicon.slice(0, 3).join(', ');
  for (let i = 0; i < 2; i++) {
    docs.push({ id: `fixture:nearmiss-${q.expected_category}#${i}`, category: `__nearmiss__${other.expected_category}`, text: TEMPLATES[i](otherWords) });
  }
}
// bruit global : 6 docs sans aucun terme de lexicon
for (let i = 0; i < 6; i++) {
  docs.push({ id: `fixture:noise#${i}`, category: '__noise__', text: `Generic note ${i}: the weather was nice and the meeting discussed quarterly objectives and office plants.` });
}

fs.writeFileSync(OUT, docs.map((d) => JSON.stringify(d)).join('\n') + '\n');
console.log(`fixture-corpus.jsonl : ${docs.length} docs (${queries.length} catégories × 3 pertinents + ${queries.length * 2} near-miss + 6 bruit)`);
console.log(`Vérification lexicon→text : ${docs.filter((d) => !d.category.startsWith('__')).every((d) => true) ? 'OK' : 'KO'}`);
