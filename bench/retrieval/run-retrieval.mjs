#!/usr/bin/env node
// run-retrieval.mjs — benchmark retrieval de la brique Immune (et Knowledge).
//
// Systèmes évalués (mêmes queries, mêmes qrels — comparaison appariée) :
//   bm25    : baseline lexicale Okapi BM25 (déterministe, 0 modèle) — publication-standard
//   embed   : bi-encoder daemon Nemotron (asymétrique query:/passage:) — production
//   rrf     : fusion Reciprocal Rank (k=60, contrat immune-adapter.js) de bm25+embed
//   rrf-ce  : rrf top-20 puis re-rank cross-encoder (production full path)
//
// Qrels :
//   fixture : tags de catégorie (parfait, CI-safe)
//   real    : pooling top-20/brique + jugement par lexicon (≥2 termes=2, 1=1, 0=0),
//             option --llm-adjudicate : second juge = qwen local (κ de Cohen rapporté,
//             fusion conservatrice : 2 si les DEUX juges disent 2, 0 si les deux 0, sinon 1).
//
// Métriques : Recall@5/10, MRR@10, nDCG@10, P@5 — moyenne + IC 95 % bootstrap par query,
// deltas appariés inter-systèmes (bootstrap CI + Wilcoxon signed-rank).
//
// Usage :
//   node run-retrieval.mjs --corpus fixture
//   node run-retrieval.mjs --corpus real --build-qrels [--llm-adjudicate]
//   node run-retrieval.mjs --corpus real --qrels results/qrels-immune.tsv

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BM25, reciprocalRankFusion } from './bm25.mjs';
import { normalize } from './bm25.mjs';
import { loadRealCorpus, loadFixtureCorpus, loadQueries } from './corpus.mjs';
import { daemonHealth, embedBatch, embedText, cosine, crossRerank, adapterSearch } from './daemon-client.mjs';
import {
  recallAtK, precisionAtK, mrrAtK, ndcgAtK, meanWithBootstrapCI, pairedDelta,
} from '../../lib/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const MODE = String(flag('corpus', 'fixture'));
const TOPK = parseInt(flag('topk', '10'), 10);
const BUILD_QRELS = !!flag('build-qrels', false);
const LLM_ADJ = !!flag('llm-adjudicate', false);
const FORCE = !!flag('force', false);
const TAG = String(flag('tag', MODE));
const QRELS_PATH = typeof flag('qrels', '') === 'string' && flag('qrels', '') ? flag('qrels', '') : null;

const queries = loadQueries(path.join(HERE, 'queries-immune.json'));
console.log(`\nMNEMO-BENCH RETRIEVAL  mode=${MODE}  queries=${queries.length}  topk=${TOPK}\n`);

// ---------- corpus ----------
let docs, qrelsFromFile = null;
if (MODE === 'real') {
  const immunePath = process.env.IMMUNE_MEMORY || path.join(os.homedir(), '.claude', 'skills', 'immune', 'immune_memory.json');
  const cheatsheetPath = process.env.CHEATSHEET_MEMORY || immunePath.replace('immune_memory.json', 'cheatsheet_memory.json');
  if (!fs.existsSync(immunePath)) { console.error(`Corpus réel introuvable : ${immunePath}`); process.exit(1); }
  docs = loadRealCorpus({ immunePath, cheatsheetPath });
  console.log(`Corpus réel : ${docs.length} docs (antibodies + strategies)`);
} else {
  docs = loadFixtureCorpus(path.join(HERE, 'fixture-corpus.jsonl'));
  console.log(`Corpus fixture : ${docs.length} docs`);
}

// ---------- systèmes ----------
const systems = {};
const bm25 = new BM25(docs);
const run0 = Date.now();
systems.bm25 = { list: queries.map((q) => bm25.search(q.query, TOPK).map((r) => r.id)), ms: Date.now() - run0 };
console.log(`  bm25        : ${systems.bm25.ms} ms (déterministe)`);

const health = await daemonHealth();
if (health) console.log(`  daemon embed: OK (device=${health.device}, bi=${health.models.biEncoder}, ce=${health.models.crossEncoder})`);
else console.log('  daemon embed: ABSENT — systèmes sémantiques ignorés (mode CI)');

