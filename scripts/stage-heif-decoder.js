#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'build', 'heif-decoder', 'node_modules');
const packages = ['heic-decode', 'libheif-js'];

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });

for (const name of packages) {
  const source = path.join(root, 'node_modules', name);
  if (!fs.existsSync(path.join(source, 'package.json'))) {
    throw new Error(`Missing ${name}. Run npm install before staging the HEIF decoder.`);
  }
  fs.cpSync(source, path.join(destination, name), {
    recursive: true,
    filter: (entry) => !entry.split(path.sep).includes('test'),
  });
}

process.stdout.write(`Staged HEIF decoder at ${destination}\n`);
