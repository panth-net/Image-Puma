import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf-8')) as T;
}

test('package metadata exposes the MCP npm binary shape', () => {
  const packageJson = readJson<{
    name: string;
    version: string;
    mcpName: string;
    bin: Record<string, string>;
    engines: { node?: string };
    files: string[];
  }>('package.json');

  assert.equal(packageJson.name, 'image-puma');
  assert.equal(packageJson.mcpName, 'io.github.panth-net/Image-Puma');
  assert.equal(packageJson.bin.mcp, undefined);
  assert.equal(packageJson.bin['image-puma'], './dist/cli.js');
  assert.equal(packageJson.bin['image-puma-mcp'], './dist/cli.js');
  assert.equal(packageJson.engines.node, '>=20.3.0 <26');
  assert.ok(packageJson.files.includes('server.json'));
  assert.ok(packageJson.files.includes('assets/brand/**/*'));
  assert.ok(packageJson.files.includes('mcpb/**/*'));
});

test('registry metadata uses current package field casing and matching npm identity', () => {
  const packageJson = readJson<{ name: string; version: string; mcpName: string }>('package.json');
  const server = readJson<{
    $schema: string;
    name: string;
    version: string;
    packages: Array<{
      registryType: string;
      identifier: string;
      version?: string;
      fileSha256?: string;
      transport: { type: string };
    }>;
  }>('server.json');

  assert.equal(server.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(server.name, packageJson.mcpName);
  assert.equal(server.version, packageJson.version);

  const npmPackage = server.packages.find((entry) => entry.registryType === 'npm');
  assert.ok(npmPackage);
  assert.equal(npmPackage.identifier, packageJson.name);
  assert.equal(npmPackage.version, packageJson.version);
  assert.equal(npmPackage.transport.type, 'stdio');

  const mcpbPackages = server.packages.filter((entry) => entry.registryType === 'mcpb');
  assert.equal(mcpbPackages.length, 2);
  for (const entry of mcpbPackages) {
    assert.match(entry.identifier, /mcp/);
    assert.match(entry.fileSha256 || '', /^[a-f0-9]{64}$/i);
    assert.equal(entry.transport.type, 'stdio');
  }
});

test('MCPB manifest requests install-time allowed folders and declares fixed tools/prompts', () => {
  const manifest = readJson<{
    manifest_version: string;
    name: string;
    icon: string;
    server: {
      type: string;
      entry_point: string;
      mcp_config: {
        args: string[];
        env: Record<string, string>;
      };
    };
    user_config: {
      allowed_directories: {
        type: string;
        multiple: boolean;
        required: boolean;
      };
    };
    tools: Array<{ name: string }>;
    prompts: Array<{ name: string; text: string }>;
  }>('mcpb/manifest.json');

  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.name, 'image-puma');
  assert.equal(manifest.icon, 'assets/icons/android-chrome-512x512.png');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'dist/cli.js');
  assert.ok(manifest.server.mcp_config.args.includes('--allow-dir'));
  assert.ok(manifest.server.mcp_config.args.includes('${user_config.allowed_directories}'));
  assert.equal(JSON.stringify(manifest.server.mcp_config.env).includes('allowed_directories'), false);
  assert.equal(manifest.user_config.allowed_directories.type, 'directory');
  assert.equal(manifest.user_config.allowed_directories.multiple, true);
  assert.equal(manifest.user_config.allowed_directories.required, true);
  assert.deepEqual(manifest.tools.map((tool) => tool.name).sort(), [
    'image_puma_describe_preset',
    'image_puma_generate_favicon',
    'image_puma_list_presets',
    'image_puma_plan',
    'image_puma_run',
    'image_puma_settings_schema',
  ]);
  assert.deepEqual(manifest.prompts.map((prompt) => prompt.name), ['image-puma']);
  for (const prompt of manifest.prompts) {
    assert.match(prompt.text, /plan only/i);
    assert.match(prompt.text, /explicit confirmation/i);
  }
});

test('support docs cover distribution requirements', () => {
  const supportMatrix = fs.readFileSync(path.join(root, 'docs/support-matrix.md'), 'utf-8');

  assert.match(supportMatrix, /HEIC \/ HEIF \/ HIF/);
  assert.match(supportMatrix, /sips/);
});
