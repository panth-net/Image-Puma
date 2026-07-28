#!/usr/bin/env node
/**
 * Syncs release metadata to the current version and the freshly packed bundles.
 *
 * `server.json` pins each `.mcpb` by download URL and SHA-256, so both go stale
 * the moment the bundles are rebuilt or the version changes. Run this after
 * `npm run mcpb:pack` for every target and before publishing, then commit the
 * result. `npm run registry:validate` is the gate that proves it was run.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_MCPB = path.join(ROOT, 'dist-mcpb');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf-8'));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(ROOT, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  const packageJson = readJson('package.json');
  const server = readJson('server.json');
  const manifest = readJson('mcpb/manifest.json');
  const { version } = packageJson;

  const repositoryUrl = (server.repository?.url || '').replace(/\.git$/, '');
  if (!repositoryUrl) throw new Error('server.json needs repository.url before syncing release metadata.');

  server.version = version;
  manifest.version = version;

  const missing = [];
  for (const entry of server.packages) {
    if (entry.registryType === 'npm') {
      entry.identifier = packageJson.name;
      entry.version = version;
      continue;
    }

    if (entry.registryType !== 'mcpb') continue;

    const fileName = path.basename(entry.identifier);
    entry.identifier = `${repositoryUrl}/releases/download/v${version}/${fileName}`;

    const localArtifact = path.join(DIST_MCPB, fileName);
    if (!fs.existsSync(localArtifact)) {
      missing.push(fileName);
      continue;
    }
    entry.fileSha256 = fileSha256(localArtifact);
  }

  writeJson('server.json', server);
  writeJson('mcpb/manifest.json', manifest);

  process.stdout.write(`Synced release metadata to v${version}.\n`);
  if (missing.length > 0) {
    process.stdout.write(
      `Warning: no local artifact for ${missing.join(', ')}. `
      + 'Pack every target, then re-run, or registry:validate will not cover them.\n',
    );
  }
}

main();
