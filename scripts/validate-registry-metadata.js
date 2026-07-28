#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf-8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  const packageJson = readJson('package.json');
  const server = readJson('server.json');
  const manifest = readJson('mcpb/manifest.json');

  assert(server.$schema === SERVER_SCHEMA, `server.json must use ${SERVER_SCHEMA}`);
  assert(server.name === packageJson.mcpName, 'server.json name must match package.json mcpName.');
  assert(server.version === packageJson.version, 'server.json version must match package.json version.');
  assert(Array.isArray(server.packages), 'server.json packages must be an array.');

  const repositoryUrl = (server.repository?.url || '').replace(/\.git$/, '');
  assert(
    /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repositoryUrl),
    'server.json repository.url must be a GitHub repository URL.',
  );
  assert(
    server.name === `io.github.${repositoryUrl.split('/').slice(-2).join('/')}`,
    'server.json name must be io.github.<owner>/<repo> matching repository.url.',
  );
  assert(
    (manifest.homepage || '').replace(/\.git$/, '') === repositoryUrl,
    'MCPB manifest homepage must match server.json repository.url.',
  );

  const npmPackage = server.packages.find((entry) => entry.registryType === 'npm');
  assert(npmPackage, 'server.json needs an npm package entry.');
  assert(npmPackage.identifier === packageJson.name, 'npm package identifier must match package.json name.');
  assert(npmPackage.version === packageJson.version, 'npm package version must match package.json version.');
  assert(npmPackage.transport?.type === 'stdio', 'npm package transport must be stdio.');

  const mcpbPackages = server.packages.filter((entry) => entry.registryType === 'mcpb');
  assert(mcpbPackages.length >= 2, 'server.json needs macOS arm64 and Windows x64 MCPB entries.');
  const placeholders = [];
  for (const entry of mcpbPackages) {
    assert(typeof entry.identifier === 'string' && entry.identifier.includes('mcp'), 'MCPB identifier must contain "mcp".');
    assert(/^[a-f0-9]{64}$/i.test(entry.fileSha256 || ''), `MCPB entry has an invalid fileSha256: ${entry.identifier}`);
    assert(entry.transport?.type === 'stdio', 'MCPB package transport must be stdio.');

    if (/^0{64}$/.test(entry.fileSha256)) {
      placeholders.push(path.basename(entry.identifier));
    }

    const localArtifact = path.join(ROOT, 'dist-mcpb', path.basename(entry.identifier));
    if (fs.existsSync(localArtifact)) {
      const actualHash = fileSha256(localArtifact);
      assert(
        actualHash === entry.fileSha256,
        `server.json fileSha256 for ${path.basename(entry.identifier)} does not match the local artifact. `
        + 'Run npm run release:sync after packing every target.',
      );
    }
  }

  assert(manifest.manifest_version === '0.3', 'MCPB manifest_version must be 0.3.');
  assert(manifest.name === 'image-puma', 'MCPB manifest name must be image-puma.');
  assert(manifest.server?.type === 'node', 'MCPB server type must be node.');
  assert(manifest.user_config?.allowed_directories?.type === 'directory', 'MCPB manifest needs directory user_config.');
  assert(manifest.user_config.allowed_directories.multiple === true, 'MCPB allowed_directories must allow multiple selections.');
  assert(manifest.user_config.allowed_directories.required === true, 'MCPB allowed_directories must be required.');
  assert(Array.isArray(manifest.server?.mcp_config?.args), 'MCPB mcp_config args must be an array.');
  assert(
    manifest.server.mcp_config.args.includes('--allow-dir')
      && manifest.server.mcp_config.args.includes('${user_config.allowed_directories}'),
    'MCPB manifest must pass user-selected allowed directories through command args.',
  );
  assert(
    !JSON.stringify(manifest.server.mcp_config.env || {}).includes('allowed_directories'),
    'MCPB manifest must not pass multi-directory allowed roots through env.',
  );

  process.stdout.write('Registry and MCPB metadata validated.\n');
  if (placeholders.length > 0) {
    process.stdout.write(
      `Note: ${placeholders.length} MCPB entr${placeholders.length === 1 ? 'y' : 'ies'} still carry `
      + 'placeholder hashes. The release workflow replaces them with the real artifact hashes.\n',
    );
  }
}

main();
