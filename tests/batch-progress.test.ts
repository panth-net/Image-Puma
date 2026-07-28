import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchProgressTracker } from '../src/core/processing/batch-progress';
import type { ProcessedFileResult } from '../src/core/shared/types';

function successResult(sourcePath: string): ProcessedFileResult {
  return {
    sourcePath,
    outputPath: `${sourcePath}.out`,
    originalSize: 100,
    outputSize: 50,
    success: true,
  };
}

test('createBatchProgressTracker increments completed count deterministically', () => {
  const tracker = createBatchProgressTracker(3);

  const started = tracker.markStarted('/tmp/one.jpg', 'one.jpg');
  const first = tracker.markCompleted('/tmp/one.jpg', 'one.jpg', successResult('/tmp/one.jpg'));
  const second = tracker.markCompleted('/tmp/two.jpg', 'two.jpg', successResult('/tmp/two.jpg'));

  assert.equal(started.startedCount, 1);
  assert.deepEqual(started.activeFiles, ['/tmp/one.jpg']);
  assert.equal(first.completedCount, 1);
  assert.equal(first.totalCount, 3);
  assert.equal(first.currentFile, 'one.jpg');
  assert.equal(first.status, 'running');
  assert.deepEqual(first.activeFiles, []);

  assert.equal(second.completedCount, 2);
  assert.equal(second.totalCount, 3);
  assert.equal(tracker.completedCount, 2);
});
