#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const forgeBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-forge.cmd' : 'electron-forge',
);
const restartExitCode = Number(process.env.IMAGE_PUMA_DEV_RESTART_CODE || 250);
const restartFile = path.join(projectRoot, '.webpack', 'dev-restart-request');
const restartDebounceMs = 250;
const restartDelayMs = 300;
const supportsRecursiveWatch = process.platform === 'darwin' || process.platform === 'win32';

const watchEntries = [
  'src/index.ts',
  'src/preload.ts',
  'src/core',
  'src/main',
  'src/shared',
  'forge.config.ts',
  'webpack.main.config.ts',
  'webpack.rules.ts',
  'webpack.plugins.ts',
  'package.json',
];

let child = null;
let childRestarting = false;
let shuttingDown = false;
let restartTimer = null;
let pendingRestartReason = '';
let lastRestartRequest = readRestartRequest();

function readRestartRequest() {
  try {
    return fs.readFileSync(restartFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function ensureRestartFileParent() {
  fs.mkdirSync(path.dirname(restartFile), { recursive: true });
}

function runPortCleanup() {
  spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'kill-dev-port.js')], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });
}

function startForge() {
  ensureRestartFileParent();
  console.log('[dev-watch] starting electron-forge start');

  childRestarting = false;
  child = spawn(forgeBin, ['start'], {
    cwd: projectRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      IMAGE_PUMA_DEV_WATCH: '1',
      IMAGE_PUMA_DEV_RESTART_CODE: String(restartExitCode),
      IMAGE_PUMA_DEV_RESTART_FILE: restartFile,
    },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    child = null;

    const restartRequest = readRestartRequest();
    const wasDevRestart = code === restartExitCode || restartRequest !== lastRestartRequest;
    if (restartRequest !== lastRestartRequest) {
      lastRestartRequest = restartRequest;
    }

    if (shuttingDown) {
      process.exit(code ?? (signal ? 1 : 0));
    }

    if (childRestarting || wasDevRestart) {
      runPortCleanup();
      setTimeout(startForge, restartDelayMs);
      return;
    }

    process.exit(code ?? (signal ? 1 : 0));
  });
}

function killChild(signal = 'SIGTERM') {
  if (!child) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }
}

function restart(reason) {
  pendingRestartReason = '';
  restartTimer = null;

  if (shuttingDown) return;

  console.log(`[dev-watch] restarting for ${reason}`);
  childRestarting = true;

  if (!child) {
    runPortCleanup();
    startForge();
    return;
  }

  const currentChild = child;
  killChild('SIGTERM');

  setTimeout(() => {
    if (child === currentChild) {
      killChild('SIGKILL');
    }
  }, 2500);
}

function requestRestart(reason) {
  pendingRestartReason = reason;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => restart(pendingRestartReason), restartDebounceMs);
}

function shouldIgnore(filePath) {
  const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  return rel.startsWith('.webpack/')
    || rel.startsWith('dist-tests/')
    || rel.includes('/node_modules/')
    || rel.endsWith('.map')
    || rel.endsWith('.log')
    || rel.endsWith('.DS_Store');
}

function collectDirectoryWatchers(directory) {
  const watchers = [directory];
  if (supportsRecursiveWatch) return watchers;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.webpack') continue;
    watchers.push(...collectDirectoryWatchers(path.join(directory, entry.name)));
  }

  return watchers;
}

function watchEntry(entry) {
  const absolutePath = path.join(projectRoot, entry);
  if (!fs.existsSync(absolutePath)) return;

  const stat = fs.statSync(absolutePath);
  const targets = stat.isDirectory() ? collectDirectoryWatchers(absolutePath) : [absolutePath];

  for (const target of targets) {
    const targetStat = fs.statSync(target);
    const watcher = fs.watch(
      target,
      targetStat.isDirectory() && supportsRecursiveWatch ? { recursive: true } : {},
      (_eventType, filename) => {
        const changedPath = filename ? path.join(target, String(filename)) : target;
        if (shouldIgnore(changedPath)) return;
        const rel = path.relative(projectRoot, changedPath).replace(/\\/g, '/') || entry;
        requestRestart(rel);
      },
    );

    watcher.on('error', (error) => {
      console.warn(`[dev-watch] watcher failed for ${path.relative(projectRoot, target)}: ${error.message}`);
    });
  }
}

function shutdown(signal) {
  shuttingDown = true;
  console.log(`[dev-watch] received ${signal}, stopping dev app`);
  if (restartTimer) clearTimeout(restartTimer);

  if (!child) {
    process.exit(0);
    return;
  }

  killChild('SIGTERM');
  setTimeout(() => {
    if (child) killChild('SIGKILL');
  }, 2500);
}

for (const entry of watchEntries) {
  watchEntry(entry);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startForge();
