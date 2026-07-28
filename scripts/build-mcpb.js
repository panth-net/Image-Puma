#!/usr/bin/env node
const { spawnSync } = require('child_process');

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(cmd, args) {
  const result = spawnSync(command(cmd), args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const targetArgs = process.argv.slice(2);

run('npm', ['run', 'build:mcp']);
run('node', ['scripts/prepare-mcpb.js', ...targetArgs]);
run('node', ['scripts/pack-mcpb.js', ...targetArgs]);
