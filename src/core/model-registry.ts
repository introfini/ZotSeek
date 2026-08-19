/**
 * Model registry: single source of truth for selectable local embedding models.
 * See docs (SEARCH_ARCHITECTURE) for the curated set and per-model parameters.
 */
declare const Zotero: any;

export interface ModelConfig {
  id: string;              // stored as model_id in the DB (short id)
  label: string;           // UI label
  runtime: 'onnx' | 'server'; // 'onnx' = in-process ChromeWorker; 'server' = local inference server
  hfPath: string;          // Hugging Face repo path, e.g. 'Xenova/bge-m3'
  dimensions: number;
  pooling: 'mean' | 'cls';
  normalize: boolean;
  queryPrefix: string;     // '' when the model uses no instruction prefix
  docPrefix: string;
  onnxFile: string;        // path within the repo, e.g. 'onnx/model_quantized.onnx'
  files: string[];         // all repo files to download for a non-bundled model
  bundled: boolean;        // true only for the model shipped inside the XPI
  approxSizeMB: number;
  multilingual: boolean;

  // server-runtime only
  baseUrl?: string;          // e.g. 'http://127.0.0.1:1234' (loopback enforced at request time)
  serverModelName?: string;  // the model id the server knows, e.g. 'text-embedding-nomic-embed-text-v1.5'
  apiKey?: string;           // optional bearer token (vLLM)
}

const COMMON_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
];

export const MODELS: ModelConfig[] = [
  {
    id: 'nomic-embed-text-v1.5',
    label: 'Nomic v1.5 (English, balanced)',
    runtime: 'onnx',
    hfPath: 'Xenova/nomic-embed-text-v1.5',
    dimensions: 768, pooling: 'mean', normalize: true,
    queryPrefix: 'search_query: ', docPrefix: 'search_document: ',
    onnxFile: 'onnx/model_quantized.onnx',
    files: [...COMMON_FILES, 'onnx/model_quantized.onnx'],
    bundled: true, approxSizeMB: 130, multilingual: false,
  },
  {
    id: 'paraphrase-multilingual-MiniLM-L12-v2',
    label: 'MiniLM multilingual (small, fast)',
    runtime: 'onnx',
    hfPath: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dimensions: 384, pooling: 'mean', normalize: true,
    queryPrefix: '', docPrefix: '',
    onnxFile: 'onnx/model_quantized.onnx',
    files: [...COMMON_FILES, 'onnx/model_quantized.onnx'],
    bundled: false, approxSizeMB: 135, multilingual: true,
  },
  {
    id: 'multilingual-e5-base',
    label: 'Multilingual E5 base',
    runtime: 'onnx',
    hfPath: 'Xenova/multilingual-e5-base',
    dimensions: 768, pooling: 'mean', normalize: true,
    queryPrefix: 'query: ', docPrefix: 'passage: ',
    onnxFile: 'onnx/model_quantized.onnx',
    files: [...COMMON_FILES, 'onnx/model_quantized.onnx'],
    bundled: false, approxSizeMB: 110, multilingual: true,
  },
  {
    id: 'bge-m3',
    label: 'BGE-M3 (top multilingual)',
    runtime: 'onnx',
    hfPath: 'Xenova/bge-m3',
    dimensions: 1024, pooling: 'cls', normalize: true,
    queryPrefix: '', docPrefix: '',
    onnxFile: 'onnx/model_quantized.onnx',
    files: [...COMMON_FILES, 'onnx/model_quantized.onnx'],
    bundled: false, approxSizeMB: 570, multilingual: true,
  },
];

export const DEFAULT_MODEL_ID = 'nomic-embed-text-v1.5';

export function getAllModels(): ModelConfig[] {
  return [...MODELS, ...getServerModels()];
}

export function getModel(id: string): ModelConfig | undefined {
  return MODELS.find(m => m.id === id) || getServerModels().find(m => m.id === id);
}

export function isAllowedHfPath(hfPath: string): boolean {
  return MODELS.some(m => m.hfPath === hfPath);
}

export function legacyModelIdToShortId(stored: string): string {
  const byHf = MODELS.find(m => m.hfPath === stored);
  if (byHf) return byHf.id;
  return stored; // already a short id (or unknown); leave as-is
}

export function getActiveModelId(): string {
  try {
    const v = Zotero.Prefs.get('zotseek.embeddingModel', true);
    if (typeof v === 'string' && getModel(v)) return v;
  } catch (e: any) {
    Zotero.debug('[ZotSeek] getActiveModelId error: ' + (e?.message || e));
  }
  return DEFAULT_MODEL_ID;
}

export function getActiveModel(): ModelConfig {
  return getModel(getActiveModelId()) || getModel(DEFAULT_MODEL_ID)!;
}

/**
 * Persist the active model id. The pref is the single source of truth for which
 * model is active; the pipeline reads it back via getActiveModel() on every init.
 */
export function setActiveModelId(id: string): void {
  try {
    Zotero.Prefs.set('zotseek.embeddingModel', id, true);
  } catch (e: any) {
    Zotero.debug('[ZotSeek] setActiveModelId error: ' + (e?.message || e));
  }
}

