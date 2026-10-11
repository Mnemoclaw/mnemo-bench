// daemon-client.mjs — client minimal du daemon embed (port 8091) + fallback MiniLM local.
// Endpoints : POST /embed {text, role:'query'|'document'} → {vector}
//             POST /rerank {query, texts, limit} → {results:[{index,score}]}
//             GET  /health → {ok, models:{biEncoder,crossEncoder}, device, asymmetric}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.EMBED_PORT || '8091', 10);
const HOST = '127.0.0.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function post(endpoint, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: HOST, port: PORT, path: endpoint, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`JSON invalide du daemon: ${e.message}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('daemon timeout')); });
    req.write(data);
    req.end();
  });
}

export async function daemonHealth() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(4000) });
    const j = await res.json();
    return j.ok === true ? j : null;
  } catch { return null; }
}

export async function embedText(text, role = 'query') {
  const r = await post('/embed', { text, role });
  if (!r.vector) throw new Error('daemon /embed sans vector');
  return r.vector;
}

export async function embedBatch(texts, role = 'document', { onProgress } = {}) {
  const out = new Array(texts.length);
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    // le daemon n'a pas d'endpoint batch → N posts séquentiels (GPU local, ~ms/doc)
    for (let j = 0; j < chunk.length; j++) {
      out[i + j] = await embedText(chunk[j], role);
    }
    onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
  }
  return out;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function crossRerank(query, texts, limit = 20) {
  const r = await post('/rerank', { query, texts, limit });
  return r.results || [];
}

// Fallback CPU : MiniLM via @xenova/transformers installé dans le skill immune
// (chargé par chemin absolu — le bench lui-même reste zéro dépendance).
export async function minilmBackend() {
  const candidates = [
    path.join(HERE, '../../../../.claude/skills/immune/node_modules/@xenova/transformers/src/transformers.js'),
  ];
  for (const p of candidates) {
    try { const mod = await import(p); return { pipeline: mod.pipeline, name: 'minilm-cpu' }; } catch { /* next */ }
  }
  return null;
}

// Chemin de production EXACT : shell vers immune-adapter.js search (RRF + CE comme en prod).
// Utilisé pour mesurer avant/après patch de l'adapter.
export function adapterPath() {
  const p = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills', 'immune', 'immune-adapter.js');
  return fs.existsSync(p) ? p : null;
}
export async function adapterSearch(query, limit = 10) {
  const p = adapterPath();
  if (!p) throw new Error('immune-adapter.js introuvable');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const out = await promisify(execFile)('node', [p, 'search', '--query', query, '--type', 'all', '--limit', String(limit)], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  const j = JSON.parse(out.stdout);
  return (j.results || []).map((r) => `${r.source_type}:${r.source_id}`);
}
