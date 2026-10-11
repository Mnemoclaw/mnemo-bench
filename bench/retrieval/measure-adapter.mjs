#!/usr/bin/env node
// measure-adapter.mjs — mesure RAPIDE du chemin de production (adapter CLI) sur les qrels figées.
// Ne ré-embed rien côté bench : l'adapter utilise son propre cache (daemon chaud).
// Usage : node measure-adapter.mjs --label w2
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { recallAtK, mrrAtK, ndcgAtK } from '../../lib/stats.mjs';
import { adapterSearch } from './daemon-client.mjs';

const args = process.argv.slice(2);
const label = args[args.indexOf('--label') + 1] || 'run';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const queries = JSON.parse(fs.readFileSync(path.join(HERE, 'queries-immune.json'), 'utf8')).queries;
const qrels = {};
for (const l of fs.readFileSync(path.join(HERE, '..', '..', 'results', 'qrels-immune-adjudicated.tsv'), 'utf8').split('\n')) {
  if (!l.trim() || l.startsWith('#')) continue;
  const [qid, docid, g] = l.split('\t');
  (qrels[qid] ??= new Map()).set(docid, parseInt(g, 10));
}

const R = [], M = [], N = [];
for (const q of queries) {
  const ids = await adapterSearch(q.query, 10);
  const g = qrels[q.id] || new Map();
  R.push(recallAtK(ids, g, 10)); M.push(mrrAtK(ids, g, 10)); N.push(ndcgAtK(ids, g, 10));
}
const avg = (a) => (100 * a.filter(x => x != null).reduce((x, y) => x + y, 0) / a.filter(x => x != null).length).toFixed(1);
console.log(`ADAPTER [${label}]  recall@10=${avg(R)}%  mrr@10=${avg(M)}%  ndcg@10=${avg(N)}%`);
