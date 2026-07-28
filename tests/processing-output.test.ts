import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import sharp from 'sharp';
import type { AppPreset, InputFile, OutputFormat, PlannedOutputVariant } from '../src/core/shared/types';
import { defaultPresets } from '../src/core/presets/default-presets';
import { processOneImage } from '../src/core/processing/process-one-image';
import { runBatchCore } from '../src/core/processing/run-batch';
import { planBatchOutputs } from '../src/core/files/output-plan';

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

async function statInput(inputPath: string): Promise<InputFile> {
  const meta = await sharp(inputPath).metadata();
  const stat = await fs.stat(inputPath);
  const parsed = path.parse(inputPath);

  return {
    sourcePath: inputPath,
    relativePath: path.basename(inputPath),
    fileName: parsed.name,
    extension: parsed.ext,
    fileSize: stat.size,
    width: meta.width,
    height: meta.height,
    format: meta.format,
  };
}

function makePreset(outputDir: string): AppPreset {
  const preset = clonePreset(defaultPresets[0]);
  preset.output = {
    format: 'png',
    jpegQuality: 90,
    pngCompressionLevel: 6,
    webpQuality: 82,
    avifQuality: 60,
    lossless: false,
  };
  preset.resize = {
    mode: 'none',
    noUpscale: true,
    responsiveWidths: [],
  };
  preset.crop = {
    enabled: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    aspectRatio: null,
    aspectAnchor: 'top-left',
    positionMode: 'xy',
  };
  preset.transform = {
    rotation: 0,
    flipH: false,
    flipV: false,
  };
  preset.metadata = {
    mode: 'strip-all',
    convertToSrgb: true,
  };
  preset.naming = {
    keepOriginal: false,
    sanitizeAiTerms: true,
    prefix: '',
    suffix: '',
    findText: '',
    replaceText: '',
    sequential: false,
    sequentialStart: 1,
    template: '',
  };
  preset.export = {
    destination: 'custom',
    customPath: outputDir,
    siblingFolderName: 'optimized',
    overwrite: true,
    openFolderWhenDone: false,
  };
  return preset;
}

async function makeGradientInput(tmpRoot: string): Promise<InputFile> {
  const inputPath = path.join(tmpRoot, 'chatgpt-source.png');
  await sharp({
    create: {
      width: 400,
      height: 200,
      channels: 3,
      background: { r: 110, g: 70, b: 180 },
    },
  })
    .png()
    .toFile(inputPath);

  return statInput(inputPath);
}

