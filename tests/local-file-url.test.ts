import test from 'node:test';
import assert from 'node:assert/strict';
import { toLocalFileUrl } from '../src/renderer/local-file-url';

test('toLocalFileUrl maps absolute macOS paths to the app local-file protocol', () => {
  assert.equal(
    toLocalFileUrl('/Users/example/Downloads/ChatGPT Image May 25, 2026, 03_42_55 PM.png'),
    'local-file:///Users/example/Downloads/ChatGPT%20Image%20May%2025%2C%202026%2C%2003_42_55%20PM.png',
  );
});

test('toLocalFileUrl encodes URL control characters inside filenames', () => {
  assert.equal(
    toLocalFileUrl('/tmp/source #1?final.png'),
    'local-file:///tmp/source%20%231%3Ffinal.png',
  );
});

test('toLocalFileUrl normalizes Windows-style paths', () => {
  assert.equal(
    toLocalFileUrl('C:\\Users\\example\\Pictures\\cut out.png'),
    'local-file:///C%3A/Users/example/Pictures/cut%20out.png',
  );
});
