import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalFileProtocolPath } from '../src/main/files/local-file-protocol';

test('resolveLocalFileProtocolPath reads canonical local-file paths', () => {
  assert.equal(
    resolveLocalFileProtocolPath(
      'local-file:///Users/example/Downloads/ChatGPT%20Image%20Jul%206%2C%202026.png',
      'darwin',
    ),
    '/Users/example/Downloads/ChatGPT Image Jul 6, 2026.png',
  );
});

test('resolveLocalFileProtocolPath tolerates host-style macOS user paths', () => {
  assert.equal(
    resolveLocalFileProtocolPath(
      'local-file://users/example/Downloads/ChatGPT%20Image%20Jul%206%2C%202026.png',
      'darwin',
    ),
    '/Users/example/Downloads/ChatGPT Image Jul 6, 2026.png',
  );
});

test('resolveLocalFileProtocolPath keeps Windows drive paths usable', () => {
  assert.equal(
    resolveLocalFileProtocolPath('local-file:///C%3A/Users/example/Pictures/cut%20out.png', 'win32'),
    'C:/Users/example/Pictures/cut out.png',
  );
});