/**
 * Whether this model's weights must already be on disk before the embedding
 * worker can load it.
 *
 * Bundled models ship inside the plugin and resolve over `chrome://`. Server
 * models keep their weights on the server. Everything else is downloaded into
 * the profile and resolved over `resource://zotseek-models/`, and is missing
 * until the user downloads it from Settings.
 */
export function requiresLocalFiles(model: ModelConfig): boolean {
  return model.runtime !== 'server' && !model.bundled;
}

/**
 * Message for a model whose downloaded files are not on disk.
 *
 * Without this the user sees Transformers.js's own wording, which names a
 * `resource://` URL and mentions `local_files_only`. That is accurate and
 * completely unactionable: it does not say which model, that a download is
 * needed, or where to start one.
 */
export function missingModelMessage(model: ModelConfig): string {
  return (
    `The "${model.label}" embedding model is selected but its files are not on this computer. ` +
    `Open Settings, ZotSeek, Models and select it again to download it (about ${model.approxSizeMB} MB), ` +
    `or switch back to a model that is already installed.`
  );
}

/**
 * Message for a model that cannot be reached because the
 * `resource://zotseek-models/` mapping is not working.
 *
 * Distinct from missingModelMessage on purpose: here the files may well be on
 * disk and perfectly intact, so telling the user to download again would send
 * them down a dead end. This is an environment problem, not a missing asset.
 */
export function brokenSubstitutionMessage(model: ModelConfig, reason: string | null): string {
  const detail = reason ? ` (${reason})` : '';
  return (
    `The "${model.label}" model cannot be loaded because ZotSeek could not map its ` +
    `storage folder${detail}. Downloading the model again will not help. Restart Zotero, ` +
    `and if it keeps happening please report it with your Zotero version and operating system. ` +
    `Meanwhile the built-in model still works.`
  );
}

export function modelBasePath(model: ModelConfig): string {
  return model.bundled
    ? 'chrome://zotseek/content/models/'
    : 'resource://zotseek-models/';
}

export function applyPrefix(text: string, kind: 'query' | 'doc', model: ModelConfig): string {
  const prefix = kind === 'query' ? model.queryPrefix : model.docPrefix;
  return prefix ? prefix + text : text;
}

/**
 * Server-backed models (issue #42). Persisted in the 'zotseek.serverModels'
 * pref as a JSON array of ServerModelEntry. A server model is a separate
 * vector space from any bundled ONNX model (even for the "same" weights),
 * so it always indexes under its own 'server:'-namespaced model_id.
 */
export interface ServerModelEntry {
  id: string;
  label: string;
  baseUrl: string;
  serverModelName: string;
  dimensions: number;
  queryPrefix: string;
  docPrefix: string;
  apiKey?: string;
}

const SERVER_MODELS_PREF = 'zotseek.serverModels';

export function sanitizeServerModelId(serverModelName: string): string {
  const slug = serverModelName.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `server:${slug || 'model'}`;
}

/** Prefix inference by model-name family; servers never add task prefixes themselves. */
export function inferServerPrefixes(name: string): { queryPrefix: string; docPrefix: string } {
  const n = name.toLowerCase();
  if (n.includes('nomic')) return { queryPrefix: 'search_query: ', docPrefix: 'search_document: ' };
  if (n.includes('e5')) return { queryPrefix: 'query: ', docPrefix: 'passage: ' };
  return { queryPrefix: '', docPrefix: '' };
}

function isValidServerEntry(e: any): e is ServerModelEntry {
  return !!e && typeof e === 'object'
    && typeof e.id === 'string' && e.id.startsWith('server:')
    && typeof e.label === 'string'
    && typeof e.baseUrl === 'string'
    && typeof e.serverModelName === 'string'
    && typeof e.dimensions === 'number' && e.dimensions > 0
    && typeof e.queryPrefix === 'string'
    && typeof e.docPrefix === 'string';
}

function serverEntryToModelConfig(e: ServerModelEntry): ModelConfig {
  return {
    id: e.id, label: e.label, runtime: 'server',
    dimensions: e.dimensions, pooling: 'mean', normalize: true, // pooling/normalize handled server-side; fillers
    queryPrefix: e.queryPrefix, docPrefix: e.docPrefix,
    hfPath: '', onnxFile: '', files: [], bundled: false, approxSizeMB: 0, // onnx-only fields, unused
    multilingual: false,
    baseUrl: e.baseUrl, serverModelName: e.serverModelName, apiKey: e.apiKey,
  };
}

export function getServerModelEntries(): ServerModelEntry[] {
  try {
    const raw = Zotero.Prefs.get(SERVER_MODELS_PREF, true);
    if (typeof raw !== 'string' || !raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidServerEntry);
  } catch (e: any) {
    Zotero.debug('[ZotSeek] getServerModelEntries: malformed pref ignored: ' + (e?.message || e));
    return [];
  }
}

export function getServerModels(): ModelConfig[] {
  return getServerModelEntries().map(serverEntryToModelConfig);
}

export function addServerModel(entry: ServerModelEntry): void {
  const list = getServerModelEntries().filter(x => x.id !== entry.id);
  list.push(entry);
  Zotero.Prefs.set(SERVER_MODELS_PREF, JSON.stringify(list), true);
}

export function removeServerModel(id: string): void {
  const list = getServerModelEntries().filter(x => x.id !== id);
  Zotero.Prefs.set(SERVER_MODELS_PREF, JSON.stringify(list), true);
}
