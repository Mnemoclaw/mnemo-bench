// corpus.mjs — chargement des corpus pour le bench retrieval.
// Deux sources : corpus RÉEL (immune_memory.json + cheatsheet_memory.json de la
// production, données privées — jamais commitées) et corpus FIXTURE (synthétique,
// généré depuis les lexicons — commité, CI-safe).

import fs from 'node:fs';

// Corpus réel : 498 anticorps + 269 stratégies → docs {id, text, domains, type}
export function loadRealCorpus({ immunePath, cheatsheetPath }) {
  const docs = [];
  const imm = JSON.parse(fs.readFileSync(immunePath, 'utf8'));
  for (const ab of imm.antibodies || []) {
    docs.push({
      id: `antibody:${ab.id}`,
      text: `${ab.pattern || ''} ${ab.correction || ''}`.trim(),
      domains: ab.domains || [],
      type: 'antibody',
      severity: ab.severity || null,
    });
  }
  const cs = JSON.parse(fs.readFileSync(cheatsheetPath, 'utf8'));
  for (const st of cs.strategies || []) {
    docs.push({
      id: `strategy:${st.id}`,
      text: `${st.pattern || ''} ${st.example || ''}`.trim(),
      domains: st.domains || [],
      type: 'strategy',
      severity: null,
    });
  }
  return docs.filter((d) => d.text.length > 10);
}

// Corpus fixture : JSONL {id, category, text} — qrels = tags de catégorie
export function loadFixtureCorpus(path) {
  return fs.readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// Queries : [{id, query, domain, expected_category, lexicon:[…]}]
export function loadQueries(path) {
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  return j.queries || j;
}
