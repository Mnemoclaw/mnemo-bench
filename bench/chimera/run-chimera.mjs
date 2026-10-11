#!/usr/bin/env node
// run-chimera.mjs — harnais Chimera : contrats structurels sur sorties LIVE + bras comportemental.
// Endpoint par défaut : qwen local (http://127.0.0.1:11434/v1) — 0 token cloud.
//
//   --mode structural   : 6 tâches × pipeline (expand→prune→perspectives→compile),
//                         validation contracts offline (H-S1, H-S2), raw archivé
//   --mode behavioral   : bras baseline vs chimera-full, juge aveugle, Wilcoxon + Holm (H-C1..C3)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateExpansion, validatePruned, perspectiveDistinctness, validateFusion } from './validators.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const QWEN = process.env.QWEN_BASE_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.QWEN_MODEL || 'qwen';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true); };
const MODE = String(flag('mode', 'structural'));
const SEEDS = Math.max(1, parseInt(flag('seeds', '3'), 10));
const ONLY = String(flag('tasks', 'all')).split(',').map((s) => s.trim());
const taskFilter = (t) => ONLY.includes('all') || ONLY.includes(t.id);

// ---------- tâches figées (6 tâches × 3 domaines) ----------
const TASKS = [
  { id: 'code-001', domain: 'code', goal: 'secure', task: 'Design the authentication layer for a multi-tenant SaaS API (Node.js), constraint: no external auth provider, latency budget 50 ms p99.' },
  { id: 'code-002', domain: 'code', goal: 'scalability', task: 'Design the job queue for 10k video render jobs/day on 3 GPUs, constraint: idempotent retries, no paid services.' },
  { id: 'code-003', domain: 'code', goal: 'maintainability', task: 'Refactor a 4k-line Express monolith into modules, constraint: zero downtime, keep API compatible.' },
  { id: 'fitness-001', domain: 'fitness', goal: 'muscle', task: 'Program a 4-day/week hypertrophy plan for an intermediate lifter, constraint: 60 min sessions, full gym.' },
  { id: 'fitness-002', domain: 'fitness', goal: 'endurance', task: 'Plan a 10-week running block from 5k to 21k, constraint: 3 sessions/week, no injury history.' },
  { id: 'writing-001', domain: 'writing', goal: 'seo', task: 'Outline a 1500-word SEO article on home espresso, constraint: H2 structure, 8 keywords, no fluff.' },
];
const PERSPECTIVES = {
  code: ['security', 'maintainability', 'scalability'],
  fitness: ['volume', 'recovery', 'balance'],
  writing: ['seo', 'readability', 'structure'],
};

