#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MCP_DEPENDENCIES = [
  '@modelcontextprotocol/sdk',
  'exiftool-vendored',
  'p-limit',
  'sharp',
  'zod',
];

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

async function copyIfExists(source, destination) {
  try {
    await fs.copyFile(source, destination);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function main() {
  const { platform, arch } = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf-8'));
  const stageDir = path.join(ROOT, 'build', 'mcpb', `image-puma-mcp-${platform}-${arch}`);
  const distCli = path.join(ROOT, 'dist', 'cli.js');

  await fs.access(distCli).catch(() => {
    throw new Error('dist/cli.js is missing. Run npm run build:mcp before preparing MCPB.');
  });

  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });
  await fs.cp(path.join(ROOT, 'dist'), path.join(stageDir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(stageDir, 'assets', 'icons'), { recursive: true });
  // android-chrome-512x512.png is the MCPB manifest icon; image-puma-48.png is
  // the small icon the MCP server inlines into its own metadata.
  for (const iconName of ['android-chrome-512x512.png', 'image-puma-48.png']) {
    await fs.copyFile(
      path.join(ROOT, 'assets', 'icons', iconName),
      path.join(stageDir, 'assets', 'icons', iconName),
    );
  }
  await fs.copyFile(path.join(ROOT, 'mcpb', 'manifest.json'), path.join(stageDir, 'manifest.json'));
  await copyIfExists(path.join(ROOT, 'LICENSE'), path.join(stageDir, 'LICENSE'));

  const dependencies = {};
  for (const name of MCP_DEPENDENCIES) {
    dependencies[name] = packageJson.dependencies[name];
    if (!dependencies[name]) throw new Error(`Missing MCP runtime dependency in package.json: ${name}`);
  }

  await fs.writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify({
    name: 'image-puma-mcp-bundle',
    version: packageJson.version,
    private: true,
    description: 'Bundled Image Puma MCP server runtime.',
    main: 'dist/cli.js',
    dependencies,
    engines: packageJson.engines,
    license: packageJson.license,
  }, null, 2)}\n`);

  const install = spawnSync(command('npm'), [
    'install',
    '--omit=dev',
    '--include=optional',
    '--no-audit',
    '--no-fund',
    `--os=${platform}`,
    `--cpu=${arch}`,
  ], {
    cwd: stageDir,
    stdio: 'inherit',
  });

  if (install.status !== 0) {
    throw new Error(`npm install failed while preparing MCPB for ${platform}-${arch}.`);
  }

  process.stdout.write(`${stageDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
