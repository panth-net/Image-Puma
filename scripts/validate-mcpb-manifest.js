#!/usr/bin/env node
/**
 * Validates mcpb/manifest.json with the MCPB CLI.
 *
 * The manifest's asset paths (notably `icon`) are relative to the manifest file,
 * and they are only correct once the manifest sits at the root of a staged
 * bundle. Validating `mcpb/manifest.json` in place therefore fails icon
 * resolution even though the packed artifact is fine. This stages the manifest
 * plus its referenced assets into a temp directory and validates that instead,
 * so the check matches what actually ships without requiring a full build.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MCPB_CLI = path.join(ROOT, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(MCPB_CLI)) {
    fail('The MCPB CLI is not installed. Run npm install first.');
  }

  const manifestPath = path.join(ROOT, 'mcpb', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-puma-manifest-'));
  try {
    fs.copyFileSync(manifestPath, path.join(stageDir, 'manifest.json'));

    if (typeof manifest.icon === 'string' && manifest.icon.trim()) {
      const source = path.join(ROOT, manifest.icon);
      if (!fs.existsSync(source)) {
        fail(`manifest.json icon is missing from the repository: ${manifest.icon}`);
      }
      const target = path.join(stageDir, manifest.icon);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }

    const result = spawnSync(
      process.execPath,
      [MCPB_CLI, 'validate', path.join(stageDir, 'manifest.json')],
      { stdio: 'inherit' },
    );

    if (result.status !== 0) {
      fail('MCPB manifest validation failed.');
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

main();