// ---------- appel LLM (non-streaming suffit, thinking coupé) ----------
async function callLLM(messages, { temperature = 0.2, maxTokens = 4000 } = {}) {
  const res = await fetch(`${QWEN}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature, max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
      messages,
    }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const txt = j.choices?.[0]?.message?.content || '';
  if (!txt.trim()) throw new Error('réponse vide');
  return txt;
}
const extractJson = (t) => {
  const m = t.match(/```json\n([\s\S]*?)```/) || t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0].replace(/^```json\n|```$/g, '')); } catch { return null; }
};

const EXPAND_PROMPT = (t) => `You are an exploration agent inspired by Physarum polycephalum: explore ALL viable paths before any pruning.\nTask: ${t.task}\nGenerate 4-6 distinct approaches as STRICT JSON:\n{"domain":"…","task_summary":"…","branches":[{"approach":"…","description":"…","sub_options":[{"name":"…","details":"…","alternatives":["…"],"requirements":["…"],"compatibility_score":0.0}],"compatibility_score":0.0}],"total_combinations":0,"expansion_notes":"…"}`;
const PRUNE_PROMPT = (t, tree) => `You are a pruning agent (Physarum retraction phase). Task constraints: ${t.task}\nExpansion tree:\n${JSON.stringify(tree).slice(0, 6000)}\nCut branches violating constraints, contradicting goals, redundant, over budget, needing unavailable resources, or overcomplex. Keep 3-5 viable branches. Return STRICT JSON: {"pruned_branches":[{"approach":"…","description":"…","sub_options":[…],"compatibility_score":0.0}]}`;
const PERSP_PROMPT = (t, pruned, p) => `You are the "${p}" perspective agent. Task: ${t.task}\nViable options (ONLY source of truth):\n${JSON.stringify(pruned).slice(0, 5000)}\nBuild a complete solution from your perspective. STRICT JSON: {"perspective":"${p}","solution":{"summary":"…","key_decisions":[{"decision":"…","rationale":"…","trade_off":"…"}]}}`;
const COMPILE_PROMPT = (t, sols) => `You are a Structural Architect implementing meritocratic arbitrage — NOT a summarizer. Task: ${t.task}\nN perspective solutions:\n${JSON.stringify(sols).slice(0, 12000)}\nAnchor on the strongest structural foundation; extract only non-redundant value from others; higher-priority perspective wins contradictions. NEVER write "Perspective N said". Output a single fused solution.`;

// ---------- mode structural ----------
async function structural() {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const runDir = path.join(ROOT, 'results', `chimera-structural-${ts}`);
  fs.mkdirSync(path.join(runDir, 'raw'), { recursive: true });
  const rows = [];
  for (const t of TASKS.filter(taskFilter)) {
    const row = { taskId: t.id, checks: {} };
    try {
      const rawExp = await callLLM([{ role: 'user', content: EXPAND_PROMPT(t) }]);
      const tree = extractJson(rawExp);
      row.checks.expand = validateExpansion(tree);
      fs.writeFileSync(path.join(runDir, 'raw', `expand-${t.id}.json`), rawExp);
      if (!row.checks.expand.ok) { rows.push(row); continue; }

      const rawPrune = await callLLM([{ role: 'user', content: PRUNE_PROMPT(t, tree) }]);
      const pruned = extractJson(rawPrune);
      row.checks.prune = { ...validatePruned(pruned, tree) };
      fs.writeFileSync(path.join(runDir, 'raw', `prune-${t.id}.json`), rawPrune);
      if (!row.checks.prune.ok) { rows.push(row); continue; }

      const persps = PERSPECTIVES[t.domain];
      const sols = [];
      for (const p of persps) {
        sols.push(extractJson(await callLLM([{ role: 'user', content: PERSP_PROMPT(t, pruned, p) }])) || {}); // extractJson renvoie déjà l'objet parsé
      }
      row.checks.distinctness = await perspectiveDistinctness(sols, { threshold: 0.5 });

      const rawComp = await callLLM([{ role: 'user', content: COMPILE_PROMPT(t, sols) }], { maxTokens: 6000 });
      fs.writeFileSync(path.join(runDir, 'raw', `compile-${t.id}.json`), rawComp);
      row.checks.fusion = validateFusion(rawComp, sols.map((s) => JSON.stringify(s)));
    } catch (e) { row.error = e.message; }
    rows.push(row);
    const okAll = Object.values(row.checks || {}).every((c) => c?.ok !== false);
    console.log(`  ${t.id.padEnd(14)} ${row.error ? '⚠️ ' + row.error : okAll ? '✅ contrats OK' : '❌ ' + JSON.stringify(Object.entries(row.checks).filter(([, c]) => c?.ok === false).map(([k]) => k))}`);
  }
  const nOk = rows.filter((r) => !r.error && Object.values(r.checks).every((c) => c?.ok !== false)).length;
  fs.writeFileSync(path.join(runDir, 'metrics.json'), JSON.stringify({ ts, mode: 'structural', tasks: TASKS.length, contractPass: nOk, rows }, null, 2));
  console.log(`\nH-S1 contrats : ${nOk}/${TASKS.length} pipelines conformes → ${runDir}`);
}

// ---------- mode behavioral (campagne gated — Wilcoxon sur scores juge) ----------
async function behavioral() {
  const { pairedDelta } = await import('../../lib/stats.mjs');
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const runDir = path.join(ROOT, 'results', `chimera-behavioral-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });
  const JUDGE = (out, t) => `You are a blind grader. Grade this solution on the task below. Rubric 1-5: structure & completeness (50%), constraint compliance (50%). Answer ONLY JSON {"score": <1-5>}.\nTASK: ${t.task}\nSOLUTION:\n${out.slice(0, 6000)}`;
  const rows = [];
  for (const t of TASKS.filter(taskFilter)) {
    for (let s = 1; s <= SEEDS; s++) {
      const seedTemp = { temperature: 0.2 };
      // bras baseline : réponse unique directe
      const base = await callLLM([{ role: 'user', content: t.task }], seedTemp).catch((e) => `ERR:${e.message}`);
      // bras chimera-full : pipeline complet (réutilise structural en inline)
      let chim = `ERR:no-run`;
      try {
        const tree = extractJson(await callLLM([{ role: 'user', content: EXPAND_PROMPT(t) }], seedTemp));
        const pruned = extractJson(await callLLM([{ role: 'user', content: PRUNE_PROMPT(t, tree) }], seedTemp));
        const sols = [];
        for (const p of PERSPECTIVES[t.domain]) sols.push(extractJson(await callLLM([{ role: 'user', content: PERSP_PROMPT(t, pruned, p) }], seedTemp)));
        chim = await callLLM([{ role: 'user', content: COMPILE_PROMPT(t, sols) }], { maxTokens: 6000 });
      } catch (e) { chim = `ERR:${e.message}`; }
      const jBase = extractJson(await callLLM([{ role: 'user', content: JUDGE(base, t) }], seedTemp))?.score ?? null;
      const jChim = extractJson(await callLLM([{ role: 'user', content: JUDGE(chim, t) }], seedTemp))?.score ?? null;
      rows.push({ taskId: t.id, seed: s, baseline: base.slice(0, 400), chimera: chim.slice(0, 400), jBaseline: jBase, jChimera: jChim });
      console.log(`  ${t.id} s${s}  judge baseline=${jBase}  chimera=${jChim}`);
    }
  }
  const valid = rows.filter((r) => r.jBaseline != null && r.jChimera != null);
  const delta = pairedDelta(valid.map((r) => r.jChimera), valid.map((r) => r.jBaseline), { iters: 10000 });
  fs.writeFileSync(path.join(runDir, 'metrics.json'), JSON.stringify({ ts, mode: 'behavioral', rows, delta, n: valid.length }, null, 2));
  console.log(`\nH-C1 Δ(chimera−baseline) = ${delta.mean.toFixed(2)} [${delta.lo.toFixed(2)};${delta.hi.toFixed(2)}] Wilcoxon p=${delta.wilcoxonP.toFixed(4)} (n=${delta.n})`);
}

(MODE === 'behavioral' ? behavioral() : structural()).catch((e) => { console.error(e); process.exit(1); });