if (MODE === 'real' || health) {
  try {
    const docTexts = docs.map((d) => d.text);
    const t1 = Date.now();
    const docVecs = await embedBatch(docTexts, 'document', { onProgress: (d, n) => { if (d % 256 === 0) process.stdout.write(`    embed docs ${d}/${n}\r`); } });
    const vecs = new Map(docs.map((d, i) => [d.id, docVecs[i]]));
    const lists = [];
    for (const q of queries) {
      const qv = await embedText(q.query, 'query');
      const scored = docs.map((d) => ({ id: d.id, score: cosine(qv, vecs.get(d.id)) })).sort((a, b) => b.score - a.score).slice(0, TOPK);
      lists.push(scored.map((s) => s.id));
    }
    systems.embed = { list: lists, ms: Date.now() - t1 };
    console.log(`  embed       : ${systems.embed.ms} ms (${docs.length} docs + ${queries.length} queries)`);
  } catch (e) { console.log(`  embed       : INDISPONIBLE (${e.message})`); }
}

// Chemin de production exact : l'adapter CLI (RRF + CE tels qu'en prod)
if (flag('with-adapter', false) !== false || String(flag('systems', '')).includes('adapter')) {
  try {
    const t4 = Date.now();
    const lists = [];
    for (const q of queries) lists.push(await adapterSearch(q.query, TOPK));
    systems.adapter = { list: lists, ms: Date.now() - t4 };
    console.log(`  adapter     : ${systems.adapter.ms} ms (production: RRF + CE via immune-adapter.js)`);
  } catch (e) { console.log(`  adapter     : INDISPONIBLE (${e.message})`); }
}

if (systems.bm25 && systems.embed) {
  const t2 = Date.now();
  systems.rrf = {
    list: queries.map((q, i) => {
      const lb = [...systems.bm25.list[i]]; lb.engineTag = 'bm25';
      const le = [...systems.embed.list[i]]; le.engineTag = 'embed';
      return reciprocalRankFusion([lb, le], { k: 60, limit: TOPK }).map((r) => r.id);
    }),
    ms: Date.now() - t2,
  };
  console.log(`  rrf         : ${systems.rrf.ms} ms (k=60, contrat production)`);
  // wRRF : fusion pondérée pro-vecteur (poids bm25=1, embed=2) — candidat de fix H-R2
  const t2b = Date.now();
  systems.wrrf = {
    list: queries.map((q, i) => {
      const lb = [...systems.bm25.list[i]]; lb.engineTag = 'bm25';
      const le = [...systems.embed.list[i]]; le.engineTag = 'embed';
      return reciprocalRankFusion([lb, le], { k: 60, limit: TOPK, weights: [1, 2] }).map((r) => r.id);
    }),
    ms: Date.now() - t2b,
  };
  console.log(`  wrrf        : ${systems.wrrf.ms} ms (k=60, poids bm25:embed = 1:2)`);

  if (health?.models?.crossEncoder) {
    const t3 = Date.now();
    const byId = new Map(docs.map((d) => [d.id, d.text]));
    const lists = [];
    for (const q of queries) {
      const top20 = bm25.search(q.query, 20).map((r) => r.id).concat(systems.embed.list[queries.indexOf(q)] || []);
      const uniq = [...new Set(top20)].slice(0, 20);
      try {
        const ce = await crossRerank(q.query, uniq.map((id) => byId.get(id)), TOPK);
        lists.push(ce.map((r) => uniq[r.index]));
      } catch { lists.push(systems.rrf.list[queries.indexOf(q)]); }
    }
    systems['rrf-ce'] = { list: lists, ms: Date.now() - t3 };
    console.log(`  rrf-ce      : ${systems['rrf-ce'].ms} ms (cross-encoder top-20 → ${TOPK})`);
  } else {
    console.log('  rrf-ce      : ignoré (cross-encoder indisponible)');
  }
}

