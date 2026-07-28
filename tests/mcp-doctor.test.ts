import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runMcpDoctor } from '../src/mcp/doctor';

test('MCP doctor passes dependency and runtime probes for a writable allowed root', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-doctor-test-'));
  try {
    const report = await runMcpDoctor({ allowedDirs: [tmpRoot] });
    assert.equal(report.ok, true, report.checks.map((check) => `${check.name}: ${check.message}`).join('\n'));
    assert.deepEqual(
      report.checks.map((check) => check.name).sort(),
      [
        'allowed-roots',
        'exiftool',
        'node-version',
        'runtime-no-network',
        'sharp',
        'write-permission',
      ],
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
