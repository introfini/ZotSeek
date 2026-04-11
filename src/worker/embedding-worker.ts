/**
 * Embedding Worker - ChromeWorker for Transformers.js v3
 * 
 * Uses nomic-embed-text-v1.5 with 8K token context and instruction prefixes.
 * Runs in a ChromeWorker thread with privileged access.
 */

declare const self: any;
declare const postMessage: (data: any) => void;
declare const addEventListener: (type: string, handler: (event: any) => void) => void;

// Set up globals that Transformers.js expects
(globalThis as any).self = globalThis;
(globalThis as any).window = globalThis;
if (typeof navigator === 'undefined') {
  (globalThis as any).navigator = {
    userAgent: 'Zotero ChromeWorker',
    hardwareConcurrency: 4,
    language: 'en-US',
    languages: ['en-US', 'en'],
  };
}

// Detect WebGPU availability for GPU acceleration
const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
let useWebGPU = false; // Will be set after actual GPU adapter check

// Import Transformers.js v3
import { pipeline, env } from '@huggingface/transformers';

// CRITICAL: Configure wasmPaths BEFORE any pipeline initialization
env.backends.onnx.wasm.wasmPaths = 'chrome://zotseek/content/wasm/';

// Configure for local/bundled operation
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'chrome://zotseek/content/models/';

// Disable browser caching (not available in ChromeWorker)
env.useBrowserCache = false;
(env as any).useCache = false;

// Use multiple threads for faster embedding
// ChromeWorker supports SharedArrayBuffer in Zotero 8+'s privileged context (Firefox 140+)
env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency || 4;

// Log configuration
postMessage({
  type: 'log',
  level: 'info',
  message: 'Transformers.js v3 environment configured',
  data: {
    wasmPaths: env.backends.onnx.wasm.wasmPaths,
    localModelPath: env.localModelPath,
    webGPUDetected: hasWebGPU,
    numThreads: env.backends.onnx.wasm.numThreads,
  }
});

// Worker state
let embeddingPipeline: any = null;
let isLoading = false;

// Model configuration - nomic-embed-text-v1.5
// - 8192 token context window
// - 768 dimension embeddings (Matryoshka - can truncate to 256/128)
// - Instruction-aware: use search_document: and search_query: prefixes
// - Outperforms OpenAI text-embedding-3-small on MTEB
// See: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
// Note: Using nomic-ai source with ONNX files in Xenova directory structure
const MODEL_ID = 'Xenova/nomic-embed-text-v1.5';
const MODEL_OPTIONS = {
  quantized: true,         // Use quantized model (~130MB)
  local_files_only: true,  // Only use local bundled files
};

// PERFORMANCE OPTIMIZATION: Smaller chunks = much faster embedding
// Embedding time scales ~O(n²) with sequence length due to attention
// - 24000 chars (~8000 tokens): ~45 seconds (too slow!)
// - 8000 chars (~2000 tokens): ~3-5 seconds (acceptable)
// The chunker now creates smaller chunks, this is a safety limit.
const MAX_CHARS = 8000;

// Instruction prefixes for nomic-embed
// These improve retrieval quality by signaling intent to the model
const PREFIX_DOCUMENT = 'search_document: ';
const PREFIX_QUERY = 'search_query: ';

/**
 * Check if WebGPU is actually available and working
 */
async function checkWebGPUAvailability(): Promise<boolean> {
  if (!hasWebGPU) return false;

  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;

    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      postMessage({
        type: 'log',
        level: 'info',
        message: 'WebGPU: No adapter available',
      });
      return false;
    }

    const adapterInfo = await adapter.requestAdapterInfo?.() || {};
    postMessage({
      type: 'log',
      level: 'info',
      message: 'WebGPU adapter found',
      data: {
        vendor: adapterInfo.vendor || 'unknown',
        architecture: adapterInfo.architecture || 'unknown',
        device: adapterInfo.device || 'unknown',
      }
    });

    return true;
  } catch (error: any) {
    postMessage({
      type: 'log',
      level: 'info',
      message: 'WebGPU check failed',
      data: { error: error.message || String(error) }
    });
    return false;
  }
}

/**
 * Initialize the embedding pipeline
 * Tries WebGPU first for GPU acceleration, falls back to WASM (CPU)
 */
