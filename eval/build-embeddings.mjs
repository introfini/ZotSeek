import { openZoteroDB, getItemsWithDOIs, buildStorageMap, readFulltext } from './lib/zotero-db.mjs';
import { chunkDocument } from './lib/chunker.mjs';
import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

env.allowLocalModels = true;

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const PREFIX_DOC = 'search_document: ';
const EMBED_DIM = 768;

function createEvalDB(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      item_key TEXT PRIMARY KEY,
      title TEXT,
      abstract TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks (
      item_key TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT,
      chunk_type TEXT,
      token_count INTEGER,
      embedding BLOB,
      PRIMARY KEY (item_key, chunk_index),
      FOREIGN KEY (item_key) REFERENCES papers(item_key)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const pairsPath = join(DATA_DIR, 'citation-pairs.json');
  if (!existsSync(pairsPath)) {
    console.error('No citation pairs found. Run build-citation-graph.mjs first.');
    process.exit(1);
  }
  const pairsData = JSON.parse(readFileSync(pairsPath, 'utf-8'));
  const involvedKeys = new Set();
  for (const p of pairsData.pairs) {
    involvedKeys.add(p.sourceKey);
    involvedKeys.add(p.targetKey);
  }
  console.log(`Papers involved in citation pairs: ${involvedKeys.size}`);

  console.log('Reading Zotero database...');
  const db = openZoteroDB();
  const allItems = getItemsWithDOIs(db);
  const storageMap = buildStorageMap(db);
  db.close();

  const papers = [];
  for (const item of allItems) {
    if (!involvedKeys.has(item.itemKey)) continue;
    const storageKey = storageMap.get(item.itemKey);
    const fulltext = storageKey ? readFulltext(storageKey) : null;
    papers.push({
      itemKey: item.itemKey,
      title: item.title || 'Untitled',
      abstract: item.abstract || null,
      fulltext,
    });
  }

  console.log(`Papers with metadata: ${papers.length}`);
  console.log(`Papers with fulltext: ${papers.filter(p => p.fulltext).length}`);

  writeFileSync(
    join(DATA_DIR, 'paper-texts.json'),
    JSON.stringify(papers.map(p => ({
      itemKey: p.itemKey,
      title: p.title,
      hasAbstract: !!p.abstract,
      fulltextLength: p.fulltext?.length || 0,
    })), null, 2)
  );

  console.log('\nLoading embedding model (first run downloads ~130MB)...');
  const embedder = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'fp32',
  });
  console.log('Model loaded.\n');

  for (const maxTokens of [512, 2000]) {
    const dbPath = join(DATA_DIR, `embeddings-${maxTokens}.sqlite`);

    if (existsSync(dbPath)) {
      const checkDb = new Database(dbPath, { readonly: true });
      const meta = checkDb.prepare("SELECT value FROM meta WHERE key = 'status'").get();
      checkDb.close();
      if (meta?.value === 'complete') {
        console.log(`embeddings-${maxTokens}.sqlite already complete, skipping.`);
        continue;
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Strategy: maxTokens=${maxTokens}`);
    console.log(`${'='.repeat(60)}`);

    const evalDb = createEvalDB(dbPath);
    const insertPaper = evalDb.prepare('INSERT OR REPLACE INTO papers (item_key, title, abstract) VALUES (?, ?, ?)');
    const insertChunk = evalDb.prepare('INSERT OR REPLACE INTO chunks (item_key, chunk_index, chunk_text, chunk_type, token_count, embedding) VALUES (?, ?, ?, ?, ?, ?)');

    let totalChunks = 0;
    const startTime = Date.now();

    for (let pi = 0; pi < papers.length; pi++) {
      const paper = papers[pi];
      insertPaper.run(paper.itemKey, paper.title, paper.abstract);

      const { chunks } = chunkDocument(
        paper.title,
        paper.abstract,
        paper.fulltext,
        maxTokens,
      );

      for (const chunk of chunks) {
        const result = await embedder(PREFIX_DOC + chunk.text, { pooling: 'mean', normalize: true });
        insertChunk.run(
          paper.itemKey,
          chunk.index,
          chunk.text,
          chunk.type,
          chunk.tokenCount || 0,
          float32ToBuffer(result.data),
        );
        totalChunks++;
      }

      if ((pi + 1) % 10 === 0 || pi === papers.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const avgPerPaper = (totalChunks / (pi + 1)).toFixed(1);
        console.log(`  ${pi + 1}/${papers.length} papers, ${totalChunks} chunks total (avg ${avgPerPaper}/paper), ${elapsed}s elapsed`);
      }
    }

    evalDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('status', 'complete')").run();
    evalDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('maxTokens', ?)").run(String(maxTokens));
    evalDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('totalChunks', ?)").run(String(totalChunks));
    evalDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('totalPapers', ?)").run(String(papers.length));
    evalDb.close();

    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\nDone: ${totalChunks} chunks embedded in ${totalTime} minutes.`);
  }

  console.log('\nPhase 2 complete. Run: node run-eval.mjs');
}

main().catch(console.error);
