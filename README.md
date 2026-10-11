# mnemo-bench — benchmarks de qualité pro des briques MnemoClaw

Frameworks de benchmarks **reproductibles, pré-enregistrés, publication-grade** pour toutes les
briques bio-inspirées de MnemoClaw. Zéro dépendance npm, stats vérifiées par tests de propriétés,
CI GitHub Actions gratuite (0 API) + campagnes LLM gated.

## Les briques couvertes

| Brique | Inspiration biologique | Bench | Type |
|---|---|---|---|
| **Immune** (mémoire anticorps+stratégies) | système immunitaire adaptatif | retrieval IR + double-aveugle (repo séparé) | déterministe + comportemental |
| **Slime Mold** (explore→prune) | *Physarum polycephalum* | contrats structurels expand/prune | déterministe |
| **PRISM** (N perspectives→compile) | multiplicité + arbitrage méritocratique | distinctness + fusion | déterministe + comportemental |
| **Chimera** (pipeline complet) | chimère des 3 | lift vs baseline, juge aveugle | comportemental (gated) |

## Architecture (2 tiers par reproductibilité)

```
Tier 1 — DÉTERMINISTE (chaque push/PR, < 1 min, 0 API, 0 GPU)   ← ci.yml
  lib/stats.mjs               Wilson, Fisher, Holm, permutation, cluster bootstrap,
                              MRR/Recall/nDCG/P@k, kappa, McNemar, Wilcoxon → 40 tests
  bench/retrieval/            benchmark IR (fixture CI-safe / corpus réel privé)
  bench/chimera/validators.mjs contrats Slime Mold + PRISM (fonctions pures, fixtures)

Tier 2 — COMPORTEMENTAL (workflow_dispatch, self-hosted, LLM local par défaut)  ← campaign.yml
  bench/chimera/run-chimera.mjs        pipeline live + bras + juge aveugle (qwen local)
  bench/retrieval/adjudicate-qwen.mjs  second juge qrels (κ de Cohen, fusion conservatrice)
```

## Méthodes (celles des publications)

- **Qrels par pooling + double jugement** : pool = top-20 par système, juge lexicon × juge LLM
  (qwen local, temp 0), κ de Cohen rapporté comme fiabilité d'annotation, fusion conservatrice.
  Biais de pooling déclaré. — méthode type TREC
- **Métriques IR** : Recall@k, MRR@k, nDCG@k (gains gradués), P@k, IC 95 % **bootstrap par query**
  (la query = cluster naturel), 10 000 rééchantillonnages, graine xorshift fixe.
- **Comparaisons appariées** : mêmes queries/qrels pour tous les systèmes → deltas par query,
  **Wilcoxon signed-rank** ; binaires appariés → **McNemar exact** ; proportions → **Fisher exact**.
- **Multiplicité** : **Holm-Bonferroni** par famille (hypothèse × systèmes).
- **Pré-enregistrement** : `prereg/prereg.yaml` figé avant analyse + **manifeste SHA-256** des
  artefacts (`scripts/hash-artifacts.mjs`) — « exactement ces bits ont produit ces chiffres ».
- **Données** : corpus réel privé (jamais commité), corpus fixture synthétique commité
  (la CI valide la **méthodologie**, la machine locale valide le **système**).

## Résultats courants (corpus réel 498 AB + 269 CS, 20 queries, qrels adjudiquées, métriques DÉDUPLIQUÉES)

| système | recall@10 | MRR@10 | nDCG@10 |
|---|---|---|---|
| bm25 (baseline lexicale) | 44.1 % | 69.1 % | 47.5 % |
| embed (bi-encoder Nemotron) — plafond | 83.0 % | **95.0 %** | **84.9 %** |
| wrrf 1:2 (hybride pondéré) | **84.2 %** | **95.0 %** | 81.9 % |
| rrf k=60 égalitaire (prod AVANT audit) | 73.0 % | 91.7 % | 71.7 % |
| rrf-ce (cross-encoder) | 52.2 % | 85.0 % | 61.6 % |
| **ADAPTER production (APRÈS audit 2026-10-11)** | **83.4 %** | **95.0 %** | **85.0 %** |

**Récit complet** (audit → fix → mesure : `audit/AUDIT-REPORT.md`, patchs `patches/`) :
1. Prod avant audit : **11.3 % recall@10** — tri post-cross-encoder à échelles mélangées
   (RC-1), prouvé par reproduction isolée (87.6 → 11.7 %).
2. Après patchs RC-1..RC-4 + défaut embed pur (`IMMUNE_RRF_EMBED_W=999`) :
   **83.4 % = au plafond du bi-encoder** (83.0 %). Gain total : ×7.4.
3. wrrf 1:2 gagne 1.2 pts de recall mais perd 3 pts de nDCG → embed pur retenu
   (meilleur ordre global) ; knob env pour A/B, ré-évaluer après fix daemon (rôle ignoré).
4. κ(lexicon, qwen) = 0.351 → double adjudication des qrels désormais standard.
5. 6 ids dupliqués dans le JSON (767 items / 761 uniques) → dédup à la métrique
   (le bench gonflait recall/MRR sinon).

**Gains suivants identifiés** : (a) daemon ignore le champ role → l'asymétrie
query:/passage: de Nemotron n'est PAS appliquée (fix embed_server.py = prochain gain
attendu) ; (b) fusionner les 6 stratégies dupliquées ; (c) strate de queries lexicales
pour ré-évaluer le poids hybride avec des données.

## Usage

```bash
make test                # tests unitaires stats + validateurs (0 réseau)
make fixture             # bench IR fixture (0 réseau, 0 GPU) — le gate CI
make build-qrels         # UNE fois : construit les qrels (pooling+lexicon)
make adjudicate          # second juge qwen local → qrels finales + κ
make retrieval-real      # bench réel sur qrels figées (daemon embed requis)
make chimera-structural  # contrats Slime Mold/PRISM sur sorties live
make chimera-behavioral  # campagne gated (bras + juge aveugle)
make hash                # manifeste SHA-256 du protocole
```

## GitHub Actions

- **`ci.yml`** — à chaque push/PR : tests de propriétés stats, validateurs Chimera, bench IR
  fixture complet + contrôle de cohérence (baseline ≥ 80 % recall@10 sinon échec), manifeste
  sha256, upload artifacts. **Gratuit, 0 API, ~40 s.**
- **`campaign.yml`** — `workflow_dispatch` uniquement : `chimera-structural`, `chimera-behavioral`
  ou `retrieval-real`, sur runner **self-hosted** (qwen + embed locaux, 0 token cloud) ou cloud
  (endpoints payants via secrets, à la demande explicite).

## Limites (déclarées, pas cachées)

- 20 queries / 341 jugements de pertinence : le binôme queries×corpus est petit ; les IC par
  query le reflètent — élargir le jeu de queries renforce la puissance.
- Biais de conception des queries (vocab décalé) : favorise le sémantique — H-R1 le teste, pas
  le nie ; une seconde strate de queries lexicales est la suite prévue.
- κ = 0.35 (modéré) : les grades fins (1 vs 2) restent bruités → fusion conservatrice + lecture
  des deltas > 10 pts comme signal, < 10 pts comme indicatif.
- Juge = qwen local juge aussi ses propres sorties dans le tier comportemental v1 : l'aveuglement
  au bras est réel (le juge ne voit pas le bras), l'indépendance juge/généré non — un second juge
  hétérogène est prévu (échantillon 20 %, κ rapporté).
- API-side determinism non garanti (fournisseurs) : seeds loggés, disclosed, comme dans
  mc-double-blind-bench.

## Licence

MIT — Jacques Chauvin
