import Database from 'better-sqlite3';
import { computeMetrics, aggregateMetrics } from './lib/metrics.mjs';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const PREFIX_QUERY = 'search_query: ';

function loadEmbeddings(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT item_key, chunk_index, embedding FROM chunks ORDER BY item_key, chunk_index').all();
  db.close();

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.item_key)) map.set(row.item_key, []);
    const float32 = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4
    );
    map.get(row.item_key).push({
      chunkIndex: row.chunk_index,
      embedding: float32,
    });
  }
  return map;
}

function loadPaperAbstracts(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT item_key, title, abstract FROM papers').all();
  db.close();
  const map = new Map();
  for (const row of rows) {
    map.set(row.item_key, { title: row.title, abstract: row.abstract });
  }
  return map;
}

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function maxSimSearch(queryEmbedding, embeddings, excludeKey) {
  const scores = [];
  for (const [itemKey, chunks] of embeddings) {
    if (itemKey === excludeKey) continue;
    let maxSim = -Infinity;
    for (const chunk of chunks) {
      const sim = dotProduct(queryEmbedding, chunk.embedding);
      if (sim > maxSim) maxSim = sim;
    }
    scores.push({ itemKey, similarity: maxSim });
  }
  scores.sort((a, b) => b.similarity - a.similarity);
  return scores;
}

async function main() {
  const pairsPath = join(DATA_DIR, 'citation-pairs.json');
  if (!existsSync(pairsPath)) {
    console.error('No citation pairs. Run build-citation-graph.mjs first.');
    process.exit(1);
  }
  const pairsData = JSON.parse(readFileSync(pairsPath, 'utf-8'));

  const citationsBySource = new Map();
  for (const p of pairsData.pairs) {
    if (!citationsBySource.has(p.sourceKey)) citationsBySource.set(p.sourceKey, new Set());
    citationsBySource.get(p.sourceKey).add(p.targetKey);
  }
  console.log(`Citation queries: ${citationsBySource.size} source papers`);
  console.log(`Total citation pairs: ${pairsData.totalPairs}\n`);

  console.log('Loading embedding model...');
  env.allowLocalModels = true;
  const embedder = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });
  console.log('Model loaded.\n');

  const results = {};

  for (const maxTokens of [512, 2000]) {
    const dbPath = join(DATA_DIR, `embeddings-${maxTokens}.sqlite`);
    if (!existsSync(dbPath)) {
      console.error(`Missing ${dbPath}. Run build-embeddings.mjs first.`);
      process.exit(1);
    }

    console.log(`${'='.repeat(60)}`);
    console.log(`Evaluating: maxTokens=${maxTokens}`);
    console.log(`${'='.repeat(60)}`);

    const embeddings = loadEmbeddings(dbPath);
    const paperMeta = loadPaperAbstracts(dbPath);

    console.log(`  Loaded ${embeddings.size} papers with embeddings`);

    const allMetrics = [];
    const perQueryDetails = [];
    let processed = 0;

    for (const [sourceKey, targetKeys] of citationsBySource) {
      const meta = paperMeta.get(sourceKey);
      if (!meta) continue;

      const queryText = meta.abstract
        ? `${meta.title}\n\n${meta.abstract}`
        : meta.title;

      const queryResult = await embedder(PREFIX_QUERY + queryText, { pooling: 'mean', normalize: true });
      const queryEmbedding = queryResult.data;

      const ranked = maxSimSearch(queryEmbedding, embeddings, sourceKey);
      const rankedKeys = ranked.map(r => r.itemKey);

      const validTargets = new Set([...targetKeys].filter(k => embeddings.has(k)));
      if (validTargets.size === 0) continue;

      const m = computeMetrics(rankedKeys, validTargets);
      allMetrics.push(m);

      const targetRanks = [];
      for (const tk of validTargets) {
        const rank = rankedKeys.indexOf(tk);
        targetRanks.push({ targetKey: tk, rank: rank >= 0 ? rank + 1 : null });
      }
      perQueryDetails.push({
        sourceKey,
        title: meta.title?.substring(0, 80),
        targets: targetRanks,
        metrics: m,
      });

      processed++;
      if (processed % 50 === 0) {
        console.log(`  ${processed} queries processed...`);
      }
    }

    if (allMetrics.length === 0) {
      console.log('  No valid queries found!');
      continue;
    }

    const agg = aggregateMetrics(allMetrics);
    results[maxTokens] = { aggregate: agg, numQueries: allMetrics.length, details: perQueryDetails };

    console.log(`\n  Queries evaluated: ${allMetrics.length}`);
    console.log(`  Results:`);
    for (const [metric, value] of Object.entries(agg)) {
      console.log(`    ${metric.padEnd(12)} ${value.toFixed(4)}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('COMPARISON: maxTokens=512 vs maxTokens=2000');
  console.log(`${'='.repeat(60)}\n`);

  if (results[512] && results[2000]) {
    const metrics = Object.keys(results[512].aggregate);
    console.log('Metric'.padEnd(14) + '512'.padStart(10) + '2000'.padStart(10) + 'Delta'.padStart(10) + 'Winner'.padStart(10));
    console.log('-'.repeat(54));

    for (const metric of metrics) {
      const v512 = results[512].aggregate[metric];
      const v2000 = results[2000].aggregate[metric];
      const delta = v512 - v2000;
      const winner = delta > 0.001 ? '512' : delta < -0.001 ? '2000' : 'tie';
      const deltaStr = (delta > 0 ? '+' : '') + delta.toFixed(4);
      console.log(
        metric.padEnd(14) +
        v512.toFixed(4).padStart(10) +
        v2000.toFixed(4).padStart(10) +
        deltaStr.padStart(10) +
        winner.padStart(10)
      );
    }

    console.log(`\nQueries: ${results[512].numQueries}`);

    const details512 = results[512].details;
    const details2000 = results[2000].details;
    const mrrDiffs = [];
    for (let i = 0; i < details512.length; i++) {
      if (i < details2000.length) {
        mrrDiffs.push({
          title: details512[i].title,
          mrr512: details512[i].metrics.mrr,
          mrr2000: details2000[i].metrics.mrr,
          diff: details512[i].metrics.mrr - details2000[i].metrics.mrr,
        });
      }
    }
    mrrDiffs.sort((a, b) => b.diff - a.diff);

    if (mrrDiffs.length > 5) {
      console.log('\nTop 5 queries where 512 wins:');
      for (const d of mrrDiffs.slice(0, 5)) {
        console.log(`  MRR ${d.mrr512.toFixed(3)} vs ${d.mrr2000.toFixed(3)} (${d.diff > 0 ? '+' : ''}${d.diff.toFixed(3)}): ${d.title}`);
      }

      console.log('\nTop 5 queries where 2000 wins:');
      for (const d of mrrDiffs.slice(-5).reverse()) {
        console.log(`  MRR ${d.mrr512.toFixed(3)} vs ${d.mrr2000.toFixed(3)} (${d.diff > 0 ? '+' : ''}${d.diff.toFixed(3)}): ${d.title}`);
      }
    }
  }

  const outputPath = join(DATA_DIR, 'eval-results.json');
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to: ${outputPath}`);
}

main().catch(console.error);
