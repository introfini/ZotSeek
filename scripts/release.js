const fs = require('fs');
const path = require('path');
const { createWriteStream } = require('fs');
const archiver = require('archiver');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const buildDir = path.resolve(rootDir, 'build');
const manifestPath = path.resolve(rootDir, 'manifest.json');
const updateJsonPath = path.resolve(rootDir, 'update.json');

// GitHub repo info for update URLs
const GITHUB_OWNER = 'introfini';
const GITHUB_REPO = 'ZotSeek';

/**
 * Generate update.json from manifest.json version
 */
function generateUpdateJson(version) {
  const updateJson = {
    addons: {
      'zotseek@zotero.org': {
        updates: [
          {
            version: version,
            update_link: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/zotseek-${version}.xpi`,
            applications: {
              zotero: {
                strict_min_version: '7.999',
                strict_max_version: '9.*'
              }
            }
          }
        ]
      }
    }
  };

  fs.writeFileSync(updateJsonPath, JSON.stringify(updateJson, null, 2) + '\n');
  console.log(`Generated update.json for v${version}`);
}

/**
 * Sync version to manifest.json (bumpp updates package.json, we sync to manifest)
 */
function syncManifestVersion(version) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Updated manifest.json to v${version}`);
}

/**
 * Create XPI package
 */
async function createXpi(version) {
  const xpiName = `zotseek-${version}.xpi`;
  const xpiPath = path.resolve(rootDir, xpiName);

  console.log(`\nPackaging ${xpiName}...`);

  await new Promise((resolve, reject) => {
    const output = createWriteStream(xpiPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`Created ${xpiName} (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`);
      resolve();
    });

    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(buildDir, false);
    archive.finalize();
  });

  return xpiPath;
}

async function release() {
  console.log('ZotSeek Release\n');

  // Step 1: Run bumpp to get new version (interactive)
  console.log('Step 1: Version bump\n');
  const bumppResult = spawnSync('npx', ['bumpp', '--no-commit', '--no-tag', '--no-push'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  });

  if (bumppResult.status !== 0) {
    console.error('Version bump cancelled or failed');
    process.exit(1);
  }

  // Read the new version from package.json (bumpp updated it)
  const pkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
  const version = pkg.version;

  // Step 2: Sync manifest.json and generate update.json
  console.log('\nStep 2: Sync version files\n');
  syncManifestVersion(version);
  generateUpdateJson(version);

  // Step 3: Build
  console.log('\nStep 3: Build\n');
  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  });

  if (buildResult.status !== 0) {
    console.error('Build failed');
    process.exit(1);
  }

  // Step 4: Package XPI
  console.log('\nStep 4: Package XPI');
  const xpiPath = await createXpi(version);

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`Release v${version} ready!`);
  console.log('='.repeat(50));
  console.log('\nFiles updated:');
  console.log(`  - package.json (v${version})`);
  console.log(`  - manifest.json (v${version})`);
  console.log(`  - update.json (v${version})`);
  console.log(`  - ${path.basename(xpiPath)}`);
  console.log('\nNext steps:');
  console.log('  1. Review the changes: git diff');
  console.log('  2. Commit: git add -A && git commit -m "Release v' + version + '"');
  console.log('  3. Tag: git tag v' + version);
  console.log('  4. Push: git push && git push --tags');
  console.log('  5. Create GitHub release and upload the XPI');
}

release().catch(err => {
  console.error('Release failed:', err);
  process.exit(1);
});
