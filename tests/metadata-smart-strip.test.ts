import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import sharp from 'sharp';
import type { AppPreset, InputFile } from '../src/core/shared/types';
import { defaultPresets } from '../src/core/presets/default-presets';
import { planBatchOutputs } from '../src/core/files/output-plan';
import { processOneImage } from '../src/core/processing/process-one-image';
import {
  applyOutputMetadataPolicy,
  readExiftoolJson,
  runExiftoolCommand,
  stripGeneratedMetadataArtifacts,
  verifyOutputMetadataPolicy,
} from '../src/core/processing/metadata-cleaning';

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

function makeMetadataPreset(outputDir: string): AppPreset {
  const base = clonePreset(defaultPresets[0]);
  return {
    ...base,
    output: { ...base.output, format: 'jpeg' },
    resize: { ...base.resize, mode: 'none', responsiveWidths: [] },
    crop: { ...base.crop, enabled: false },
    transform: { ...base.transform, rotation: 0, flipH: false, flipV: false },
    metadata: { mode: 'strip-all', convertToSrgb: true },
    naming: {
      ...base.naming,
      keepOriginal: false,
      sanitizeAiTerms: true,
      sequential: false,
      suffix: '',
    },
    export: {
      ...base.export,
      destination: 'custom',
      customPath: outputDir,
      overwrite: true,
      openFolderWhenDone: false,
    },
  };
}

async function writeExifFixture(inputPath: string): Promise<void> {
  await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 40, g: 100, b: 180 },
    },
  })
    .jpeg()
    .withExif({
      IFD0: {
        Make: 'TestCam',
        Model: 'ModelX',
        Artist: 'Public Artist',
        Copyright: 'Public License',
      },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '40/1 26/1 4608/100',
        GPSLongitudeRef: 'W',
        GPSLongitude: '79/1 58/1 5604/100',
      },
    })
    .toFile(inputPath);
}

