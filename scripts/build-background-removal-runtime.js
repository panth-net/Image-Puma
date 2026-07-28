#!/usr/bin/env node

const { existsSync } = require('node:fs');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const buildRoot = path.join(root, '.background-removal-build');
const venvPath = path.join(buildRoot, 'venv');
const outputPath = path.join(root, 'build', 'background-removal-runtime');
const requirementsPath = path.join(root, 'requirements-background-removal.txt');
const builderPath = path.join(__dirname, 'package-background-removal-runtime.py');

function run(command, args, options = {}) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function canRun(command) {
  const result = spawnSync(command, ['-c', 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)'], {
    cwd: root,
    env: process.env,
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
}

function findBuildPython() {
  const configured = process.env.BACKGROUND_REMOVER_BUILD_PYTHON;
  const candidates = [
    configured,
    process.platform === 'win32' ? 'py' : '',
    'python3.11',
    'python3',
    'python',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'py') {
      const result = spawnSync(candidate, ['-3.11', '-c', 'import sys; print(sys.executable)'], {
        cwd: root,
        env: process.env,
        encoding: 'utf-8',
      });
      if (!result.error && result.status === 0) {
        return { command: candidate, prefixArgs: ['-3.11'] };
      }
      continue;
    }
    if (canRun(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }

  throw new Error(
    'Python 3.11 is required to build the bundled background remover. '
    + 'Install it or set BACKGROUND_REMOVER_BUILD_PYTHON.',
  );
}

function venvPythonPath() {
  return process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
}

async function main() {
  await mkdir(buildRoot, { recursive: true });
  const buildPython = findBuildPython();
  const venvPython = venvPythonPath();

  if (!existsSync(venvPython)) {
    run(buildPython.command, [...buildPython.prefixArgs, '-m', 'venv', venvPath]);
  }

  run(venvPython, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--quiet',
    '-r',
    requirementsPath,
  ]);
  run(venvPython, [
    builderPath,
    '--output',
    outputPath,
    '--work-root',
    path.join(buildRoot, 'pyinstaller'),
  ]);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
