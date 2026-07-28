const { execFileSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const port = Number(process.env.WEBPACK_DEV_PORT || 3045);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid WEBPACK_DEV_PORT: ${process.env.WEBPACK_DEV_PORT}`);
  process.exit(1);
}

function killPid(pid, label, signal = 'SIGKILL') {
  try {
    process.kill(pid, signal);
    console.log(`Killed ${label} process ${pid}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('ESRCH')) {
      console.warn(`Could not kill ${label} process ${pid}: ${message}`);
    }
  }
}

function killPortProcesses() {
  let output = '';
  try {
    output = execFileSync('lsof', ['-ti', `tcp:${port}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return;
  }

  const pids = output
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

  for (const pid of new Set(pids)) {
    killPid(pid, `port ${port}`);
  }
}

function getProjectDevPids() {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid,ppid,command'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const electronAppPath = path.join(
    projectRoot,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
  );
  const devWatchPath = path.join(projectRoot, 'scripts', 'dev-watch.js');

  return output
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      };
    })
    .filter((entry) => {
      if (!entry || entry.pid === process.pid || entry.ppid === process.pid) return false;
      const command = entry.command;
      return command.includes(electronAppPath)
        || command.includes(devWatchPath)
        || (command.includes(projectRoot) && command.includes('electron-forge') && command.includes('start'));
    })
    .map((entry) => entry.pid);
}

function killProjectDevProcesses() {
  const pids = Array.from(new Set(getProjectDevPids()));
  for (const pid of pids) {
    killPid(pid, 'project dev', 'SIGTERM');
  }

  if (pids.length === 0) return;

  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        killPid(pid, 'stubborn project dev');
      } catch {
        // Already exited after SIGTERM.
      }
    }
  }, 800);
}

killPortProcesses();
killProjectDevProcesses();
