#!/usr/bin/env node
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(command(cmd), args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : '';
    const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : '';
    throw new Error(`${cmd} ${args.join(' ')} failed.${stdout}${stderr}`);
  }
  return result;
}

function waitForMessage(messages, waiters, predicate, label, parseErrorRef) {
  if (parseErrorRef.error) return Promise.reject(parseErrorRef.error);
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`Timed out waiting for MCP response: ${label}`));
    }, 10000);
    waiters.push({ predicate, resolve, reject, timer });
  });
}

async function verifyMcpServe(commandPath, args, label) {
  const child = spawn(commandPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutBuffer = '';
  let stderr = '';
  const messages = [];
  const waiters = [];
  const parseErrorRef = { error: null };

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        parseErrorRef.error = new Error(`${label} wrote non-JSON stdout: ${line}\n${error.message}`);
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(parseErrorRef.error);
        }
        return;
      }

      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf-8');
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'image-puma-package-verify', version: '1.0.0' },
    },
  })}\n`);
  const init = await waitForMessage(messages, waiters, (message) => message.id === 1, `${label} initialize`, parseErrorRef);
  if (!init.result) throw new Error(`${label} did not initialize.\nstderr:\n${stderr}`);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const tools = await waitForMessage(messages, waiters, (message) => message.id === 2, `${label} tools/list`, parseErrorRef);
  const toolNames = tools.result?.tools?.map((tool) => tool.name) || [];
  if (!toolNames.includes('image_puma_plan') || !toolNames.includes('image_puma_run')) {
    throw new Error(`${label} did not expose Image Puma tools.\nstderr:\n${stderr}`);
  }

  child.kill('SIGTERM');
  process.stdout.write(`MCP serve verified: ${label}\n`);
}

async function main() {
  const pack = run('npm', ['pack', '--json'], { capture: true });
  const packed = JSON.parse(pack.stdout)[0];
  const tarball = path.join(ROOT, packed.filename);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-npm-install-'));
  const allowedRoot = path.join(tmpRoot, 'allowed');
  const appRoot = path.join(tmpRoot, 'app');

  try {
    await fs.mkdir(allowedRoot);
    await fs.mkdir(appRoot);
    await fs.writeFile(path.join(appRoot, 'package.json'), '{"private":true}\n');
    run('npm', [
      'install',
      '--omit=dev',
      '--include=optional',
      '--no-audit',
      '--no-fund',
      tarball,
    ], { cwd: appRoot });

    const binDir = path.join(appRoot, 'node_modules', '.bin');
    const binSuffix = process.platform === 'win32' ? '.cmd' : '';
    const imagePuma = path.join(binDir, `image-puma${binSuffix}`);
    const imagePumaMcp = path.join(binDir, `image-puma-mcp${binSuffix}`);
    run(imagePumaMcp, ['mcp', 'doctor', '--allow-dir', allowedRoot], { cwd: appRoot });

    await verifyMcpServe(imagePuma, [
      'mcp',
      'serve',
      '--allow-dir',
      allowedRoot,
      '--presets-file',
      path.join(tmpRoot, 'image-puma-presets.json'),
    ], 'image-puma mcp serve');
    await verifyMcpServe(imagePumaMcp, [
      'serve',
      '--allow-dir',
      allowedRoot,
      '--presets-file',
      path.join(tmpRoot, 'image-puma-mcp-presets.json'),
    ], 'image-puma-mcp serve');
    await verifyMcpServe(command('npx'), [
      '-y',
      '--package',
      tarball,
      'image-puma',
      'mcp',
      'serve',
      '--allow-dir',
      allowedRoot,
      '--presets-file',
      path.join(tmpRoot, 'npx-presets.json'),
    ], 'npx --package image-puma image-puma mcp serve');

    const inferred = spawnSync(command('npx'), [
      '-y',
      '--package',
      tarball,
      'image-puma',
      'mcp',
      'config',
      '--allow-dir',
      allowedRoot,
      '--package',
      'image-puma@1.0.0',
    ], {
      cwd: appRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (inferred.status !== 0) {
      throw new Error(`npx package-bin inference failed.\nstdout:\n${inferred.stdout}\nstderr:\n${inferred.stderr}`);
    }
    const parsed = JSON.parse(inferred.stdout);
    if (!parsed.mcpServers?.['image-puma']) {
      throw new Error('npx package-bin inference did not run Image Puma config output.');
    }

    process.stdout.write('Clean npm package install verified.\n');
  } finally {
    await fs.rm(tarball, { force: true }).catch(() => undefined);
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
