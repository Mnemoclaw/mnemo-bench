#!/usr/bin/env node
// adjudicate-qwen.mjs — second juge de pertinence = qwen local (port 11434), temp 0.
// Pour chaque paire (query, doc) du pool : le juge lexicon a déjà noté 0/1/2 ;
// qwen note indépendamment (règle stricte, JSON) → κ de Cohen(lexicon, qwen)
// + fusion conservatrice : 2 si les DEUX = 2, 0 si les DEUX = 0, sinon 1 (incertain).
// Sortie : qrels-immune-adjudicated.tsv (format identique → consommé par --qrels)
//          + kappa-report.md (accord inter-juges = fiabilité d'annotation, publiable).
//
// Usage : node adjudicate-qwen.mjs [--qrels results/qrels-immune.tsv] [--conc 8]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQueries, loadRealCorpus, loadFixtureCorpus } from './corpus.mjs';
import { cohensKappa } from '../../lib/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const QWEN = process.env.QWEN_BASE_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.QWEN_MODEL || 'qwen';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true); };
const QRELS = String(flag('qrels', path.join(ROOT, 'results', 'qrels-immune.tsv')));
const CONC = Math.max(1, parseInt(flag('conc', '8'), 10));

// ---------- chargement ----------
const queries = loadQueries(path.join(HERE, 'queries-immune.json'));
const byId = new Map();
const immunePath = process.env.IMMUNE_MEMORY || path.join(os.homedir(), '.claude', 'skills', 'immune', 'immune_memory.json');
for (const d of loadRealCorpus({ immunePath, cheatsheetPath: immunePath.replace('immune_memory.json', 'cheatsheet_memory.json') })) byId.set(d.id, d.text);
try { for (const d of loadFixtureCorpus(path.join(HERE, 'fixture-corpus.jsonl'))) if (!byId.has(d.id)) byId.set(d.id, d.text); } catch { /* pas de fixture */ }
if (!fs.existsSync(QRELS)) { console.error(`qrels introuvables : ${QRELS}`); process.exit(1); }

const pairs = fs.readFileSync(QRELS, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => { const [qid, docid, grade] = l.split('\t'); return { qid, docid, lex: parseInt(grade, 10) }; });
console.log(`\nADJUDICATION QWEN — ${pairs.length} paires (query,doc), conc=${CONC}, modèle=${MODEL}`);
const qById = new Map(queries.map((q) => [q.id, q]));

// ---------- appel qwen ----------
const RUBRIC = `You are a relevance judge for a retrieval benchmark. Given a QUERY describing a technical problem and a DOCUMENT describing a known error pattern (pattern + correction), grade:
2 = the document's pattern directly addresses the failure described in the query (the fix is the one the query needs)
1 = same technical domain, but the document addresses a DIFFERENT failure than the query
0 = unrelated
Answer with ONLY this JSON: {"grade": <0|1|2>}`;

async function judge({ qid, docid }) {
  const q = qById.get(qid);
  const doc = byId.get(docid) || '';
  const body = {
    model: MODEL, temperature: 0, max_tokens: 80,
    chat_template_kwargs: { enable_thinking: false }, // qwen3.8 : coupe le reasoning → ~2 s/appel au lieu de ~20 s
    messages: [
      { role: 'system', content: RUBRIC },
      { role: 'user', content: `QUERY: ${q?.query || qid}\n\nDOCUMENT: ${doc.slice(0, 900)}` },
    ],
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${QWEN}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
      });
      const j = await res.json();
      const msg = j.choices?.[0]?.message || {};
      const content = msg.content || '';
      const reasoning = msg.reasoning_content || '';
      // 1) JSON strict dans content ; 2) mention « grade: X » ; 3) dernier recours : digit isolé
      const m = content.match(/\{\s*"grade"\s*:\s*([012])/)
        || content.match(/([012])/)
        || reasoning.match(/grade["'\s:]*([012])/)
        || (content + reasoning).match(/\b([012])\b/);
      return m ? parseInt(m[1], 10) : -1;
    } catch (e) {
      if (attempt === 3) return -2; // erreur définitive
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

// ---------- boucle avec concurrence ----------
const results = new Array(pairs.length);
let next = 0, done = 0;
const worker = async () => {
  for (;;) {
    const i = next++;
    if (i >= pairs.length) return;
    results[i] = { ...pairs[i], qwen: await judge(pairs[i]) };
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${pairs.length} jugées…`);
  }
};
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(CONC, pairs.length) }, worker));
const errs = results.filter((r) => r.qwen < 0).length;
console.log(`  terminé en ${((Date.now() - t0) / 1000).toFixed(0)} s (${errs} erreurs API)`);

// ---------- κ + fusion ----------
const valid = results.filter((r) => r.qwen >= 0);
const labels = ['0', '1', '2'];
const k = cohensKappa(valid.map((r) => String(r.lex)), valid.map((r) => String(r.qwen)), labels);
const fuse = (a, b) => (a === 2 && b === 2 ? 2 : a === 0 && b === 0 ? 0 : 1);
const agreement = valid.filter((r) => r.lex === r.qwen).length / (valid.length || 1);

const out = ['# qrels-immune adjudiquées — lexicon × qwen local, fusion conservatrice', `# généré: ${new Date().toISOString()}`, '# grade final: 2 si les deux juges=2, 0 si les deux=0, sinon 1'];
for (const r of results) out.push(`${r.qid}\t${r.docid}\t${r.qwen < 0 ? 1 : fuse(r.lex, r.qwen)}\t# lex=${r.lex} qwen=${r.qwen}`);
const outPath = QRELS.replace(/([^/\\]+)\.tsv$/, 'qrels-immune-adjudicated.tsv').replace('qrels-immune', 'qrels-immune-adjudicated');
fs.writeFileSync(path.join(ROOT, 'results', 'qrels-immune-adjudicated.tsv'), out.join('\n') + '\n');

const md = [
  '# Fiabilité d\'annotation — κ de Cohen (lexicon × qwen local)', '',
  `Paires jugées : ${valid.length} (${errs} erreurs API exclues) · modèle : ${MODEL} · temp 0`, '',
  `| accord observé po | accord attendu pe | **κ de Cohen** | interprétation (Landis-Koch) |`,
  `|---|---|---|---|`,
  `| ${(k.po * 100).toFixed(1)} % | ${(k.pe * 100).toFixed(1)} % | **${k.kappa.toFixed(3)}** | ${k.kappa >= 0.8 ? 'très bon' : k.kappa >= 0.6 ? 'substantiel' : k.kappa >= 0.4 ? 'modéré' : 'faible'} |`, '',
  `Accord brut par paire : ${(agreement * 100).toFixed(1)} %`, '',
  'Fusion conservatrice : grade final = 2 si les DEUX juges disent 2, 0 si les DEUX disent 0, sinon 1 (incertain).',
  'Les qrels finales : `results/qrels-immune-adjudicated.tsv` — le bench retrieval doit être relancé avec `--qrels` sur ce fichier.',
];
fs.writeFileSync(path.join(ROOT, 'results', 'kappa-report.md'), md.join('\n'));
console.log(`\nκ de Cohen (lexicon × qwen) = ${k.kappa.toFixed(3)}  (po=${(k.po * 100).toFixed(1)}%, pe=${(k.pe * 100).toFixed(1)}%)`);
console.log(`→ ${path.join(ROOT, 'results', 'qrels-immune-adjudicated.tsv')}`);
