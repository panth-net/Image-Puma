import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { expandPathVariables, generateMcpServersConfig, parseCliArgs, runCli } from '../src/mcp/cli';

test('MCP CLI accepts serve aliases and package commands', () => {
  assert.equal(parseCliArgs(['mcp', 'serve', '--allow-dir', '/tmp/images']).command, 'serve');
  assert.equal(parseCliArgs(['serve', '--allow-dir', '/tmp/images']).command, 'serve');
  assert.equal(parseCliArgs(['mcp', 'doctor', '--allow-dir', '/tmp/images']).command, 'doctor');
  assert.equal(parseCliArgs(['mcp', 'config', '--allow-dir', '/tmp/images']).command, 'config');
});

test('MCP CLI parses allowed directories from env array and delimiters', () => {
  const jsonEnv = parseCliArgs(['mcp', 'serve'], {
    IMAGE_PUMA_ALLOW_DIRS: JSON.stringify(['/tmp/a', '/tmp/b']),
  });
  assert.deepEqual(jsonEnv.allowedDirs, ['/tmp/a', '/tmp/b']);

  const delimitedEnv = parseCliArgs(['mcp', 'serve'], {
    IMAGE_PUMA_ALLOW_DIRS: ['/tmp/a', '/tmp/b'].join(path.delimiter),
  });
  assert.deepEqual(delimitedEnv.allowedDirs, ['/tmp/a', '/tmp/b']);
});

test('MCP CLI expands unexpanded MCPB path variables and tilde prefixes', () => {
  const home = os.homedir();
  const parsed = parseCliArgs([
    'mcp',
    'serve',
    '--presets-file',
    '${HOME}/.config/image-puma/presets.json',
    '--allow-dir',
    '${HOME}/Pictures',
    '${DOWNLOADS}',
    '~/Photos',
  ]);

  assert.deepEqual(parsed.allowedDirs, [
    path.join(home, 'Pictures'),
    path.join(home, 'Downloads'),
    path.join(home, 'Photos'),
  ]);
  assert.equal(parsed.presetFilePath, path.join(home, '.config/image-puma/presets.json'));

  assert.equal(expandPathVariables('${DESKTOP}/shots'), path.join(home, 'Desktop', 'shots'));
  assert.equal(expandPathVariables('${DOCUMENTS}'), path.join(home, 'Documents'));
  assert.equal(expandPathVariables('~'), home);
  assert.equal(expandPathVariables('/absolute/stays'), '/absolute/stays');
});

test('MCP CLI accepts MCPB-expanded allowed directory arrays after one flag', () => {
  const parsed = parseCliArgs([
    'mcp',
    'serve',
    '--allow-dir',
    '/tmp/a',
    '/tmp/b',
    '--transport',
    'stdio',
  ]);

  assert.deepEqual(parsed.allowedDirs, ['/tmp/a', '/tmp/b']);
  assert.equal(parsed.transport, 'stdio');
});

test('MCP CLI parses resource limit options', () => {
  const parsed = parseCliArgs([
    'mcp',
    'serve',
    '--allow-dir',
    '/tmp/images',
    '--max-files',
    '10',
    '--max-total-bytes',
    '2048',
    '--max-megapixels',
    '12',
    '--processing-timeout-seconds',
    '30',
  ]);

  assert.equal(parsed.limits?.maxFiles, 10);
  assert.equal(parsed.limits?.maxTotalInputBytes, 2048);
  assert.equal(parsed.limits?.maxMegapixelsPerFile, 12);
  assert.equal(parsed.limits?.processingTimeoutSeconds, 30);
});

test('MCP config generator emits absolute npx config and rejects tilde paths', () => {
  const config = generateMcpServersConfig({
    allowedDirs: ['relative-images'],
    packageSpec: 'image-puma@1.0.0',
  }) as {
    mcpServers: {
      'image-puma': {
        command: string;
        args: string[];
      };
    };
  };

  assert.equal(config.mcpServers['image-puma'].command, 'npx');
  assert.deepEqual(config.mcpServers['image-puma'].args.slice(0, 4), [
    '-y',
    'image-puma@1.0.0',
    'mcp',
    'serve',
  ]);
  const allowDirIndex = config.mcpServers['image-puma'].args.indexOf('--allow-dir');
  assert.ok(path.isAbsolute(config.mcpServers['image-puma'].args[allowDirIndex + 1]));

  assert.throws(
    () => generateMcpServersConfig({ allowedDirs: ['~/Pictures'] }),
    /leading "~" is not expanded/,
  );
});

test('MCP config command writes JSON through the provided stdout', async () => {
  let output = '';
  await runCli(['mcp', 'config', '--allow-dir', '/tmp/images', '--package', 'image-puma@9.9.9'], {}, {
    stdout: { write: (chunk: string | Uint8Array) => { output += chunk.toString(); return true; } },
    stderr: { write: () => true },
    setExitCode: () => undefined,
  });

  const parsed = JSON.parse(output) as { mcpServers: { 'image-puma': { args: string[] } } };
  assert.equal(parsed.mcpServers['image-puma'].args[1], 'image-puma@9.9.9');
  assert.ok(parsed.mcpServers['image-puma'].args.includes(path.resolve('/tmp/images')));
});
