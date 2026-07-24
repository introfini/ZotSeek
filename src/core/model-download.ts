/**
 * Model download manager for non-bundled embedding models.
 *
 * Downloads model files from Hugging Face into the Zotero profile and
 * registers a `resource://zotseek-models/` substitution so Transformers.js
 * can load them locally via the same URL the worker expects.
 *
 * Layout: <dataDir>/zotseek-models/<hfPath>/<file>
 * So `resource://zotseek-models/<hfPath>/<file>` resolves correctly.
 */

import { ModelConfig, isAllowedHfPath } from './model-registry';

declare const Zotero: any;
declare const Services: any;
declare const Components: any;
declare const IOUtils: any;
declare const PathUtils: any;

const HF_BASE = 'https://huggingface.co';
const RES_HOST = 'zotseek-models';

/**
 * Absolute path to the models storage directory:
 * `<Zotero data directory>/zotseek-models`
 */
export function getModelsDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, 'zotseek-models');
}

/**
 * Directory for a specific model's files:
 * `<modelsDir>/<hfOrg>/<repoName>/`
 *
 * Mirrors the hfPath layout so `resource://zotseek-models/<hfPath>/<file>`
 * resolves to the correct local file.
 */
function modelDir(model: ModelConfig): string {
  return PathUtils.join(getModelsDir(), ...model.hfPath.split('/'));
}

/**
 * Register the `resource://zotseek-models/` protocol substitution so
 * Transformers.js (running in the ChromeWorker) can load models from the
 * profile directory without network access.
 *
 * Must be called once at plugin startup (before any embedding pipeline init).
 * Safe to call even if the models directory does not yet exist — the substitution
 * is just a URL mapping; file access happens on demand.
 */
export function registerModelsResourceSubstitution(): void {
  const dir = getModelsDir();

  // Build an nsIFile for the models directory path.
  // The directory need not exist yet — initWithPath only sets the path string.
  const f = Components.classes['@mozilla.org/file/local;1']
    .createInstance(Components.interfaces.nsIFile);
  f.initWithPath(dir);
  if (!f.exists()) {
    f.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
  }

  const fileURI = Services.io.newFileURI(f);

  const resProto = Services.io
    .getProtocolHandler('resource')
    .QueryInterface(Components.interfaces.nsISubstitutingProtocolHandler);

  resProto.setSubstitution(RES_HOST, fileURI);

  Zotero.debug(`[ZotSeek] resource://${RES_HOST}/ -> ${dir}`);
}

/**
 * Returns true when the model's primary ONNX file is present on disk.
 * A model is considered "on disk" when the ONNX file exists; individual
 * JSON config files may still be absent (404 skip) without affecting this.
 */
export async function isModelOnDisk(model: ModelConfig): Promise<boolean> {
  if (model.runtime === 'server') return true; // nothing on disk; the server hosts the weights
  const onnxPath = PathUtils.join(modelDir(model), ...model.onnxFile.split('/'));
  try {
    return await IOUtils.exists(onnxPath);
  } catch {
    return false;
  }
}

/**
 * Download all files for `model` from Hugging Face into the models directory.
 *
 * - Skips the download entirely if the ONNX file is already present.
 * - Writes each file to a `.part` temp file first, then atomically moves it
 *   to the final path to avoid partially-written files on crash or cancel.
 * - `special_tokens_map.json` is skipped on 404 (some repos omit it).
 * - Calls `onProgress(filesCompleted, totalFiles)` after each file.
 *
 * Throws if `model.hfPath` is not in the registry (allowlist enforcement).
 * Throws on any non-404 HTTP error or I/O failure (partial downloads are
 * cleaned up before re-throwing).
 */
export async function ensureModelDownloaded(
  model: ModelConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!isAllowedHfPath(model.hfPath)) {
    throw new Error(
      `[ZotSeek] Refusing to download non-allowlisted model path: ${model.hfPath}`,
    );
  }

  if (await isModelOnDisk(model)) {
    Zotero.debug(`[ZotSeek] Model already on disk: ${model.id}`);
    return;
  }

  const dir = modelDir(model);
  await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });

  const total = model.files.length;
  let done = 0;

  for (const rel of model.files) {
    const url = `${HF_BASE}/${model.hfPath}/resolve/main/${rel}`;
    const dest = PathUtils.join(dir, ...rel.split('/'));
    const tmp = `${dest}.part`;

    // Ensure any subdirectory inside the model dir exists (e.g. `onnx/`)
    const destParent = PathUtils.parent(dest);
    await IOUtils.makeDirectory(destParent, { createAncestors: true, ignoreExisting: true });

    try {
      Zotero.debug(`[ZotSeek] Downloading ${rel} from ${url}`);
      const resp = await fetch(url);

      if (!resp.ok) {
        if (resp.status === 404 && rel.endsWith('special_tokens_map.json')) {
          // Some repos do not include special_tokens_map.json — silently skip.
          Zotero.debug(`[ZotSeek] Skipping optional file (404): ${rel}`);
          done++;
          if (onProgress) onProgress(done, total);
          continue;
        }
        throw new Error(`HTTP ${resp.status} fetching ${rel}`);
      }

      if (resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        let firstChunk = true;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            await IOUtils.write(tmp, value, firstChunk ? {} : { mode: 'append' });
            firstChunk = false;
          }
        }
        if (firstChunk) {
          // empty body: still create the file
          await IOUtils.write(tmp, new Uint8Array(0));
        }
      } else {
        // Fallback for environments without a streaming body
        const buf = new Uint8Array(await resp.arrayBuffer());
        await IOUtils.write(tmp, buf);
      }
      await IOUtils.move(tmp, dest);

      Zotero.debug(`[ZotSeek] Saved ${rel}`);
    } catch (e: any) {
      // Best-effort cleanup of the partial file before re-throwing.
      try { await IOUtils.remove(tmp, { ignoreAbsent: true }); } catch { /* ignore */ }
      throw new Error(
        `[ZotSeek] Download failed for ${model.id}/${rel}: ${e?.message || e}`,
      );
    }

    done++;
    if (onProgress) onProgress(done, total);
  }

  Zotero.debug(`[ZotSeek] Model download complete: ${model.id} (${done} files)`);
}

/**
 * Delete all downloaded files for `model`.
 *
 * Removes the entire per-model directory (`<modelsDir>/<hfPath>/`).
 * Silently succeeds if the directory is already absent.
 */
export async function removeModelFiles(model: ModelConfig): Promise<void> {
  const dir = modelDir(model);
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
}
