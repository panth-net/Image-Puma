#!/usr/bin/env node
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) {
  throw new Error(message);
}

function listEntries(artifactPath) {
  const result = spawnSync('unzip', ['-Z1', artifactPath], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    fail(`Could not list MCPB artifact entries: ${artifactPath}\n${result.stderr}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function hasEntry(entries, entry) {
  return entries.includes(entry);
}

function hasPrefix(entries, prefix) {
  return entries.some((entry) => entry.startsWith(prefix));
}

function verifyArtifact(artifactPath) {
  const fileName = path.basename(artifactPath);
  const entries = listEntries(artifactPath);

  for (const entry of [
    'manifest.json',
    'assets/icons/android-chrome-512x512.png',
    'dist/cli.js',
    'LICENSE',
    'node_modules/sharp/LICENSE',
    'node_modules/exiftool-vendored/LICENSE',
  ]) {
    if (!hasEntry(entries, entry)) fail(`${fileName} is missing ${entry}`);
  }

  if (!hasPrefix(entries, 'node_modules/@img/sharp-')) {
    fail(`${fileName} is missing Sharp platform binaries.`);
  }
  if (!hasPrefix(entries, 'node_modules/@img/sharp-libvips-') && !fileName.includes('win32')) {
    fail(`${fileName} is missing libvips platform binaries.`);
  }
  if (
    !hasEntry(entries, 'node_modules/exiftool-vendored.pl/LICENSE')
    && !hasEntry(entries, 'node_modules/exiftool-vendored.exe/LICENSE')
  ) {
    fail(`${fileName} is missing vendored ExifTool license files.`);
  }

  process.stdout.write(`MCPB artifact verified: ${fileName}\n`);
}

function main() {
  const artifacts = process.argv.slice(2);
  if (artifacts.length === 0) {
    fail('Usage: node scripts/verify-mcpb-artifact.js <artifact.mcpb> [...]');
  }
  for (const artifact of artifacts) {
    verifyArtifact(path.resolve(artifact));
  }
}

main();
