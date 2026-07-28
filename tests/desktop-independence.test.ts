import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..');

function collectSourceFiles(relativePath: string): string[] {
  const absolutePath = path.join(root, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [absolutePath];

  const files: string[] = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.name === 'mcp') continue;
    const child = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path.relative(root, child)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

test('desktop source does not import MCP implementation or SDK modules', () => {
  const desktopFiles = [
    ...collectSourceFiles('src/main'),
    ...collectSourceFiles('src/renderer'),
    path.join(root, 'src/index.ts'),
    path.join(root, 'src/preload.ts'),
    path.join(root, 'forge.config.ts'),
    path.join(root, 'webpack.main.config.ts'),
    path.join(root, 'webpack.renderer.config.ts'),
  ];
  const forbiddenPatterns = [
    /@modelcontextprotocol\/sdk/,
    /(?:from|import)\s+['"][^'"]*(?:src\/mcp|\/mcp(?:\/|['"]))/,
    /require\(['"][^'"]*(?:src\/mcp|\/mcp(?:\/|['"]))/,
  ];

  const offenders = desktopFiles.filter((filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    return forbiddenPatterns.some((pattern) => pattern.test(content));
  });

  assert.deepEqual(offenders.map((filePath) => path.relative(root, filePath)), []);
});

test('desktop adapter depends on core planning and processing', () => {
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/register-ipc.ts'), 'utf-8');
  const runBatch = fs.readFileSync(path.join(root, 'src/main/processing/run-batch.ts'), 'utf-8');

  assert.match(ipc, /from '\.\.\/\.\.\/core\/files\/scan-input'/);
  assert.match(ipc, /from '\.\.\/\.\.\/core\/files\/output-plan'/);
  assert.match(ipc, /DesktopPlanStore/);
  assert.match(runBatch, /from '\.\.\/\.\.\/core\/processing\/run-batch'/);
});

test('desktop release config exposes independent app installers', () => {
  const forgeConfig = fs.readFileSync(path.join(root, 'forge.config.ts'), 'utf-8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const backgroundRunner = fs.readFileSync(
    path.join(root, 'src/main/processing/run-background-removal.ts'),
    'utf-8',
  );

  assert.match(forgeConfig, /MakerDMG/);
  assert.match(forgeConfig, /name: 'Image-Puma'/);
  assert.match(forgeConfig, /setupExe: 'Image-Puma-Setup\.exe'/);
  assert.match(forgeConfig, /assets', 'icons', 'image-puma'/);
  assert.match(forgeConfig, /assets', 'icons', 'image-puma\.ico'/);
  assert.match(forgeConfig, /postPackage/);
  assert.match(forgeConfig, /'--force', '--deep', '--sign', '-'/);
  assert.match(forgeConfig, /build', 'background-removal-runtime'/);
  assert.match(forgeConfig, /RMBG-2\.0-NOTICE\.txt/);
  assert.match(packageJson.scripts.package, /background-removal:bundle/);
  assert.match(packageJson.scripts.package, /desktop:verify-package/);
  assert.match(packageJson.scripts.make, /background-removal:bundle/);
  assert.match(packageJson.scripts.make, /desktop:verify-package/);
  assert.doesNotMatch(backgroundRunner, /image-background-remover-gui/);
  assert.doesNotMatch(backgroundRunner, /BACKGROUND_REMOVER_REPO/);
  assert.match(backgroundRunner, /app\.isPackaged/);
  assert.match(backgroundRunner, /background-removal-runtime/);
});

test('background removal disclosure opens only the allowlisted model page and promises no user token storage', () => {
  const channels = fs.readFileSync(path.join(root, 'src/shared/channels.ts'), 'utf-8');
  const preload = fs.readFileSync(path.join(root, 'src/preload.ts'), 'utf-8');
  const rendererApi = fs.readFileSync(path.join(root, 'src/renderer/api.ts'), 'utf-8');
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/register-ipc.ts'), 'utf-8');
  const disclosure = fs.readFileSync(
    path.join(root, 'src/renderer/components/BackgroundRemovalModelInfoButton.tsx'),
    'utf-8',
  );
  const packageVerifier = fs.readFileSync(
    path.join(root, 'scripts/verify-desktop-package.js'),
    'utf-8',
  );

  assert.match(channels, /OPEN_RMBG_MODEL_PAGE/);
  assert.match(preload, /openRmbgModelPage/);
  assert.match(rendererApi, /openRmbgModelPage/);
  assert.match(ipc, /https:\/\/huggingface\.co\/briaai\/RMBG-2\.0/);
  assert.match(ipc, /shell\.openExternal\(RMBG_MODEL_PAGE_URL\)/);
  assert.match(disclosure, /Image Puma never asks for or stores your Hugging Face token\./);
  assert.match(disclosure, /Review terms on Hugging Face/);
  assert.match(packageVerifier, /build-time Hugging Face credential was packaged/);
});
