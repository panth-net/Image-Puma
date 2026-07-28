import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { scanInputs } from '../src/core/files/scan-input';

test('scanInputs imports supported files, deduplicates paths, and skips unsupported entries', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-scan-'));
  const sourceDir = path.join(tmpRoot, 'source');
  const nestedDir = path.join(sourceDir, 'nested');
  await fs.mkdir(nestedDir, { recursive: true });

  const jpegPath = path.join(sourceDir, 'photo.JPG');
  const jfifPath = path.join(sourceDir, 'message-export.JFIF');
  const gifPath = path.join(nestedDir, 'reaction.gif');
  const heicPath = path.join(nestedDir, 'portrait.heic');
  const textPath = path.join(sourceDir, 'notes.txt');
  const symlinkPath = path.join(sourceDir, 'broken-link');

  try {
    await fs.writeFile(jpegPath, Buffer.alloc(12, 1));
    await fs.writeFile(jfifPath, Buffer.alloc(16, 3));
    await fs.writeFile(gifPath, Buffer.alloc(18, 4));
    await fs.writeFile(heicPath, Buffer.alloc(20, 2));
    await fs.writeFile(textPath, 'ignore me', 'utf-8');
    await fs.symlink(path.join(tmpRoot, 'missing-file.jpg'), symlinkPath);

    const result = await scanInputs([sourceDir, jpegPath]);

    assert.equal(result.files.length, 4);
    const byPath = new Map(result.files.map((file) => [file.sourcePath, file]));
    assert.ok(byPath.has(jpegPath));
    assert.ok(byPath.has(jfifPath));
    assert.ok(byPath.has(gifPath));
    assert.ok(byPath.has(heicPath));
    assert.equal(result.totalSize, 66);

    assert.equal(byPath.get(jpegPath)?.relativePath, 'photo.JPG');
    assert.equal(byPath.get(jfifPath)?.relativePath, 'message-export.JFIF');
    assert.equal(byPath.get(gifPath)?.relativePath, path.join('nested', 'reaction.gif'));
    assert.equal(byPath.get(heicPath)?.relativePath, path.join('nested', 'portrait.heic'));

    assert.ok(result.skipped.some((item) => item.path === textPath && item.reason === 'unsupported-type'));
    assert.ok(result.skipped.some((item) => item.path === symlinkPath && item.reason === 'symlink'));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('scanInputs reports progress and stops recursive scans when cancelled', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-scan-cancel-'));
  const sourceDir = path.join(tmpRoot, 'source');
  await fs.mkdir(sourceDir, { recursive: true });

  try {
    for (let i = 0; i < 25; i++) {
      await fs.writeFile(path.join(sourceDir, `photo-${i}.jpg`), Buffer.alloc(8, i));
    }

    let cancelled = false;
    const progressEvents: Array<{
      checkedCount: number;
      acceptedCount: number;
      done: boolean;
      cancelled: boolean;
    }> = [];

    const result = await scanInputs([sourceDir], {
      scanId: 'unit-scan',
      shouldCancel: () => cancelled,
      onProgress: (progress) => {
        progressEvents.push(progress);
        if (progress.acceptedCount >= 1) {
          cancelled = true;
        }
      },
    });

    const lastProgress = progressEvents[progressEvents.length - 1];
    assert.ok(lastProgress);
    assert.equal(result.cancelled, true);
    assert.ok(result.files.length < 25);
    assert.ok(progressEvents.some((progress) => progress.acceptedCount >= 1));
    assert.equal(lastProgress.done, true);
    assert.equal(lastProgress.cancelled, true);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
