// validators.mjs — validateurs structurels des étapes Chimera (fonctions pures, 0 LLM).
// Contracts issus des prompts des agents (chimera-slime-expand/prune, chimera-prism-*).
// Rôle CI : gate déterministe — toute sortie de pipeline peut être re-validée offline.

// ---------- Slime Mold : expansion ----------
export function validateExpansion(tree, { maxBranches = 8 } = {}) {
  const errors = [];
  if (!tree || typeof tree !== 'object') return { ok: false, errors: ['tree absent ou non-objet'] };
  if (!Array.isArray(tree.branches) || tree.branches.length === 0) errors.push('branches absent ou vide');
  else {
    if (tree.branches.length > maxBranches) errors.push(`${tree.branches.length} branches > maxBranches=${maxBranches}`);
    tree.branches.forEach((b, i) => {
      const tag = `branch[${i}](${b.approach || '?'})`;
      if (!b.approach || typeof b.approach !== 'string') errors.push(`${tag}: approach manquant`);
      if (typeof b.description !== 'string' || b.description.length < 10) errors.push(`${tag}: description trop courte`);
      if (!Array.isArray(b.sub_options) || b.sub_options.length < 1) errors.push(`${tag}: sub_options vide`);
      else b.sub_options.forEach((s, j) => {
        if (!s.name) errors.push(`${tag}.sub[${j}]: name manquant`);
        if (typeof s.compatibility_score !== 'number' || s.compatibility_score < 0 || s.compatibility_score > 1)
          errors.push(`${tag}.sub[${j}]: compatibility_score hors [0,1]`);
      });
      if (typeof b.compatibility_score !== 'number' || b.compatibility_score < 0 || b.compatibility_score > 1)
        errors.push(`${tag}: compatibility_score hors [0,1]`);
    });
  }
  if (typeof tree.total_combinations !== 'number' || tree.total_combinations < (tree.branches?.length || 0))
    errors.push('total_combinations incohérent (< nb branches)');
  return { ok: errors.length === 0, errors };
}