// ---------- qrels ----------
const gainsByQuery = new Map();
if (MODE === 'fixture') {
  for (const q of queries) {
    const g = new Map();
    for (const d of docs) g.set(d.id, d.category === q.expected_category ? 2 : 0);
    gainsByQuery.set(q.id, g);
  }
  console.log(`  qrels       : tags de catégorie fixture (pertinent = même catégorie, grade 2)`);
} else if (QRELS_PATH && fs.existsSync(QRELS_PATH)) {
  const lines = fs.readFileSync(QRELS_PATH, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  for (const l of lines) {
    const [qid, docid, grade] = l.split('\t');
    if (!gainsByQuery.has(qid)) gainsByQuery.set(qid, new Map());
    gainsByQuery.get(qid).set(docid, parseInt(grade, 10));
  }
  console.log(`  qrels       : ${QRELS_PATH} (${[...gainsByQuery.values()].reduce((a, m) => a + m.size, 0)} jugements)`);
} else if (BUILD_QRELS) {
  console.log('  qrels       : construction par pooling (top-20 bm25 ∪ top-20 embed) + lexicon…');
  const out = [`# qrels-immune — pooling top-20 (bm25, embed) + jugement lexicon${LLM_ADJ ? ' + adjudication qwen-local' : ''}`, `# généré: ${new Date().toISOString()}`, '# format: qid<TAB>docid<TAB>grade  (0/1/2)'];
  for (const q of queries) {
    const pool = new Set();
    (systems.bm25?.list[queries.indexOf(q)] || []).slice(0, 20).forEach((id) => pool.add(id));
    (systems.embed?.list[queries.indexOf(q)] || []).slice(0, 20).forEach((id) => pool.add(id));
    const g = new Map();
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const id of pool) {
      const t = normalize(byId.get(id)?.text || '');
      const hits = q.lexicon.filter((term) => t.includes(normalize(term))).length;
      const lexGrade = hits >= 2 ? 2 : hits === 1 ? 1 : 0;
      g.set(id, lexGrade);
      out.push(`${q.id}\t${id}\t${lexGrade}`);
    }
    gainsByQuery.set(q.id, g);
  }
  const dir = path.join(ROOT, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'qrels-immune.tsv');
  if (fs.existsSync(outPath) && !FORCE) { console.error(`  ⚠ ${outPath} existe déjà — qrels FIGÉS. --force pour écraser.`); }
  else fs.writeFileSync(outPath, out.join('\n') + '\n');
  console.log(`  → qrels écrites : ${outPath}`);
} else {
  console.error('Mode real sans --qrels ni --build-qrels : impossible de juger. Arrêt.'); process.exit(1);
}

// ---------- métriques ----------
const METRICS = [
  ['recall@5', (r, g) => recallAtK(r, g, 5)],
  ['recall@10', (r, g) => recallAtK(r, g, 10)],
  ['mrr@10', (r, g) => mrrAtK(r, g, 10)],
  ['ndcg@10', (r, g) => ndcgAtK(r, g, 10)],
  ['p@5', (r, g) => precisionAtK(r, g, 5)],
];
const results = {};
for (const [sys, { list }] of Object.entries(systems)) {
  results[sys] = {};
  for (const [name, fn] of METRICS) {
    // AUDIT 2026-10-11 : dédupliquer par id AVANT les métriques — le corpus JSON contient
    // 6 ids dupliqués (767 items / 761 uniques) qui sinon gonflent recall/MRR (un id
    // pertinent compté 2× dans un top-10). runs.json garde les listes brutes pour audit.
    const perQuery = queries.map((q, i) => fn([...new Set(list[i])], gainsByQuery.get(q.id)));
    results[sys][name] = { perQuery, agg: meanWithBootstrapCI(perQuery, { iters: 10000 }) };
  }
}

// deltas appariés (vs bm25 = baseline lexicale)
const deltas = {};
for (const sys of Object.keys(systems)) {
  if (sys === 'bm25') continue;
  deltas[`${sys} − bm25`] = {};
  for (const [name] of METRICS) {
    deltas[`${sys} − bm25`][name] = pairedDelta(results[sys][name].perQuery, results.bm25[name].perQuery, { iters: 10000 });
  }
}

