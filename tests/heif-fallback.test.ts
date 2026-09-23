import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import sharp from 'sharp';
import { prepareSharpInput } from '../src/core/files/prepare-sharp-input';

const fixturePath = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'example.heic');

test('HEIC that Sharp cannot decode is decoded by the bundled HEIF fallback on Windows', async () => {
  const prepared = await prepareSharpInput(fixturePath, { probeDecode: true });
  try {
    assert.equal(prepared.metadata.width, 1280);
    assert.equal(prepared.metadata.height, 854);
    if (process.platform !== 'darwin') {
      assert.equal(prepared.usedNativeFallback, true);
      assert.equal(prepared.metadata.format, 'png');
    }

    const pixels = await sharp(prepared.path).resize(1, 1, { fit: 'fill' }).raw().toBuffer();
    assert.ok(pixels.length >= 3);
  } finally {
    await prepared.dispose();
  }
});
