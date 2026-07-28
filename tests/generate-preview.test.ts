import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import sharp from 'sharp';
import type { AppPreset, InputFile } from '../src/core/shared/types';
import { defaultPresets } from '../src/core/presets/default-presets';
import { generatePreview } from '../src/core/processing/generate-preview';

function clonePreset(preset: AppPreset): AppPreset {
  return {
    ...preset,
    output: { ...preset.output },
    resize: {
      ...preset.resize,
      responsiveWidths: Array.isArray(preset.resize.responsiveWidths)
        ? [...preset.resize.responsiveWidths]
        : [],
    },
    crop: { ...preset.crop },
    transform: { ...preset.transform },
    metadata: { ...preset.metadata },
    naming: { ...preset.naming },
    export: { ...preset.export },
  };
}

function bufferFromDataUrl(dataUrl: string): Buffer {
  const [, base64 = ''] = dataUrl.split(',');
  return Buffer.from(base64, 'base64');
}

function pixelAt(
  raw: { data: Buffer; width: number; channels: number },
  x: number,
  y: number,
): number[] {
  const offset = (y * raw.width + x) * raw.channels;
  return Array.from(raw.data.slice(offset, offset + 3));
}

test('default preset preview reports a pass-through output', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-preview-'));
  const inputPath = path.join(tmpRoot, 'source.jpg');

  try {
    await sharp({
      create: {
        width: 793,
        height: 1983,
        channels: 3,
        background: { r: 120, g: 80, b: 180 },
      },
    })
      .jpeg({ quality: 78 })
      .toFile(inputPath);

    const stat = await fs.stat(inputPath);
    const inputFile: InputFile = {
      sourcePath: inputPath,
      relativePath: 'source.jpg',
      fileName: 'source',
      extension: '.jpg',
      fileSize: stat.size,
      width: 793,
      height: 1983,
      format: 'jpeg',
    };

    const preview = await generatePreview(inputFile, defaultPresets[0]);

    assert.equal(preview.outputSize, stat.size);
    assert.equal(preview.originalSize, stat.size);
    assert.equal(preview.outputWidth, 793);
    assert.equal(preview.outputHeight, 1983);
    assert.equal(preview.dataUrl, preview.originalDataUrl);
    assert.equal(preview.warnings.includes('Output is larger than input!'), false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('ICO preview shows its largest PNG representation and container size', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-ico-preview-'));
  const inputPath = path.join(tmpRoot, 'source.png');

  try {
    await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 4,
        background: { r: 40, g: 130, b: 210, alpha: 1 },
      },
    }).png().toFile(inputPath);
    const stat = await fs.stat(inputPath);
    const inputFile: InputFile = {
      sourcePath: inputPath,
      relativePath: 'source.png',
      fileName: 'source',
      extension: '.png',
      fileSize: stat.size,
      width: 640,
      height: 360,
      format: 'png',
    };
    const preset = clonePreset(defaultPresets.find((item) => item.id === 'windows-icon') || defaultPresets[0]);

    const preview = await generatePreview(inputFile, preset);
    const previewMetadata = await sharp(bufferFromDataUrl(preview.dataUrl)).metadata();

    assert.equal(preview.outputFormat, 'ico');
    assert.equal(preview.outputWidth, 256);
    assert.equal(preview.outputHeight, 256);
    assert.equal(previewMetadata.format, 'png');
    assert.equal(previewMetadata.width, 256);
    assert.equal(previewMetadata.height, 256);
    assert.ok(preview.outputSize > 0);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('crop preview includes the transformed pre-crop surface', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-crop-preview-'));
  const inputPath = path.join(tmpRoot, 'source.png');

  try {
    await sharp({
      create: {
        width: 80,
        height: 40,
        channels: 4,
        background: { r: 60, g: 140, b: 220, alpha: 1 },
      },
    })
      .png()
      .toFile(inputPath);

    const stat = await fs.stat(inputPath);
    const inputFile: InputFile = {
      sourcePath: inputPath,
      relativePath: 'source.png',
      fileName: 'source',
      extension: '.png',
      fileSize: stat.size,
      width: 80,
      height: 40,
      format: 'png',
    };
    const preset = clonePreset(defaultPresets[0]);
    preset.crop = {
      enabled: true,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      aspectRatio: null,
      aspectAnchor: 'top-left',
      positionMode: 'xy',
    };
    preset.transform = {
      rotation: 90,
      flipH: false,
      flipV: false,
    };

    const preview = await generatePreview(inputFile, preset);

    assert.match(preview.cropBaseDataUrl || '', /^data:image\/png;base64,/);
    assert.equal(preview.cropBaseWidth, 40);
    assert.equal(preview.cropBaseHeight, 80);
    assert.match(preview.compareBaseDataUrl || '', /^data:image\//);
    assert.equal(preview.compareBaseWidth, preview.outputWidth);
    assert.equal(preview.compareBaseHeight, preview.outputHeight);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('compare baseline uses the transformed visual orientation', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-compare-preview-'));
  const inputPath = path.join(tmpRoot, 'tiles.png');

  try {
    const pixels = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      255, 255, 0, 255, 255, 0, 255, 255, 0, 255, 255, 255,
    ]);

    await sharp(pixels, {
      raw: {
        width: 3,
        height: 2,
        channels: 4,
      },
    })
      .png()
      .toFile(inputPath);

    const stat = await fs.stat(inputPath);
    const inputFile: InputFile = {
      sourcePath: inputPath,
      relativePath: 'tiles.png',
      fileName: 'tiles',
      extension: '.png',
      fileSize: stat.size,
      width: 3,
      height: 2,
      format: 'png',
    };
    const preset = clonePreset(defaultPresets[0]);
    preset.transform = {
      rotation: 90,
      flipH: false,
      flipV: false,
    };

    const preview = await generatePreview(inputFile, preset);
    assert.ok(preview.compareBaseDataUrl);

    const { data, info } = await sharp(bufferFromDataUrl(preview.compareBaseDataUrl))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = {
      data,
      width: info.width,
      channels: info.channels,
    };

    assert.equal(info.width, 2);
    assert.equal(info.height, 3);
    assert.deepEqual(pixelAt(raw, 0, 0), [255, 255, 0]);
    assert.deepEqual(pixelAt(raw, 1, 0), [255, 0, 0]);
    assert.deepEqual(pixelAt(raw, 0, 2), [0, 255, 255]);
    assert.deepEqual(pixelAt(raw, 1, 2), [0, 0, 255]);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