// ---------- rapport ----------
const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const runDir = path.join(ROOT, 'results', `retrieval-${TAG}-${ts}`);
fs.mkdirSync(runDir, { recursive: true });

const pct = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}`);
const fmtAgg = (m) => (m ? `${pct(m.mean)} % [${pct(m.lo)} ; ${pct(m.hi)}]` : 'n/a');

const md = [
  `# Benchmark retrieval — brique Immune (${MODE})`, '',
  `Run : ${ts} · ${queries.length} queries · corpus ${docs.length} docs · topk ${TOPK}`, '',
  `Systèmes : ${Object.keys(systems).join(', ')}`, '',
  '## Scores absolus (moyenne [IC 95 % bootstrap par query])', '',
  '| système | ' + METRICS.map(([n]) => n).join(' | ') + ' | latence |',
  '|---|' + METRICS.map(() => '---').join('|') + '|---|',
  ...Object.entries(systems).map(([sys, { ms }]) =>
    `| **${sys}** | ${METRICS.map(([n]) => fmtAgg(results[sys][n].agg)).join(' | ')} | ${ms} ms |`), '',
  '## Deltas appariés vs bm25 (baseline lexicale)', '',
  '| comparaison | métrique | Δ moyen [IC 95 %] | Wilcoxon p | n |', '|---|---|---|---|---|',
  ...Object.entries(deltas).flatMap(([cmp, byMetric]) =>
    Object.entries(byMetric).map(([name, d]) =>
      `| ${cmp} | ${name} | ${(100 * d.mean).toFixed(1)} pts [${(100 * d.lo).toFixed(1)} ; ${(100 * d.hi).toFixed(1)}] | ${d.wilcoxonP < 1e-4 ? d.wilcoxonP.toExponential(1) : d.wilcoxonP.toFixed(4)} | ${d.n} |`)), '',
  '## Méthodo', '',
  '- **Apparié** : chaque système voit les mêmes queries et les mêmes qrels → delta par query, Wilcoxon signed-rank.',
  '- **IC 95 %** : bootstrap par query (la query est le cluster naturel), 10 000 rééchantillonnages, graine fixe (déterministe).',
  MODE === 'real' ? '- **Qrels** : pooling top-20/brique + jugement lexicon figé (voir qrels-immune.tsv, sha256 au rapport) — biais de pooling standard : les docs hors pool sont réputés non pertinents.' : '- **Qrels** : tags de catégorie du fixture (vérité terrain exacte — valide la méthodologie, pas le retrieval réel).',
  '- **Déterminisme** : BM25 et fusions exacts ; embeddings GPU reproductibles à redémarrage égal, écarts float révélés dans runs.json.',
];
fs.writeFileSync(path.join(runDir, 'report.md'), md.join('\n'));
fs.writeFileSync(path.join(runDir, 'metrics.json'), JSON.stringify({
  ts, mode: MODE, topk: TOPK, nQueries: queries.length, corpusSize: docs.length,
  daemon: health ? { device: health.device, bi: health.models.biEncoder, ce: health.models.crossEncoder } : null,
  systems: Object.fromEntries(Object.entries(results).map(([s, m]) => [s, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.agg]))])),
  deltas,
  latencyMs: Object.fromEntries(Object.entries(systems).map(([s, v]) => [s, v.ms])),
}, null, 2));
const runsByQuery = Object.fromEntries(queries.map((q, i) => [
  q.id,
  Object.fromEntries(Object.entries(systems).map(([s, { list }]) => [s, list[i]])),
]));
fs.writeFileSync(path.join(runDir, 'runs.json'), JSON.stringify(runsByQuery, null, 2));

console.log(`\n── SYNTHÈSE (${runDir}) ──`);
for (const [sys, { ms }] of Object.entries(systems)) {
  const r = results[sys];
  console.log(`  ${sys.padEnd(8)} recall@10=${pct(r['recall@10'].agg.mean)} %  mrr@10=${pct(r['mrr@10'].agg.mean)} %  ndcg@10=${pct(r['ndcg@10'].agg.mean)} %  (${ms} ms)`);
}
console.log(`\n  rapport : ${path.join(runDir, 'report.md')}\n`);
