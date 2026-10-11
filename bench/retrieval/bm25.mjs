// bm25.mjs — baseline lexicale Okapi BM25 pure JS, déterministe, 0 dépendance.
// Sert de référence publication-standard (lexical vs sémantique) et de système CI-safe.
// Tokenisation : minuscule + suppression des accents (fr/en) + split non-alphanumérique.

export function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
export const tokenize = (text) => normalize(text).split(' ').filter(Boolean);

export class BM25 {
  constructor(docs, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs; // [{id, text, …}]
    this.tfs = [];    // Map terme → tf, par doc
    this.dfs = new Map();
    this.docLen = [];
    this.avgLen = 0;
    const N = docs.length;
    for (const d of docs) {
      const toks = tokenize(d.text);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      this.tfs.push(tf);
      this.docLen.push(toks.length);
      for (const t of tf.keys()) this.dfs.set(t, (this.dfs.get(t) || 0) + 1);
    }
    this.avgLen = this.docLen.reduce((a, b) => a + b, 0) / (N || 1);
  }

  // Renvoie les docs classés par score BM25 décroissant : [{id, score}]
  search(query, k = 10) {
    const qTerms = tokenize(query);
    const N = this.docs.length;
    const scores = new Map();
    for (const t of new Set(qTerms)) {
      const df = this.dfs.get(t) || 0;
      if (!df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < N; i++) {
        const f = this.tfs[i].get(t);
        if (!f) continue;
        const norm = f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + this.b * this.docLen[i] / this.avgLen));
        scores.set(i, (scores.get(i) || 0) + idf * norm);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([i, score]) => ({ id: this.docs[i].id, score }));
  }
}

// RRF standard (k=60, identique au contrat production de immune-adapter.js)
// Accepte des listes d'ids strings OU d'objets {id}; le tag engine vient de
// list.engineTag ou de la position de la liste. weights[] optionnel par liste
// (défaut égalitaire = production) — wRRF = variante pondérée pour l'expérience H-R2.
export function reciprocalRankFusion(rankedLists, { k = 60, limit = 10, weights = null } = {}) {
  const scores = new Map();
  rankedLists.forEach((list, li) => {
    const tag = list.engineTag || `engine${li}`;
    const w = weights ? weights[li] : 1;
    for (let rank = 0; rank < list.length; rank++) {
      const raw = list[rank];
      const id = typeof raw === 'string' ? raw : raw?.id;
      if (id == null) continue;
      if (!scores.has(id)) scores.set(id, { id, rrf: 0, engines: [] });
      const e = scores.get(id);
      e.rrf += w / (k + rank + 1);
      if (!e.engines.includes(tag)) e.engines.push(tag);
    }
  });
  return [...scores.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
}
