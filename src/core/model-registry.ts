/**
 * Model registry: single source of truth for selectable local embedding models.
 * See docs (SEARCH_ARCHITECTURE) for the curated set and per-model parameters.
 */
declare const Zotero: any;

export interface ModelConfig {
  id: string;              // stored as model_id in the DB (short id)
  label: string;           // UI label
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
  return [...MODELS];
}

export function getModel(id: string): ModelConfig | undefined {
  return MODELS.find(m => m.id === id);
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

export function modelBasePath(model: ModelConfig): string {
  return model.bundled
    ? 'chrome://zotseek/content/models/'
    : 'resource://zotseek-models/';
}

export function applyPrefix(text: string, kind: 'query' | 'doc', model: ModelConfig): string {
  const prefix = kind === 'query' ? model.queryPrefix : model.docPrefix;
  return prefix ? prefix + text : text;
}
