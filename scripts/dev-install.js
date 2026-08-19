#!/usr/bin/env node
/**
 * Dev-mode install via proxy file.
 *
 * Zotero loads a plugin from a build directory when `<profile>/extensions/`
 * contains a plain text file named after the plugin ID holding the absolute
 * path to that directory. An installed XPI with the same ID always wins over
 * the proxy file, even with `-purgecaches`, which is the single most common
 * reason rebuilt code appears not to take effect.
 *
 *   npm run dev:install    remove any XPI, clear caches, write the proxy file
 *   npm run dev:status     report which one Zotero would load, and why
 *
 * Zotero must be closed for `dev:install`: it can clean up proxy files it did
 * not create, and the caches are rewritten on shutdown.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const buildDir = path.resolve(rootDir, 'build');
const statusOnly = process.argv.slice(2).includes('--status');

function pluginId() {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'manifest.json'), 'utf8'));
  const id = manifest.applications?.zotero?.id || manifest.browser_specific_settings?.gecko?.id;
  if (!id) throw new Error('No plugin ID in manifest.json (applications.zotero.id)');
  return id;
}

/** Zotero's profile root, per platform. */
function profilesRoot() {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Zotero');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Zotero', 'Zotero');
    default:
      return path.join(home, '.zotero', 'zotero');
  }
}

/**
 * Resolve the profile directory. profiles.ini is authoritative: it marks the
 * default profile and its Path may be absolute or relative to the root.
 */
function profileDir() {
  const root = profilesRoot();
  const iniPath = path.join(root, 'profiles.ini');

  if (fs.existsSync(iniPath)) {
    const ini = fs.readFileSync(iniPath, 'utf8');
    const sections = ini.split(/\r?\n\s*\[/).map((s) => `[${s.replace(/^\[/, '')}`);
    let fallback = null;
    for (const section of sections) {
      const p = section.match(/^\s*Path\s*=\s*(.+)$/m)?.[1]?.trim();
      if (!p) continue;
      const isRelative = /^\s*IsRelative\s*=\s*1\s*$/m.test(section);
      const resolved = isRelative ? path.join(root, p) : p;
      if (/^\s*Default\s*=\s*1\s*$/m.test(section)) return resolved;
      if (!fallback) fallback = resolved;
    }
    if (fallback) return fallback;
  }

  // No usable profiles.ini: fall back to the single *.default directory.
  const profilesDir = path.join(root, 'Profiles');
  if (fs.existsSync(profilesDir)) {
    const candidates = fs.readdirSync(profilesDir).filter((d) => d.endsWith('.default'));
    if (candidates.length === 1) return path.join(profilesDir, candidates[0]);
    if (candidates.length > 1) {
      throw new Error(`Several profiles found (${candidates.join(', ')}); set ZOTERO_PROFILE to pick one.`);
    }
  }
  throw new Error(`Could not locate a Zotero profile under ${root}`);
}

function zoteroIsRunning() {
  try {
    if (process.platform === 'win32') {
      return execSync('tasklist /FI "IMAGENAME eq zotero.exe"', { encoding: 'utf8' }).includes('zotero.exe');
    }
    execSync('pgrep -f "Zotero.app/Contents/MacOS/zotero|/zotero/zotero" >/dev/null 2>&1');
    return true;
  } catch {
    return false;
  }
}

const id = pluginId();
const profile = process.env.ZOTERO_PROFILE || profileDir();
const extensionsDir = path.join(profile, 'extensions');
const proxyFile = path.join(extensionsDir, id);
const xpiFile = `${proxyFile}.xpi`;

function report() {
  const hasXpi = fs.existsSync(xpiFile);
  const hasProxy = fs.existsSync(proxyFile) && fs.statSync(proxyFile).isFile();
  const proxyTarget = hasProxy ? fs.readFileSync(proxyFile, 'utf8').trim() : null;

  console.log(`Plugin:  ${id}`);
  console.log(`Profile: ${profile}`);
  console.log(`Build:   ${buildDir}${fs.existsSync(buildDir) ? '' : '  (MISSING - run npm run build)'}`);
  console.log('');

  if (hasXpi) {
    console.log('LOADING FROM XPI. An installed XPI overrides the proxy file, so');
    console.log('rebuilt code will NOT take effect. Fix with: npm run dev:install');
    console.log(`  ${xpiFile}`);
    return 1;
  }
  if (!hasProxy) {
    console.log('NOT INSTALLED. No XPI and no proxy file for this plugin.');
    console.log('Fix with: npm run dev:install');
    return 1;
  }
  if (proxyTarget !== buildDir) {
    console.log('PROXY POINTS ELSEWHERE. Zotero is loading a different directory:');
    console.log(`  proxy -> ${proxyTarget}`);
    console.log(`  build -> ${buildDir}`);
    console.log('Fix with: npm run dev:install');
    return 1;
  }
  console.log('Dev mode active: proxy file points at this build directory.');
  return 0;
}

if (statusOnly) {
  process.exit(report());
}

if (zoteroIsRunning()) {
  console.error('Zotero is running. Quit it first: Zotero can remove proxy files it did');
  console.error('not create, and rewrites the extension caches on shutdown.');
  process.exit(1);
}

if (!fs.existsSync(buildDir)) {
  console.error(`No build directory at ${buildDir}. Run: npm run build`);
  process.exit(1);
}

fs.mkdirSync(extensionsDir, { recursive: true });

const removed = [];
for (const target of [
  xpiFile,
  path.join(profile, 'extensions.json'),
  path.join(profile, 'addonStartup.json.lz4'),
  path.join(extensionsDir, 'staged', id),
  path.join(profile, 'startupCache'),
]) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(path.relative(profile, target));
  }
}

// Trailing newline is required: Zotero reads the file as a single path line.
fs.writeFileSync(proxyFile, `${buildDir}\n`, 'utf8');

console.log(`Plugin:  ${id}`);
console.log(`Profile: ${profile}`);
console.log(`Proxy:   ${proxyFile} -> ${buildDir}`);
if (removed.length) console.log(`Removed: ${removed.join(', ')}`);
console.log('');
console.log('Start Zotero with a cache purge:');
console.log('  open -a Zotero --args -purgecaches -jsconsole');
