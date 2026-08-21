const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const isDev = args.includes('--dev');
const isWatch = args.includes('--watch');

const buildDir = path.resolve(__dirname, '../build');
const srcDir = path.resolve(__dirname, '../src');

// Ensure build directory exists
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

// Copy static files
function copyStaticFiles() {
  const staticDirs = ['content', 'locale', 'skin'];

  for (const dir of staticDirs) {
    const srcPath = path.resolve(__dirname, '..', dir);
    const destPath = path.resolve(buildDir, dir);

    if (fs.existsSync(srcPath)) {
      fs.cpSync(srcPath, destPath, { recursive: true });
      console.log(`Copied ${dir}/`);

      // Special handling for models directory
      if (dir === 'content') {
        const modelsPath = path.resolve(srcPath, 'models');
        if (fs.existsSync(modelsPath)) {
          const destModelsPath = path.resolve(destPath, 'models');
          fs.cpSync(modelsPath, destModelsPath, { recursive: true });
          console.log('  - Copied bundled model files');
        }
      }
    }
  }

  // Copy manifest.json
  const manifestSrc = path.resolve(__dirname, '../manifest.json');
  const manifestDest = path.resolve(buildDir, 'manifest.json');
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, manifestDest);
    console.log('Copied manifest.json');
  }

  // Copy bootstrap.js if it exists
  const bootstrapSrc = path.resolve(__dirname, '../bootstrap.js');
  const bootstrapDest = path.resolve(buildDir, 'bootstrap.js');
  if (fs.existsSync(bootstrapSrc)) {
    fs.copyFileSync(bootstrapSrc, bootstrapDest);
    console.log('Copied bootstrap.js');
  }

  // Copy prefs.js if it exists (default preferences)
  const prefsSrc = path.resolve(__dirname, '../prefs.js');
  const prefsDest = path.resolve(buildDir, 'prefs.js');
  if (fs.existsSync(prefsSrc)) {
    fs.copyFileSync(prefsSrc, prefsDest);
    console.log('Copied prefs.js');
  }

  // Copy WASM files from Transformers.js for ONNX Runtime
  const wasmSrcDir = path.resolve(__dirname, '../content/wasm');
  const wasmDestDir = path.resolve(buildDir, 'content/wasm');
  if (fs.existsSync(wasmSrcDir)) {
    fs.mkdirSync(wasmDestDir, { recursive: true });
    fs.cpSync(wasmSrcDir, wasmDestDir, { recursive: true });
    console.log('Copied WASM files for ONNX Runtime');
  }
}

/**
 * Copy Transformers.js v3 WASM files from node_modules
 * These are needed for ONNX Runtime in the ChromeWorker
 */
function copyTransformersV3Files() {
  // Primary source: transformers.js dist folder
  const transformersDir = path.resolve(__dirname, '../node_modules/@huggingface/transformers/dist');
  // Fallback: onnxruntime-web nested in transformers
  const ortDir = path.resolve(__dirname, '../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist');
  const wasmDestDir = path.resolve(buildDir, 'content/wasm');
  
  // Ensure destination exists
  fs.mkdirSync(wasmDestDir, { recursive: true });
  
  // Files needed for v3 - ONNX Runtime WASM files
  // v3 uses JSEP (JavaScript Execution Provider) variants
  const v3Files = [
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    // Also copy the non-JSEP versions if available (for fallback)
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
  ];
  
  let copiedCount = 0;
  for (const file of v3Files) {
    // Try transformers dist first, then onnxruntime-web
    let srcPath = path.join(transformersDir, file);
    if (!fs.existsSync(srcPath)) {
      srcPath = path.join(ortDir, file);
    }
    
    const destPath = path.join(wasmDestDir, file);
    
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  Copied v3 WASM file: ${file}`);
      copiedCount++;
    } else {
      console.warn(`  Warning: v3 WASM file not found: ${file}`);
    }
  }
  
  if (copiedCount > 0) {
    console.log(`Copied ${copiedCount} Transformers.js v3 WASM files`);
  } else {
    console.warn('Warning: No v3 WASM files found. Make sure @huggingface/transformers is installed.');
  }
}

// Polyfill for Transformers.js - it expects `self` and `navigator` to exist
// (browser/worker env). Shared module so tests can pin its semantics: it must
// never shadow the native worker globals (see scripts/polyfill-banner.js).
const { polyfillBanner } = require('./polyfill-banner.js');

// Build configuration
const buildOptions = {
  entryPoints: [path.resolve(srcDir, 'index.ts')],
  bundle: true,
  outfile: path.resolve(buildDir, 'content/scripts/index.js'),
  format: 'iife',
  // No globalName - we attach to Zotero directly in the script
  platform: 'browser',
  target: ['firefox128'],  // Zotero 8 uses Firefox 128+ ESR
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  banner: {
    js: polyfillBanner,
  },
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  external: [],
  loader: {
    '.wasm': 'file',
  },
  logLevel: 'info',
};

// Worker build configuration (separate bundle with Transformers.js)
const workerBuildOptions = {
  entryPoints: [path.resolve(srcDir, 'worker/embedding-worker.ts')],
  bundle: true,
  outfile: path.resolve(buildDir, 'content/scripts/embedding-worker.js'),
  format: 'iife',
  platform: 'browser',
  target: ['firefox128'],
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  banner: {
    js: polyfillBanner,
  },
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  external: [],
  logLevel: 'info',
};

// Search dialog with VTable build configuration
const searchDialogBuildOptions = {
  entryPoints: [path.resolve(srcDir, 'ui/search-dialog-vtable.ts')],
  bundle: true,
  outfile: path.resolve(buildDir, 'content/scripts/search-dialog-vtable.js'),
  format: 'iife',
  platform: 'browser',
  target: ['firefox128'],
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  external: [],
  logLevel: 'info',
};

// Similar documents dialog build configuration
const similarDocsBuildOptions = {
  entryPoints: [path.resolve(srcDir, 'ui/similar-documents-dialog.ts')],
  bundle: true,
  outfile: path.resolve(buildDir, 'content/scripts/similar-documents-dialog.js'),
  format: 'iife',
  platform: 'browser',
  target: ['firefox128'],
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  external: [],
  logLevel: 'info',
};

// Collection export dialog build configuration
const collectionExportDialogBuildOptions = {
  entryPoints: [path.resolve(srcDir, 'ui/collection-export-dialog.ts')],
  bundle: true,
  outfile: path.resolve(buildDir, 'content/scripts/collection-export-dialog.js'),
  format: 'iife',
  platform: 'browser',
  target: ['firefox128'],
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  external: [],
  logLevel: 'info',
};


async function build() {
  try {
    copyStaticFiles();
    copyTransformersV3Files();

    if (isWatch) {
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
      console.log('Watching for changes...');
    } else {
      // Build main plugin
      await esbuild.build(buildOptions);
      console.log('Main bundle complete!');

      // Build worker with Transformers.js
      console.log('Building worker with Transformers.js...');
      await esbuild.build(workerBuildOptions);
      console.log('Worker bundle complete!');

      // Build search dialog with VTable
      console.log('Building search dialog with VirtualizedTable...');
      await esbuild.build(searchDialogBuildOptions);
      console.log('Search dialog bundle complete!');
      
      await esbuild.build(similarDocsBuildOptions);
      console.log('Similar documents dialog bundle complete!');

      await esbuild.build(collectionExportDialogBuildOptions);
      console.log('Collection export dialog bundle complete!');

      console.log('Build complete!');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();

