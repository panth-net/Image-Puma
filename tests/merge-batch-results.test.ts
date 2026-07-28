import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBatchResults, summarizeBatchResults } from '../src/renderer/batch-utils';

test('mergeBatchResults replaces retried results by sourcePath and recomputes totals', () => {
  const previous = summarizeBatchResults([
    {
      sourcePath: '/in/a.jpg',
      outputPath: '/out/a.jpg',
      originalSize: 100,
      outputSize: 60,
      success: true,
    },
    {
      sourcePath: '/in/b.jpg',
      outputPath: '',
      originalSize: 200,
      outputSize: 0,
      success: false,
      error: 'Decode failed',
    },
  ]);

  const retried = summarizeBatchResults([
    {
      sourcePath: '/in/b.jpg',
      outputPath: '/out/b.jpg',
      originalSize: 200,
      outputSize: 100,
      success: true,
    },
  ]);

  const merged = mergeBatchResults(previous, retried);
  const retriedItem = merged.results.find((item) => item.sourcePath === '/in/b.jpg');

  assert.equal(merged.results.length, 2);
  assert.equal(retriedItem?.success, true);
  assert.equal(retriedItem?.outputPath, '/out/b.jpg');
  assert.equal(merged.successCount, 2);
  assert.equal(merged.failureCount, 0);
  assert.equal(merged.cancelledCount, 0);
  assert.equal(merged.totalOriginalBytes, 300);
  assert.equal(merged.totalOutputBytes, 160);
  assert.equal(merged.totalSavedBytes, 140);
});

test('summarizeBatchResults counts cancelled results separately from failures', () => {
  const summary = summarizeBatchResults([
    {
      sourcePath: '/in/a.jpg',
      outputPath: '',
      originalSize: 100,
      outputSize: 0,
      success: false,
      skipped: true,
      cancelled: true,
      error: 'Cancelled',
    },
    {
      sourcePath: '/in/b.jpg',
      outputPath: '',
      originalSize: 200,
      outputSize: 0,
      success: false,
      error: 'Decode failed',
    },
  ]);

  assert.equal(summary.successCount, 0);
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.skippedCount, 1);
  assert.equal(summary.cancelledCount, 1);
});
