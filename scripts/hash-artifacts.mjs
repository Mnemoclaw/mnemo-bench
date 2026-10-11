#!/usr/bin/env node
// hash-artifacts.mjs — manifeste SHA-256 de tous les artefacts du protocole.
// Preuve d'intégrité publiable : « exactement ces bits ont produit ces chiffres ».
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const P = (r) => path.join(ROOT, '..', r);

const ARTIFACTS = [
  'prereg/prereg.yaml',
  'bench/retrieval/queries-immune.json',
  'bench/retrieval/fixture-corpus.jsonl',
  'bench/retrieval/bm25.mjs',
  'bench/retrieval/corpus.mjs',
  'bench/retrieval/run-retrieval.mjs',
  'bench/retrieval/adjudicate-qwen.mjs',
  'bench/retrieval/daemon-client.mjs',
  'bench/chimera/validators.mjs',
  'lib/stats.mjs',
];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const manifest = {
  generated: new Date().toISOString(),
  node: process.version,
  artifacts: Object.fromEntries(ARTIFACTS.map((rel) => {
    const f = P(rel);
    return [rel, fs.existsSync(f) ? sha(f) : 'ABSENT'];
  })),
};
if (fs.existsSync(P('results/qrels-immune-adjudicated.tsv'))) {
  manifest.artifacts['results/qrels-immune-adjudicated.tsv'] = sha(P('results/qrels-immune-adjudicated.tsv'));
}
fs.mkdirSync(P('results'), { recursive: true });
fs.writeFileSync(P('results/manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest.json : ${Object.keys(manifest.artifacts).length} artefacts hashés (sha256)`);
