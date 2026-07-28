import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { generateFaviconBundle } from '../src/core/processing/generate-favicon-bundle';

test('quick favicon generates web, Windows, macOS, and Linux assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-favicon-'));
  try {
    const sourcePath = path.join(root, 'launch-logo.png');
    await sharp({
      create: {
        width: 1200,
        height: 900,
        channels: 3,
        background: { r: 20, g: 110, b: 210 },
      },
    }).png().toFile(sourcePath);

    const result = await generateFaviconBundle({
      sourcePath,
      outputDirectory: root,
    });

    assert.equal(path.basename(result.outputDirectory), 'favicon-package');
    assert.equal(result.files.length, 7);
    const names = result.files.map((file) => file.fileName);
    for (const expected of [
      'favicon.ico',
      'favicon-16x16.png',
      'favicon-32x32.png',
      'apple-touch-icon.png',
      'app-icon.ico',
      'app-icon.icns',
      'app-icon.png',
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
      await fs.access(path.join(result.outputDirectory, expected));
    }

    const favicon = await fs.readFile(path.join(result.outputDirectory, 'favicon.ico'));
    assert.equal(favicon.readUInt16LE(2), 1);
    assert.equal(favicon.readUInt16LE(4), 3);

    const windowsIcon = await fs.readFile(path.join(result.outputDirectory, 'app-icon.ico'));
    assert.equal(windowsIcon.readUInt16LE(4), 9);

    const macIcon = await fs.readFile(path.join(result.outputDirectory, 'app-icon.icns'));
    assert.equal(macIcon.subarray(0, 4).toString('ascii'), 'icns');
    assert.equal(macIcon.readUInt32BE(4), macIcon.length);

    const appIconMetadata = await sharp(path.join(result.outputDirectory, 'app-icon.png')).metadata();
    assert.equal(appIconMetadata.width, 1024);
    assert.equal(appIconMetadata.height, 1024);
    assert.equal(appIconMetadata.hasAlpha, false);

    const second = await generateFaviconBundle({ sourcePath, outputDirectory: root });
    assert.equal(path.basename(second.outputDirectory), 'favicon-package-2');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('quick favicon uses the selected square crop bounds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-favicon-crop-'));
  try {
    const sourcePath = path.join(root, 'wide-logo.png');
    const pixels = Buffer.alloc(300 * 100 * 3);
    for (let y = 0; y < 100; y += 1) {
      for (let x = 0; x < 300; x += 1) {
        const offset = ((y * 300) + x) * 3;
        pixels[offset] = x < 100 ? 240 : 20;
        pixels[offset + 1] = x >= 100 && x < 200 ? 240 : 20;
        pixels[offset + 2] = x >= 200 ? 240 : 20;
      }
    }
    await sharp(pixels, { raw: { width: 300, height: 100, channels: 3 } }).png().toFile(sourcePath);

    const left = await generateFaviconBundle({
      sourcePath,
      outputDirectory: root,
      folderName: 'left',
      crop: { x: 0, y: 0, width: 33.333, height: 100 },
    });
    const right = await generateFaviconBundle({
      sourcePath,
      outputDirectory: root,
      folderName: 'right',
      crop: { x: 66.667, y: 0, width: 33.333, height: 100 },
    });

    const leftPixel = await sharp(path.join(left.outputDirectory, 'app-icon.png'))
      .raw()
      .toBuffer();
    const rightPixel = await sharp(path.join(right.outputDirectory, 'app-icon.png'))
      .raw()
      .toBuffer();

    assert.ok(leftPixel[0] > leftPixel[2], 'left crop should use the red section');
    assert.ok(rightPixel[2] > rightPixel[0], 'right crop should use the blue section');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
