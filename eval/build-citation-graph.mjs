import { openZoteroDB, getItemsWithDOIs } from './lib/zotero-db.mjs';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const OUTPUT_PATH = join(DATA_DIR, 'citation-pairs.json');

const MAILTO = 'jose@bloomidea.com';
const BATCH_SIZE = 50;
const DELAY_MS = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeDOI(doi) {
  return doi
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
}

async function fetchReferencesForDOI(doi) {
  const workUrl = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=id,doi,referenced_works&mailto=${MAILTO}`;
  const resp = await fetch(workUrl);
  if (!resp.ok) return [];

  const work = await resp.json();
  const refIds = work.referenced_works || [];
  if (refIds.length === 0) return [];

  const refDOIs = [];
  for (let i = 0; i < refIds.length; i += BATCH_SIZE) {
    const batch = refIds.slice(i, i + BATCH_SIZE);
    const oaIds = batch.map(id => id.replace('https://openalex.org/', ''));
    const filter = 'openalex:' + oaIds.join('|');

    const batchUrl = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&select=doi&per_page=${BATCH_SIZE}&mailto=${MAILTO}`;
    const batchResp = await fetch(batchUrl);
    if (!batchResp.ok) continue;

    const batchData = await batchResp.json();
    for (const ref of (batchData.results || [])) {
      if (ref.doi) refDOIs.push(normalizeDOI(ref.doi));
    }

    if (i + BATCH_SIZE < refIds.length) await sleep(DELAY_MS);
  }

  return refDOIs;
}

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(OUTPUT_PATH)) {
    const cached = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
    console.log(`Cached citation pairs found: ${cached.pairs.length} pairs from ${cached.papersQueried} papers`);
    console.log('Delete data/citation-pairs.json to rebuild.');
    return;
  }

  console.log('Phase 1: Building citation graph from OpenAlex...\n');

  const db = openZoteroDB();
  const items = getItemsWithDOIs(db);
  db.close();

  console.log(`Found ${items.length} items with DOIs in Zotero library.`);

  const doiToKey = new Map();
  for (const item of items) {
    const norm = normalizeDOI(item.doi);
    if (norm) doiToKey.set(norm, item.itemKey);
  }

  console.log(`Unique normalized DOIs: ${doiToKey.size}`);

  const pairs = [];
  const allDOIs = [...doiToKey.keys()];
  let queried = 0;
  let errors = 0;

  for (let i = 0; i < allDOIs.length; i++) {
    const doi = allDOIs[i];
    const sourceKey = doiToKey.get(doi);

    try {
      const refDOIs = await fetchReferencesForDOI(doi);
      for (const refDOI of refDOIs) {
        const targetKey = doiToKey.get(refDOI);
        if (targetKey && targetKey !== sourceKey) {
          pairs.push({ sourceDOI: doi, targetDOI: refDOI, sourceKey, targetKey });
        }
      }
    } catch (err) {
      errors++;
    }

    queried++;
    if (queried % 50 === 0) {
      const pct = ((queried / allDOIs.length) * 100).toFixed(1);
      console.log(`  ${queried}/${allDOIs.length} (${pct}%) - ${pairs.length} pairs found, ${errors} errors`);
    }

    await sleep(DELAY_MS);
  }

  const seen = new Set();
  const uniquePairs = pairs.filter(p => {
    const key = `${p.sourceKey}->${p.targetKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const involvedKeys = new Set();
  for (const p of uniquePairs) {
    involvedKeys.add(p.sourceKey);
    involvedKeys.add(p.targetKey);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    papersQueried: queried,
    totalPairs: uniquePairs.length,
    uniquePapers: involvedKeys.size,
    pairs: uniquePairs,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));

  console.log(`\nDone!`);
  console.log(`  Citation pairs: ${uniquePairs.length}`);
  console.log(`  Unique papers involved: ${involvedKeys.size}`);
  console.log(`  Saved to: ${OUTPUT_PATH}`);
}

main().catch(console.error);