// ---------- Slime Mold : élagage ----------
// Règles de l'agent prune : 3-5 branches survivantes, AUCUNE branche inventée,
// pas de doublons, scores préservés depuis l'arbre source.
export function validatePruned(pruned, originalTree, { viableMin = 3, viableMax = 5 } = {}) {
  const errors = [];
  const list = pruned?.pruned_branches;
  if (!Array.isArray(list)) return { ok: false, errors: ['pruned_branches absent'] };
  if (list.length < viableMin || list.length > viableMax)
    errors.push(`${list.length} branches survivantes hors bornes [${viableMin},${viableMax}]`);
  const src = new Map((originalTree?.branches || []).map((b) => [b.approach, b]));
  const seen = new Set();
  for (const b of list) {
    if (!src.has(b.approach)) errors.push(`branche inventée (absente de l'expansion) : ${b.approach}`);
    if (seen.has(b.approach)) errors.push(`doublon : ${b.approach}`);
    seen.add(b.approach);
    const orig = src.get(b.approach);
    if (orig && typeof b.compatibility_score === 'number' && Math.abs(b.compatibility_score - orig.compatibility_score) > 1e-9)
      errors.push(`score altéré pour ${b.approach} : ${b.compatibility_score} ≠ ${orig.compatibility_score}`);
    if (!Array.isArray(b.sub_options) || b.sub_options.length < 1) errors.push(`${b.approach}: sub_options vide après prune`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------- PRISM : distinctness des perspectives ----------
// Jaccard distance sur tokens (déterministe, CI-safe) ou distance cosinus si embedFn fourni.
// Retourne métriques + verdict : mean < seuil ⇒ perspectives effondrées (trop similaires).
export function perspectiveDistinctness(solutions, { embedFn = null, threshold = 0.5 } = {}) {
  if (!Array.isArray(solutions) || solutions.length < 2) return { ok: false, errors: ['< 2 solutions'] };
  const texts = solutions.map((s) => JSON.stringify(s.solution || s));
  const dist = async (a, b) => {
    if (embedFn) return 1 - (await embedFn(a, b)); // cos distance
    const A = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const B = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const inter = [...A].filter((w) => B.has(w)).length;
    const union = new Set([...A, ...B]).size;
    return union ? 1 - inter / union : 1;
  };
  if (!embedFn) {
    const dists = [];
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) dists.push({ i, j, d: 0 });
    // calcul synchrone (jaccard)
    const tok = (t) => new Set(t.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const sets = texts.map(tok);
    for (const pair of dists) {
      const inter = [...sets[pair.i]].filter((w) => sets[pair.j].has(w)).length;
      const union = new Set([...sets[pair.i], ...sets[pair.j]]).size;
      pair.d = union ? 1 - inter / union : 1;
    }
    const mean = dists.reduce((a, p) => a + p.d, 0) / dists.length;
    const minPair = dists.reduce((m, p) => (p.d < m.d ? p : m), dists[0]);
    return { ok: mean >= threshold, mean, minPair, method: 'jaccard', threshold, errors: mean < threshold ? [`perspectives effondrées : distance moyenne ${mean.toFixed(3)} < ${threshold}`] : [] };
  }
  return (async () => {
    const dists = [];
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) dists.push({ i, j, d: await dist(texts[i], texts[j]) });
    const mean = dists.reduce((a, p) => a + p.d, 0) / dists.length;
    const minPair = dists.reduce((m, p) => (p.d < m.d ? p : m), dists[0]);
    return { ok: mean >= threshold, mean, minPair, method: 'cosine', threshold, errors: mean < threshold ? [`perspectives effondrées : distance moyenne ${mean.toFixed(3)} < ${threshold}`] : [] };
  })();
}

// ---------- PRISM : fusion du compilateur ----------
// Règles du meta-agent : PAS de résumé (« Perspective 1 said »), PAS de copie d'une source,
// nouveauté trigram bornée (trop bas = copie, trop haut = invention), longueur plausible.
export function validateFusion(compiled, sources, { textKey = 'summary' } = {}) {
  const errors = [], warnings = [];
  const text = typeof compiled === 'string' ? compiled : String(compiled?.solution?.[textKey] || compiled?.summary || JSON.stringify(compiled));
  const srcTexts = sources.map((s) => String(typeof s === 'string' ? s : s?.solution?.[textKey] || s?.summary || JSON.stringify(s)));
  if (srcTexts.some((s) => s.trim() === text.trim())) errors.push('fusion = copie intégrale d\'une source');
  if (/perspective\s*\d+\s*(said|a dit|recommande)/i.test(text)) errors.push('structure de résumé détectée (« Perspective N said »)');
  const trigrams = (t) => { const w = t.toLowerCase().split(/\W+/).filter(Boolean); const s = new Set(); for (let i = 0; i < w.length - 2; i++) s.add(w.slice(i, i + 3).join(' ')); return s; };
  const tg = trigrams(text);
  const srcTg = new Set(srcTexts.flatMap(trigrams));
  const novelty = tg.size ? [...tg].filter((g) => !srcTg.has(g)).length / tg.size : 0;
  if (novelty < 0.1) warnings.push(`nouveauté trigram très basse (${(novelty * 100).toFixed(0)} %) — quasi-copie`);
  if (novelty > 0.9) warnings.push(`nouveauté trigram très haute (${(novelty * 100).toFixed(0)} %) — possible invention hors sources`);
  const lenOK = text.length >= 0.5 * Math.min(...srcTexts.map((s) => s.length)) && text.length <= 2.2 * (srcTexts.reduce((a, s) => a + s.length, 0) / srcTexts.length);
  if (!lenOK) warnings.push(`longueur de la fusion (${text.length}) hors plage plausible des sources`);
  const listLines = text.split('\n').filter((l) => /^\s*[-*•]\s/.test(l)).length;
  if (text.split('\n').length > 4 && listLines / text.split('\n').length > 0.6) warnings.push('structure dominée par les puces — suspect pour une fusion « woven »');
  return { ok: errors.length === 0, errors, warnings, novelty };
}
