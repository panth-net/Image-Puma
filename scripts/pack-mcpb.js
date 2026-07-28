#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const config = {
    platform: process.platform,
    arch: process.arch,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const readValue = (option) => {
      if (arg.startsWith(`${option}=`)) return arg.slice(option.length + 1);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
      index += 1;
      return value;
    };

    if (arg === '--platform' || arg.startsWith('--platform=')) {
      config.platform = readValue('--platform');
    } else if (arg === '--arch' || arg.startsWith('--arch=')) {
      config.arch = readValue('--arch');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function writeSha256Sum(sumsPath, artifactName, hash) {
  const nextLine = `${hash}  ${artifactName}`;
  const existing = await fs.readFile(sumsPath, 'utf-8').catch((error) => {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  });
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.endsWith(`  ${artifactName}`));
  lines.push(nextLine);
  await fs.writeFile(sumsPath, `${lines.join('\n')}\n`);
}

async function main() {
  const { platform, arch } = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf-8'));
  const stageDir = path.join(ROOT, 'build', 'mcpb', `image-puma-mcp-${platform}-${arch}`);
  const outputDir = path.join(ROOT, 'dist-mcpb');
  const artifactName = `image-puma-mcp-${platform}-${arch}.mcpb`;
  const artifactPath = path.join(outputDir, artifactName);

  await fs.access(path.join(stageDir, 'manifest.json')).catch(() => {
    throw new Error(`MCPB stage is missing for ${platform}-${arch}. Run npm run mcpb:prepare -- --platform ${platform} --arch ${arch}.`);
  });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(artifactPath, { force: true });

  const pack = spawnSync(command('npx'), [
    '-y',
    '@anthropic-ai/mcpb@2.1.2',
    'pack',
    stageDir,
    artifactPath,
  ], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (pack.status !== 0) {
    throw new Error(`mcpb pack failed for ${platform}-${arch}.`);
  }

  const hash = await sha256(artifactPath);
  const sumsPath = path.join(outputDir, 'SHA256SUMS');
  await writeSha256Sum(sumsPath, artifactName, hash);
  process.stdout.write(`${artifactPath}\n${hash}\npackage ${packageJson.name}@${packageJson.version}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
