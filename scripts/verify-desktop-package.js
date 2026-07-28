#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outPath = path.join(root, 'out');
const tokenPattern = /hf_[A-Za-z0-9]{20,}/;
const forbiddenCredentialSegments = new Set([
  '.huggingface',
  'credentials',
  'stored_tokens',
  'token',
  'tokens',
]);
const requiredModelFiles = [
  'BiRefNet_config.py',
  'birefnet.py',
  'config.json',
  'model.safetensors',
];
const textExtensions = new Set(['.json', '.md', '.py', '.txt', '.yaml', '.yml']);
const buildCredentialValues = [
  process.env.HF_TOKEN,
  process.env.HUGGING_FACE_HUB_TOKEN,
  process.env.HUGGINGFACEHUB_API_TOKEN,
].filter((value) => typeof value === 'string' && value.length >= 12);

function walk(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    visit(entryPath, entry);
    if (entry.isDirectory()) walk(entryPath, visit);
  }
}

function findRuntimeManifests() {
  if (!fs.existsSync(outPath)) return [];
  const manifests = [];
  walk(outPath, (entryPath, entry) => {
    if (entry.isFile() && entry.name === 'runtime-manifest.json') {
      manifests.push(entryPath);
    }
  });
  return manifests;
}

function assertNoCredentialPath(filePath, relativePath) {
  const segments = relativePath.split(path.sep).map((segment) => segment.toLowerCase());
  const forbidden = segments.find((segment) => forbiddenCredentialSegments.has(segment));
  if (forbidden) {
    throw new Error(`Credential-like path "${forbidden}" was packaged at ${filePath}`);
  }
}

function scanFileForBuildCredentials(filePath) {
  if (buildCredentialValues.length === 0) return;

  for (const credential of buildCredentialValues) {
    const needle = Buffer.from(credential);
    const handle = fs.openSync(filePath, 'r');
    const chunk = Buffer.allocUnsafe(1024 * 1024 + needle.length);
    let overlapLength = 0;
    let position = 0;
    let found = false;
    try {
      while (true) {
        const bytesRead = fs.readSync(
          handle,
          chunk,
          overlapLength,
          chunk.length - overlapLength,
          position,
        );
        if (bytesRead === 0) break;
        const searchableLength = overlapLength + bytesRead;
        if (chunk.subarray(0, searchableLength).includes(needle)) {
          found = true;
          break;
        }
        overlapLength = Math.min(needle.length - 1, searchableLength);
        chunk.copyWithin(0, searchableLength - overlapLength, searchableLength);
        position += bytesRead;
      }
    } finally {
      fs.closeSync(handle);
    }
    if (found) {
      throw new Error(`A build-time Hugging Face credential was packaged in ${filePath}`);
    }
  }
}

function scanControlledTextFile(filePath, relativePath) {
  const stat = fs.statSync(filePath);
  const isThirdPartyRuntime = relativePath.split(path.sep).includes('_internal');
  if (
    isThirdPartyRuntime
    || stat.size > 5 * 1024 * 1024
    || !textExtensions.has(path.extname(filePath).toLowerCase())
  ) {
    return;
  }
  const contents = fs.readFileSync(filePath, 'utf-8');
  if (tokenPattern.test(contents)) {
    throw new Error(`A Hugging Face token-shaped value was packaged in ${filePath}`);
  }
}

function verifyRuntime(manifestPath) {
  const runtimePath = path.dirname(manifestPath);
  const modelPath = path.join(runtimePath, 'model');
  const executableName = process.platform === 'win32'
    ? 'background_remove_batch.exe'
    : 'background_remove_batch';

  if (!fs.existsSync(path.join(runtimePath, executableName))) {
    throw new Error(`Missing bundled background remover executable in ${runtimePath}`);
  }
  for (const filename of requiredModelFiles) {
    if (!fs.existsSync(path.join(modelPath, filename))) {
      throw new Error(`Missing bundled model file ${filename} in ${modelPath}`);
    }
  }

  walk(runtimePath, (entryPath, entry) => {
    const relativePath = path.relative(runtimePath, entryPath);
    assertNoCredentialPath(entryPath, relativePath);
    if (entry.isFile()) {
      scanFileForBuildCredentials(entryPath);
      scanControlledTextFile(entryPath, relativePath);
    }
  });

  const resourcesPath = path.dirname(runtimePath);
  const asarPath = path.join(resourcesPath, 'app.asar');
  if (fs.existsSync(asarPath)) {
    scanFileForBuildCredentials(asarPath);
    const asarContents = fs.readFileSync(asarPath).toString('latin1');
    if (tokenPattern.test(asarContents)) {
      throw new Error(`A Hugging Face token-shaped value was packaged in ${asarPath}`);
    }
  }

  process.stdout.write(`Verified credential-free bundled runtime: ${runtimePath}\n`);
}

const manifests = findRuntimeManifests();
if (manifests.length === 0) {
  throw new Error(`No packaged background-removal runtime found under ${outPath}`);
}
for (const manifestPath of manifests) verifyRuntime(manifestPath);
