# mnemo-bench — benchmarks publication-grade des briques MnemoClaw (Immune, Slime Mold, PRISM, Chimera)
# Zéro dépendance npm. Makefile = parité locale/CI.

SHELL := /bin/bash

.PHONY: help test gate fixture retrieval-real adjudicate chimera-structural chimera-behavioral hash report

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

test: ## Tests unitaires (stats + validateurs Chimera) — 0 réseau
	node lib/test-stats.mjs
	node bench/chimera/test-validators.mjs

fixture: ## Bench retrieval sur corpus fixture (méthodologie IR, 0 réseau, 0 GPU)
	node bench/retrieval/run-retrieval.mjs --corpus fixture --tag fixture

gate: test fixture hash ## Gate CI complet — ce que lance GitHub Actions à chaque push

retrieval-real: ## Bench retrieval corpus réel (daemon embed requis, qrels figées requises)
	node bench/retrieval/run-retrieval.mjs --corpus real --qrels results/qrels-immune-adjudicated.tsv

build-qrels: ## Construit les qrels par pooling+lexicon (une seule fois, puis FIGÉES)
	node bench/retrieval/run-retrieval.mjs --corpus real --build-qrels

adjudicate: ## Second juge = qwen local (κ de Cohen + fusion conservatrice)
	node bench/retrieval/adjudicate-qwen.mjs

chimera-structural: ## Contrats Slime Mold/PRISM sur sorties live qwen local
	node bench/chimera/run-chimera.mjs --mode structural

chimera-behavioral: ## Campagne comportementale gated (bras + juge aveugle, coûteux en temps local)
	node bench/chimera/run-chimera.mjs --mode behavioral --seeds 5

hash: ## Manifeste SHA-256 des artefacts du protocole
	node scripts/hash-artifacts.mjs

report: ## Affiche le dernier rapport retrieval
	@ls -td results/retrieval-* | head -1 | xargs -I{} echo {}
