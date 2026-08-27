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

/**
 * What Zotero recorded for this plugin, or nulls when it has never seen it.
 *
 * extensions.json is plain JSON (unlike addonStartup.json.lz4) and holds the
 * version Zotero believes is installed. That registration is the thing that
 * goes stale, so it is worth reading.
 */
function readRegistration(profile, id) {
  const file = path.join(profile, 'extensions.json');
  try {
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    const addon = (db.addons || []).find((a) => a.id === id);
    if (!addon) return { registeredVersion: null, registeredPath: null };
    return {
      registeredVersion: addon.version ?? null,
      registeredPath: addon.path ?? null,
    };
  } catch {
    // No file yet, or a shape we do not recognise: report nothing rather than
    // inventing a problem.
    return { registeredVersion: null, registeredPath: null };
  }
}

/**
 * Decide what is wrong, in the order that matters to the developer.
 *
 * Pure on purpose: the ordering is the whole point (an XPI outranks everything
 * because it outranks everything inside Zotero too), and it is worth pinning in
 * a test rather than rediscovering it at a debugging session.
 */
function diagnose({
  hasXpi,
  hasProxy,
  proxyTarget,
  buildDir,
  buildVersion,
  registeredVersion,
  registeredPath,
}) {
  if (hasXpi) return { status: 'xpi' };
  if (!hasProxy) return { status: 'not-installed' };
  if (proxyTarget !== buildDir) return { status: 'wrong-target', proxyTarget, buildDir };

  // Zotero keeps the version it first read for a proxy install and does not
  // refresh it on rebuild, so once a release overtakes that number, update.json
  // looks newer and the background update check drops the released XPI right on
  // top of the proxy — mid-session, with no prompt.
  // Each side guards its own null: before Zotero has ever started, there is no
  // registration to be stale, and warning about it would be noise.
  const versionDrifted = registeredVersion !== null && registeredVersion !== buildVersion;
  const pathDrifted = registeredPath !== null && registeredPath !== buildDir;
  if (versionDrifted || pathDrifted) {
    return { status: 'stale-registration', registeredVersion, registeredPath, buildVersion, buildDir };
  }

  return { status: 'ok' };
}

function report(ctx) {
  const { id, profile, buildDir, proxyFile, xpiFile } = ctx;
  const hasProxy = fs.existsSync(proxyFile) && fs.statSync(proxyFile).isFile();

  const d = diagnose({
    hasXpi: fs.existsSync(xpiFile),
    hasProxy,
    proxyTarget: hasProxy ? fs.readFileSync(proxyFile, 'utf8').trim() : null,
    buildDir,
    buildVersion: buildVersionOrNull(buildDir),
    ...readRegistration(profile, id),
  });

  console.log(`Plugin:  ${id}`);
  console.log(`Profile: ${profile}`);
  console.log(`Build:   ${buildDir}${fs.existsSync(buildDir) ? '' : '  (MISSING - run npm run build)'}`);
  console.log('');

  switch (d.status) {
    case 'xpi':
      console.log('LOADING FROM XPI. An installed XPI overrides the proxy file, so');
      console.log('rebuilt code will NOT take effect. Fix with: npm run dev:install');
      console.log(`  ${xpiFile}`);
      return 1;
    case 'not-installed':
      console.log('NOT INSTALLED. No XPI and no proxy file for this plugin.');
      console.log('Fix with: npm run dev:install');
      return 1;
    case 'wrong-target':
      console.log('PROXY POINTS ELSEWHERE. Zotero is loading a different directory:');
      console.log(`  proxy -> ${d.proxyTarget}`);
      console.log(`  build -> ${d.buildDir}`);
      console.log('Fix with: npm run dev:install');
      return 1;
    case 'stale-registration':
      console.log("STALE REGISTRATION. The proxy file is correct, but Zotero's record of");
      console.log('this plugin disagrees with the build directory:');
      if (d.registeredVersion !== d.buildVersion) {
        console.log(`  Zotero has -> ${d.registeredVersion}`);
        console.log(`  build is   -> ${d.buildVersion}`);
      }
      if (d.registeredPath !== d.buildDir) {
        console.log(`  Zotero has -> ${d.registeredPath}`);
        console.log(`  build is   -> ${d.buildDir}`);
      }
      console.log('');
      console.log('While the recorded version is behind the released one, Zotero will');
      console.log('install the published XPI over the proxy at its next update check,');
      console.log('with no prompt. Fix with: npm run dev:install (quit Zotero first).');
      return 1;
    default:
      console.log('Dev mode active: proxy file points at this build directory.');
      return 0;
  }
}

/** Version in the built manifest, or null when there is no build yet. */
function buildVersionOrNull(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function install(ctx) {
  const { id, profile, buildDir, extensionsDir, proxyFile, xpiFile } = ctx;

  if (zoteroIsRunning()) {
    console.error('Zotero is running. Quit it first: Zotero can remove proxy files it did');
    console.error('not create, and rewrites the extension caches on shutdown.');
    return 1;
  }

  if (!fs.existsSync(buildDir)) {
    console.error(`No build directory at ${buildDir}. Run: npm run build`);
    return 1;
  }

  fs.mkdirSync(extensionsDir, { recursive: true });

  // extensions.json and addonStartup.json.lz4 carry the stale registration, so
  // removing them is what makes Zotero re-read the build's real version.
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
  return 0;
}

function main() {
  const id = pluginId();
  const profile = process.env.ZOTERO_PROFILE || profileDir();
  const extensionsDir = path.join(profile, 'extensions');
  const proxyFile = path.join(extensionsDir, id);
  const ctx = { id, profile, buildDir, extensionsDir, proxyFile, xpiFile: `${proxyFile}.xpi` };

  process.exit(process.argv.slice(2).includes('--status') ? report(ctx) : install(ctx));
}

// Guarded so the pure helpers can be required from a test without the CLI
// running (and exiting the test process).
if (require.main === module) main();

module.exports = { diagnose, readRegistration };