async function readRawRgb(filePath: string): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(filePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

async function readRawRgba(filePath: string): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

function pixelAt(
  raw: { data: Buffer; width: number; height: number; channels: number },
  x: number,
  y: number,
): number[] {
  const offset = (y * raw.width + x) * raw.channels;
  return Array.from(raw.data.slice(offset, offset + 3));
}

function alphaAt(
  raw: { data: Buffer; width: number; height: number; channels: number },
  x: number,
  y: number,
): number {
  const offset = (y * raw.width + x) * raw.channels;
  return raw.data[offset + 3];
}

test('compression exports every supported output format as a readable file', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-formats-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const inputFile = await makeGradientInput(tmpRoot);
    const formats: OutputFormat[] = ['jpeg', 'png', 'webp', 'avif', 'tiff'];

    for (const format of formats) {
      const preset = makePreset(outputDir);
      preset.output.format = format;
      preset.naming.suffix = `-${format}`;
      if (format === 'webp') preset.output.lossless = true;

      const result = await processOneImage(inputFile, preset, 0);
      assert.equal(result.success, true, result.error);
      assert.equal(path.extname(result.outputPath), `.${format}`);

      const meta = await sharp(result.outputPath).metadata();
      assert.equal(meta.format, format === 'avif' ? 'heif' : format);
      assert.equal(meta.width, 400);
      assert.equal(meta.height, 200);
      assert.ok(result.outputSize > 0);
      assert.equal(result.generatedOutputs?.[0]?.width, 400);
      assert.equal(result.generatedOutputs?.[0]?.height, 200);
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('compression exports multi-resolution ICO and ICNS containers', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-icon-formats-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const inputFile = await makeGradientInput(tmpRoot);

    for (const format of ['ico', 'icns'] as const) {
      const preset = makePreset(outputDir);
      preset.output.format = format;
      preset.naming.suffix = `-${format}`;

      const result = await processOneImage(inputFile, preset, 0);
      assert.equal(result.success, true, result.error);
      assert.equal(path.extname(result.outputPath), `.${format}`);

      const data = await fs.readFile(result.outputPath);
      if (format === 'ico') {
        assert.equal(data.readUInt16LE(2), 1);
        assert.equal(data.readUInt16LE(4), 9);
        assert.equal(result.generatedOutputs?.[0]?.width, 256);
        assert.equal(result.generatedOutputs?.[0]?.height, 256);
      } else {
        assert.equal(data.subarray(0, 4).toString('ascii'), 'icns');
        assert.equal(data.readUInt32BE(4), data.length);
        assert.equal(result.generatedOutputs?.[0]?.width, 1024);
        assert.equal(result.generatedOutputs?.[0]?.height, 1024);
      }
      assert.equal(result.outputSize, data.length);
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('runBatch uses planned renamed paths for same-basename output collisions', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-batch-collision-'));
  const firstDir = path.join(tmpRoot, 'first');
  const secondDir = path.join(tmpRoot, 'second');
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(firstDir, { recursive: true });
  await fs.mkdir(secondDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const firstPath = path.join(firstDir, 'source.png');
    const secondPath = path.join(secondDir, 'source.png');
    await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 200, g: 20, b: 20 },
      },
    }).png().toFile(firstPath);
    await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 20, g: 20, b: 200 },
      },
    }).png().toFile(secondPath);

    const files = [
      await statInput(firstPath),
      await statInput(secondPath),
    ];
    const preset = makePreset(outputDir);
    preset.output.format = 'png';
    preset.naming.keepOriginal = true;
    preset.export.overwrite = false;

    const plan = await planBatchOutputs({ files, preset });
    assert.equal(plan.summary.errorCount, 0);
    assert.deepEqual(
      plan.entries.map((entry) => path.basename(entry.variants[0].outputPath)),
      ['source.png', 'source-2.png'],
    );

    const result = await runBatchCore({ files, preset });
    assert.equal(result.successCount, 2);
    assert.equal(result.failureCount, 0);
    assert.deepEqual(
      result.results.map((item) => path.basename(item.outputPath)),
      ['source.png', 'source-2.png'],
    );
    await fs.access(path.join(outputDir, 'source.png'));
    await fs.access(path.join(outputDir, 'source-2.png'));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('runBatch applies the first source format to every file in a mixed batch', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-batch-format-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const pngPath = path.join(tmpRoot, 'first.png');
    const jpegPath = path.join(tmpRoot, 'second.jpg');
    await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 200, g: 20, b: 20 },
      },
    }).png().toFile(pngPath);
    await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 20, g: 20, b: 200 },
      },
    }).jpeg().toFile(jpegPath);

    const files = [await statInput(pngPath), await statInput(jpegPath)];
    const preset = makePreset(outputDir);
    preset.output.format = 'keep-original';

    const result = await runBatchCore({ files, preset });

    assert.equal(result.successCount, 2);
    assert.deepEqual(result.results.map((item) => path.extname(item.outputPath)), ['.png', '.png']);
    for (const item of result.results) {
      assert.equal((await sharp(item.outputPath).metadata()).format, 'png');
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('runBatch fails a stale no-overwrite plan instead of overwriting an external file', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-stale-plan-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const inputFile = await makeGradientInput(tmpRoot);
    const preset = makePreset(outputDir);
    preset.output.format = 'png';
    preset.naming.keepOriginal = true;
    preset.export.overwrite = false;

    const plan = await planBatchOutputs({ files: [inputFile], preset });
    assert.equal(plan.summary.errorCount, 0);
    const plannedOutput = plan.entries[0].variants[0].outputPath;
    await fs.writeFile(plannedOutput, 'external file');

    const result = await runBatchCore({ files: [inputFile], preset, plan });

    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 1);
    assert.match(result.results[0].error || '', /EEXIST|file already exists/i);
    assert.equal(await fs.readFile(plannedOutput, 'utf-8'), 'external file');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('runBatch rejects supplied plans without an output variant for each file', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-empty-plan-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const inputFile = await makeGradientInput(tmpRoot);
    const preset = makePreset(outputDir);
    const plan = await planBatchOutputs({ files: [inputFile], preset });
    const malformedPlan = {
      ...plan,
      entries: plan.entries.map((entry) => ({
        ...entry,
        variants: [] as PlannedOutputVariant[],
      })),
      summary: {
        ...plan.summary,
        outputCount: 0,
      },
    };

    await assert.rejects(
      runBatchCore({ files: [inputFile], preset, plan: malformedPlan }),
      /no output/i,
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('runBatchCore applies configured Sharp input pixel limits', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-pixel-limit-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const inputFile = await makeGradientInput(tmpRoot);
    const preset = makePreset(outputDir);
    const plan = await planBatchOutputs({ files: [inputFile], preset });

    const result = await runBatchCore(
      { files: [inputFile], preset, plan },
      { processingLimits: { limitInputPixels: 10, timeoutSeconds: 1 } },
    );

    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 1);
    assert.match(result.results[0].error || '', /pixel|limit/i);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('resize edge cases export expected dimensions', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-resize-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const inputFile = await makeGradientInput(tmpRoot);
    const cases: Array<{
      name: string;
      resize: AppPreset['resize'];
      expected: { width: number; height: number };
    }> = [
      {
        name: 'height-only',
        resize: { mode: 'height', height: 100, noUpscale: true, responsiveWidths: [] },
        expected: { width: 200, height: 100 },
      },
      {
        name: 'fit-box-height-only',
        resize: { mode: 'fit-box', height: 100, noUpscale: true, responsiveWidths: [] },
        expected: { width: 200, height: 100 },
      },
      {
        name: 'exact-stretch',
        resize: { mode: 'exact', width: 300, height: 300, noUpscale: false, responsiveWidths: [] },
        expected: { width: 300, height: 300 },
      },
      {
        name: 'percent',
        resize: { mode: 'percent', percent: 25, noUpscale: true, responsiveWidths: [] },
        expected: { width: 100, height: 50 },
      },
    ];

    for (const item of cases) {
      const preset = makePreset(outputDir);
      preset.resize = item.resize;
      preset.naming.suffix = `-${item.name}`;

      const result = await processOneImage(inputFile, preset, 0);
      assert.equal(result.success, true, result.error);

      const meta = await sharp(result.outputPath).metadata();
      assert.equal(meta.width, item.expected.width, item.name);
      assert.equal(meta.height, item.expected.height, item.name);
      assert.equal(result.generatedOutputs?.[0]?.width, item.expected.width, item.name);
      assert.equal(result.generatedOutputs?.[0]?.height, item.expected.height, item.name);
    }

    const fitBoxHeightOnlyPreset = makePreset(outputDir);
    fitBoxHeightOnlyPreset.resize = {
      mode: 'fit-box',
      height: 100,
      noUpscale: true,
      responsiveWidths: [],
    };
    const plan = await planBatchOutputs({ files: [inputFile], preset: fitBoxHeightOnlyPreset });
    assert.equal(plan.summary.errorCount, 0);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('crop exports the selected source region', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-crop-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });
  const inputPath = path.join(tmpRoot, 'quadrants.png');

  try {
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } },
          }).png().toBuffer(),
          left: 0,
          top: 0,
        },
        {
          input: await sharp({
            create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 0, b: 255 } },
          }).png().toBuffer(),
          left: 50,
          top: 50,
        },
      ])
      .png()
      .toFile(inputPath);

    const inputFile = await statInput(inputPath);
    const preset = makePreset(outputDir);
    preset.crop = {
      enabled: true,
      x: 50,
      y: 50,
      width: 50,
      height: 50,
      aspectRatio: null,
      aspectAnchor: 'top-left',
      positionMode: 'xy',
    };

    const result = await processOneImage(inputFile, preset, 0);
    assert.equal(result.success, true, result.error);

    const meta = await sharp(result.outputPath).metadata();
    assert.equal(meta.width, 50);
    assert.equal(meta.height, 50);
    assert.deepEqual(pixelAt(await readRawRgb(result.outputPath), 25, 25), [0, 0, 255]);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('Twitter OG preset applies its exact card crop without manual crop edits', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-twitter-crop-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });
  const inputPath = path.join(tmpRoot, 'wide-social-card.png');

  try {
    await sharp({
      create: {
        width: 1600,
        height: 800,
        channels: 3,
        background: { r: 80, g: 120, b: 200 },
      },
    })
      .png()
      .toFile(inputPath);

    const inputFile = await statInput(inputPath);
    const preset = clonePreset(defaultPresets.find((item) => item.id === 'twitter-og') || defaultPresets[0]);
    preset.export = {
      destination: 'custom',
      customPath: outputDir,
      siblingFolderName: 'optimized',
      overwrite: true,
      openFolderWhenDone: false,
    };

    const result = await processOneImage(inputFile, preset, 0);
    assert.equal(result.success, true, result.error);

    const meta = await sharp(result.outputPath).metadata();
    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 628);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('transform applies clockwise rotation and post-rotation horizontal flip', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-transform-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });
  const inputPath = path.join(tmpRoot, 'tiles.png');

  try {
    const pixels = Buffer.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255,
      255, 255, 0, 255, 0, 255, 0, 255, 255,
    ]);

    await sharp(pixels, {
      raw: {
        width: 3,
        height: 2,
        channels: 3,
      },
    })
      .png()
      .toFile(inputPath);

    const inputFile = await statInput(inputPath);
    const rotatePreset = makePreset(outputDir);
    rotatePreset.naming.suffix = '-rotate';
    rotatePreset.transform = {
      rotation: 90,
      flipH: false,
      flipV: false,
    };
    rotatePreset.output.pngCompressionLevel = 0;

    const rotateResult = await processOneImage(inputFile, rotatePreset, 0);
    assert.equal(rotateResult.success, true, rotateResult.error);

    const rotatedRaw = await readRawRgb(rotateResult.outputPath);
    assert.equal(rotatedRaw.width, 2);
    assert.equal(rotatedRaw.height, 3);
    assert.deepEqual(pixelAt(rotatedRaw, 0, 0), [255, 255, 0]);
    assert.deepEqual(pixelAt(rotatedRaw, 1, 0), [255, 0, 0]);
    assert.deepEqual(pixelAt(rotatedRaw, 0, 2), [0, 255, 255]);
    assert.deepEqual(pixelAt(rotatedRaw, 1, 2), [0, 0, 255]);

    const preset = makePreset(outputDir);
    preset.naming.suffix = '-rotate-flip-h';
    preset.transform = {
      rotation: 90,
      flipH: true,
      flipV: false,
    };
    preset.output.pngCompressionLevel = 0;

    const result = await processOneImage(inputFile, preset, 0);
    assert.equal(result.success, true, result.error);

    const raw = await readRawRgb(result.outputPath);
    assert.equal(raw.width, 2);
    assert.equal(raw.height, 3);
    assert.deepEqual(pixelAt(raw, 0, 0), [255, 0, 0]);
    assert.deepEqual(pixelAt(raw, 1, 0), [255, 255, 0]);
    assert.deepEqual(pixelAt(raw, 0, 2), [0, 0, 255]);
    assert.deepEqual(pixelAt(raw, 1, 2), [0, 255, 255]);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('crop is evaluated on the transformed image frame', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-transform-crop-'));
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });
  const inputPath = path.join(tmpRoot, 'solid.png');

  try {
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 },
      },
    })
      .png()
      .toFile(inputPath);

    const inputFile = await statInput(inputPath);
    const preset = makePreset(outputDir);
    preset.crop = {
      enabled: true,
      x: 40,
      y: 40,
      width: 20,
      height: 20,
      aspectRatio: null,
      aspectAnchor: 'top-left',
      positionMode: 'xy',
    };
    preset.transform = {
      rotation: 45,
      flipH: false,
      flipV: false,
    };
    preset.output.pngCompressionLevel = 0;

    const result = await processOneImage(inputFile, preset, 0);
    assert.equal(result.success, true, result.error);

    const raw = await readRawRgba(result.outputPath);
    assert.equal(raw.width, 29);
    assert.equal(raw.height, 29);
    assert.deepEqual(pixelAt(raw, 0, 0), [0, 0, 255]);
    assert.ok(alphaAt(raw, 0, 0) > 240);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('metadata naming and export settings affect actual output files', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-output-'));
  const outputDir = path.join(tmpRoot, 'custom');
  await fs.mkdir(outputDir, { recursive: true });
  const inputPath = path.join(tmpRoot, 'claude-ai-generated-seedream-product-shot.jpg');

  try {
    await sharp({
      create: {
        width: 90,
        height: 60,
        channels: 3,
        background: { r: 30, g: 130, b: 90 },
      },
    })
      .jpeg()
      .withExif({
        IFD0: {
          Make: 'TestCam',
          Model: 'ModelY',
        },
      })
      .toFile(inputPath);

    const inputFile = await statInput(inputPath);
    const preset = makePreset(outputDir);
    preset.output.format = 'jpeg';
    preset.metadata = {
      mode: 'strip-all',
      convertToSrgb: true,
    };
    preset.naming = {
      ...preset.naming,
      sanitizeAiTerms: false,
      keepOriginal: false,
      prefix: 'web-',
      suffix: '-final',
      sequential: true,
      sequentialStart: 41,
    };
    preset.export.overwrite = false;

    await fs.writeFile(path.join(outputDir, 'web-product-shot-final-041.jpeg'), 'existing');

    const result = await processOneImage(inputFile, preset, 0);
    assert.equal(result.success, true, result.error);
    assert.equal(path.dirname(result.outputPath), outputDir);
    assert.equal(path.basename(result.outputPath), 'web-product-shot-final-041-2.jpeg');

    const meta = await sharp(result.outputPath).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(Boolean(meta.exif), false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('synthetic cleanup removes alpha and crops known AI image dimensions', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-synthetic-'));
  const outputDir = path.join(tmpRoot, 'custom');
  await fs.mkdir(outputDir, { recursive: true });
  const inputPath = path.join(tmpRoot, 'ai-generated-square.png');

  try {
    await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 4,
        background: { r: 80, g: 90, b: 120, alpha: 0.65 },
      },
    })
      .png()
      .toFile(inputPath);

    const inputFile = await statInput(inputPath);
    const preset = makePreset(outputDir);
    preset.output.format = 'png';
    preset.metadata = {
      mode: 'keep-all',
      convertToSrgb: false,
      syntheticMode: 'process',
      rewriteMode: 'off',
      creatorName: '',
    };
    preset.naming.keepOriginal = true;

    const result = await processOneImage(inputFile, preset, 0);

    assert.equal(result.success, true, result.error);
    assert.match(result.warnings?.join('\n') || '', /Synthetic image cleanup/);
    const outputMeta = await sharp(result.outputPath).metadata();
    assert.equal(outputMeta.width, 992);
    assert.equal(outputMeta.height, 992);
    assert.equal(outputMeta.hasAlpha, false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
