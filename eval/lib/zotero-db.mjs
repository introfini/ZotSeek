import Database from 'better-sqlite3';
import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const ZOTERO_DATA_DIR = process.env.ZOTERO_DATA_DIR
  || join(process.env.HOME, 'Zotero');

const ZOTERO_DB_PATH = join(ZOTERO_DATA_DIR, 'zotero.sqlite');
const STORAGE_DIR = join(ZOTERO_DATA_DIR, 'storage');

export function openZoteroDB() {
  const tmpPath = join(ZOTERO_DATA_DIR, 'zotero_eval_readonly.sqlite');
  copyFileSync(ZOTERO_DB_PATH, tmpPath);
  return new Database(tmpPath, { readonly: true });
}

export function getItemsWithDOIs(db) {
  const rows = db.prepare(`
    SELECT
      i.itemID   AS itemId,
      i.key      AS itemKey,
      doi_v.value AS doi,
      title_v.value AS title,
      abs_v.value AS abstract
    FROM items i
    JOIN itemData doi_d ON doi_d.itemID = i.itemID
    JOIN fields doi_f ON doi_f.fieldID = doi_d.fieldID AND doi_f.fieldName = 'DOI'
    JOIN itemDataValues doi_v ON doi_v.valueID = doi_d.valueID
    LEFT JOIN itemData title_d ON title_d.itemID = i.itemID
    LEFT JOIN fields title_f ON title_f.fieldID = title_d.fieldID AND title_f.fieldName = 'title'
    LEFT JOIN itemDataValues title_v ON title_v.valueID = title_d.valueID
    LEFT JOIN itemData abs_d ON abs_d.itemID = i.itemID
    LEFT JOIN fields abs_f ON abs_f.fieldID = abs_d.fieldID AND abs_f.fieldName = 'abstractNote'
    LEFT JOIN itemDataValues abs_v ON abs_v.valueID = abs_d.valueID
    WHERE doi_v.value != ''
      AND i.itemTypeID NOT IN (1, 14)
    GROUP BY i.itemID
  `).all();

  return rows;
}

export function buildStorageMap(db) {
  const rows = db.prepare(`
    SELECT
      parent.key AS itemKey,
      att_item.key AS storageKey
    FROM itemAttachments ia
    JOIN items att_item ON att_item.itemID = ia.itemID
    JOIN items parent ON parent.itemID = ia.parentItemID
    WHERE ia.contentType = 'application/pdf'
  `).all();

  const map = new Map();
  for (const row of rows) {
    const cachePath = join(STORAGE_DIR, row.storageKey, '.zotero-ft-cache');
    if (existsSync(cachePath)) {
      map.set(row.itemKey, row.storageKey);
    }
  }
  return map;
}

export function readFulltext(storageKey) {
  const cachePath = join(STORAGE_DIR, storageKey, '.zotero-ft-cache');
  if (!existsSync(cachePath)) return null;
  return readFileSync(cachePath, 'utf-8');
}