test('privacy modes drop EXIF or selectively remove private EXIF fields', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-metadata-'));
  const inputPath = path.join(tmpRoot, 'source.jpg');
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    await writeExifFixture(inputPath);
    const inputFile = await statInput(inputPath);
    const commonPreset = makeMetadataPreset(outputDir);

    const smartResult = await processOneImage(
      inputFile,
      {
        ...commonPreset,
        naming: { ...commonPreset.naming, suffix: '-smart' },
        metadata: { mode: 'strip-privacy-smart', convertToSrgb: true },
      },
      0,
    );
    assert.equal(smartResult.success, true);

    const selectiveResult = await processOneImage(
      inputFile,
      {
        ...commonPreset,
        naming: { ...commonPreset.naming, suffix: '-selective' },
        metadata: { mode: 'strip-gps-only', convertToSrgb: true },
      },
      0,
    );
    assert.equal(selectiveResult.success, true, selectiveResult.error);

    const smartMeta = await sharp(smartResult.outputPath).metadata();
    const selectiveMeta = await sharp(selectiveResult.outputPath).metadata();
    const selectiveTags = await readExiftoolJson(selectiveResult.outputPath);
    const selectiveGpsKeys = Object.keys(selectiveTags).filter((key) => (
      key.startsWith('GPS:') || key.startsWith('Composite:GPS')
    ));

    assert.equal(Boolean(smartMeta.exif), false);
    await verifyOutputMetadataPolicy(smartResult.outputPath, { mode: 'strip-privacy-smart', convertToSrgb: true });
    assert.equal(Boolean(selectiveMeta.exif), true);
    await verifyOutputMetadataPolicy(selectiveResult.outputPath, { mode: 'strip-gps-only', convertToSrgb: true });
    assert.equal(selectiveTags['IFD0:Artist'], 'Public Artist');
    assert.equal(selectiveTags['IFD0:Copyright'], 'Public License');
    assert.equal('IFD0:Make' in selectiveTags, false);
    assert.equal('IFD0:Model' in selectiveTags, false);
    assert.deepEqual(selectiveGpsKeys, []);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('strip-all replaces source safely when final path equals source path', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-metadata-in-place-'));
  const inputPath = path.join(tmpRoot, 'source.jpeg');

  try {
    await writeExifFixture(inputPath);
    const inputFile = await statInput(inputPath);
    const preset = makeMetadataPreset(tmpRoot);
    preset.output.format = 'keep-original';
    preset.naming.keepOriginal = true;
    preset.export.overwrite = true;

    const result = await processOneImage(inputFile, preset, 0);

    assert.equal(result.success, true, result.error);
    assert.equal(path.resolve(result.outputPath), path.resolve(inputPath));
    assert.equal((await sharp(inputPath).metadata()).format, 'jpeg');
    await verifyOutputMetadataPolicy(inputPath, preset.metadata);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('strip-all verifies supported output formats and responsive variants', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-metadata-formats-'));
  const inputPath = path.join(tmpRoot, 'source.jpg');
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    await writeExifFixture(inputPath);
    const inputFile = await statInput(inputPath);
    const formats: Array<AppPreset['output']['format']> = ['jpeg', 'png', 'webp', 'avif', 'tiff'];

    for (const format of formats) {
      const preset = makeMetadataPreset(outputDir);
      preset.output.format = format;
      preset.naming.suffix = `-${format}`;

      const result = await processOneImage(inputFile, preset, 0);
      assert.equal(result.success, true, result.error);
      await verifyOutputMetadataPolicy(result.outputPath, preset.metadata);
    }

    const responsivePreset = makeMetadataPreset(outputDir);
    responsivePreset.output.format = 'webp';
    responsivePreset.resize = {
      mode: 'width',
      width: 80,
      noUpscale: true,
      responsiveWidths: [40],
    };

    const responsiveResult = await processOneImage(inputFile, responsivePreset, 0);
    assert.equal(responsiveResult.success, true, responsiveResult.error);
    assert.equal(responsiveResult.generatedOutputs?.length, 2);
    for (const output of responsiveResult.generatedOutputs || []) {
      await verifyOutputMetadataPolicy(output.outputPath, responsivePreset.metadata);
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('smart privacy keeps ICC while removing embedded metadata from PNG', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-metadata-icc-'));
  const samplePath = path.join(tmpRoot, 'source-with-icc.png');
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    await sharp({
      create: {
        width: 96,
        height: 64,
        channels: 3,
        background: { r: 120, g: 80, b: 40 },
      },
    })
      .withMetadata({ icc: 'srgb' })
      .png()
      .toFile(samplePath);

    const inputFile = await statInput(samplePath);
    const preset = makeMetadataPreset(outputDir);
    preset.output.format = 'png';
    preset.metadata = { mode: 'strip-privacy-smart', convertToSrgb: false };

    const result = await processOneImage(inputFile, preset, 0);
    assert.equal(result.success, true, result.error);

    const tags = await readExiftoolJson(result.outputPath);
    assert.ok(Object.keys(tags).some((key) => key.startsWith('ICC_Profile:')));
    await verifyOutputMetadataPolicy(result.outputPath, preset.metadata);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('HEIC keep-original fallback strips private metadata when supported by sharp', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-metadata-heic-'));
  const samplePath = path.join(tmpRoot, 'source.heic');
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    try {
      await sharp({
        create: {
          width: 128,
          height: 96,
          channels: 3,
          background: { r: 60, g: 90, b: 120 },
        },
      })
        .heif({ compression: 'av1' })
        .toFile(samplePath);
      await sharp(samplePath).metadata();
    } catch {
      // This Sharp build has no libheif encode support; nothing to exercise.
      return;
    }

    const inputFile = await statInput(samplePath);
    const preset = makeMetadataPreset(outputDir);
    preset.output.format = 'keep-original';

    const plan = await planBatchOutputs({ files: [inputFile], preset });
    if (plan.summary.errorCount > 0) {
      assert.ok(plan.issues.some((item) => item.code === 'source-decode-unsupported'));
      return;
    }

    const result = await processOneImage(inputFile, preset, 0);
    assert.equal(result.success, true, result.error);
    assert.equal(path.extname(result.outputPath), '.jpeg');
    await verifyOutputMetadataPolicy(result.outputPath, preset.metadata);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('metadata verifier fails dirty files and cleanup reports non-fatal failures', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-metadata-verify-'));
  const dirtyPath = path.join(tmpRoot, 'dirty.png');

  try {
    await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 20, g: 30, b: 40 },
      },
    })
      .png()
      .toFile(dirtyPath);
    await runExiftoolCommand([
      '-overwrite_original',
      '-XMP-dc:Description=private prompt',
      '-XMP-iptcExt:DigitalImageGUID=ai-generated-guid',
      dirtyPath,
    ]);

    await assert.rejects(
      verifyOutputMetadataPolicy(dirtyPath, { mode: 'strip-all', convertToSrgb: true }),
      /forbidden tags remain/,
    );
    await assert.rejects(
      verifyOutputMetadataPolicy(dirtyPath, { mode: 'strip-gps-only', convertToSrgb: true }),
      /DigitalImageGUID/,
    );

    const cleanup = await stripGeneratedMetadataArtifacts(path.join(tmpRoot, 'missing.jpg'));
    assert.equal(cleanup.ok, false);
    assert.ok(cleanup.warnings.length > 0);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('metadata rewrite adds creator and jittered timestamps after strict cleanup', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-metadata-rewrite-'));
  const outputPath = path.join(tmpRoot, 'rewrite.png');
  const metadata = {
    mode: 'strip-all' as const,
    convertToSrgb: true,
    syntheticMode: 'off' as const,
    rewriteMode: 'timestamp-jitter-and-creator' as const,
    creatorName: 'Editorial Desk',
  };

  try {
    await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 120, g: 80, b: 40 },
      },
    })
      .png()
      .toFile(outputPath);
    const result = await applyOutputMetadataPolicy(outputPath, metadata);
    const tags = await readExiftoolJson(outputPath);

    assert.deepEqual(result.warnings, []);
    assert.ok(Array.isArray(tags['XMP-dc:Creator']));
    assert.deepEqual(tags['XMP-dc:Creator'], ['Editorial Desk']);
    assert.equal(typeof tags['XMP-xmp:CreateDate'], 'string');
    assert.equal(typeof tags['XMP-xmp:ModifyDate'], 'string');
    assert.equal(typeof tags['PNG:CreationTime'], 'string');
    await verifyOutputMetadataPolicy(outputPath, metadata);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