async function initPipeline(): Promise<void> {
  if (embeddingPipeline || isLoading) return;

  isLoading = true;
  const startTime = Date.now();

  // Check WebGPU availability
  useWebGPU = await checkWebGPUAvailability();

  const deviceType = useWebGPU ? 'webgpu' : 'wasm';
  const deviceLabel = useWebGPU ? 'GPU (WebGPU)' : 'CPU (WASM)';

  postMessage({
    type: 'log',
    level: 'info',
    message: `Loading embedding model on ${deviceLabel}`,
    data: { modelId: MODEL_ID, device: deviceType }
  });

  postMessage({ type: 'status', status: 'loading', message: `Loading model on ${deviceLabel}...` });

  // Try WebGPU first, fall back to WASM if it fails
  if (useWebGPU) {
    try {
      embeddingPipeline = await pipeline('feature-extraction', MODEL_ID, {
        ...MODEL_OPTIONS,
        device: 'webgpu',
      });

      const loadTime = Date.now() - startTime;
      postMessage({
        type: 'log',
        level: 'info',
        message: `Model loaded on GPU in ${loadTime}ms`,
        data: { modelId: MODEL_ID, loadTimeMs: loadTime, device: 'webgpu' }
      });

      postMessage({ type: 'status', status: 'ready', message: `Model loaded on GPU (${loadTime}ms)` });
      isLoading = false;
      return;
    } catch (error: any) {
      postMessage({
        type: 'log',
        level: 'warn',
        message: 'WebGPU failed, falling back to CPU',
        data: { error: error.message || String(error) }
      });
      useWebGPU = false;
      // Continue to WASM fallback
    }
  }

  // WASM (CPU) fallback
  try {
    embeddingPipeline = await pipeline('feature-extraction', MODEL_ID, MODEL_OPTIONS);

    const loadTime = Date.now() - startTime;
    postMessage({
      type: 'log',
      level: 'info',
      message: `Model loaded on CPU in ${loadTime}ms`,
      data: { modelId: MODEL_ID, loadTimeMs: loadTime, device: 'wasm' }
    });

    postMessage({ type: 'status', status: 'ready', message: `Model loaded on CPU (${loadTime}ms)` });
  } catch (error: any) {
    const loadTime = Date.now() - startTime;

    postMessage({
      type: 'log',
      level: 'error',
      message: `Failed to load model after ${loadTime}ms`,
      data: {
        error: error.message || String(error),
        stack: error.stack,
      }
    });

    postMessage({ type: 'error', error: `Failed to load model: ${error.message}` });
  } finally {
    isLoading = false;
  }
}

/**
 * Generate embedding for text
 * 
 * @param jobId - Unique job identifier
 * @param text - Text to embed
 * @param isQuery - If true, use search_query prefix; if false, use search_document prefix
 */
async function generateEmbedding(jobId: string, text: string, isQuery: boolean = false): Promise<void> {
  if (!embeddingPipeline) {
    postMessage({ type: 'error', jobId, error: 'Pipeline not initialized' });
    return;
  }

  try {
    const startTime = Date.now();

    // Truncate if needed (should be rare with 8K context)
    let processedText = text.length > MAX_CHARS ? text.substring(0, MAX_CHARS) : text;
    
    // Add instruction prefix based on whether this is a query or document
    // This is critical for nomic-embed's retrieval quality
    const prefix = isQuery ? PREFIX_QUERY : PREFIX_DOCUMENT;
    processedText = prefix + processedText;

    const wasTruncated = text.length > MAX_CHARS;
    if (wasTruncated) {
      postMessage({
        type: 'log',
        level: 'info',
        message: 'Text truncated for embedding',
        data: { originalLength: text.length, truncatedLength: MAX_CHARS }
      });
    }

    const output = await embeddingPipeline(processedText, {
      pooling: 'mean',
      normalize: true,
    });

    const embedding = Array.from(output.data as Float32Array);  // 768 dimensions
    const processingTimeMs = Date.now() - startTime;

    postMessage({
      type: 'embedding',
      jobId,
      embedding,
      modelId: MODEL_ID,
      processingTimeMs,
    });
  } catch (error: any) {
    postMessage({
      type: 'log',
      level: 'error',
      message: 'Failed to generate embedding',
      data: { error: error.message || String(error) }
    });
    postMessage({ type: 'error', jobId, error: error.message || String(error) });
  }
}

/**
 * Handle messages from main thread
 */
addEventListener('message', async (event: MessageEvent) => {
  const { type, jobId, data } = event.data;

  switch (type) {
    case 'init':
      await initPipeline();
      break;

    case 'embed':
      if (!embeddingPipeline) {
        await initPipeline();
      }
      if (embeddingPipeline) {
        // data.isQuery indicates if this is a search query (true) or document (false)
        const isQuery = data?.isQuery ?? false;
        await generateEmbedding(jobId, data.text, isQuery);
      }
      break;

    case 'ping':
      postMessage({ type: 'pong', jobId });
      break;

    default:
      postMessage({ type: 'error', jobId, error: `Unknown message type: ${type}` });
  }
});

// Signal that worker script is loaded
postMessage({
  type: 'log',
  level: 'info',
  message: 'Embedding worker initialized',
  data: { modelId: MODEL_ID, maxChars: MAX_CHARS, webGPUAvailable: hasWebGPU }
});
postMessage({ type: 'status', status: 'initialized', message: `Worker loaded (WebGPU ${hasWebGPU ? 'detected' : 'not available'})` });
