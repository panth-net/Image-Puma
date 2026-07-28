import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import sharp from 'sharp';
import type { AppPreset, InputFile } from '../src/core/shared/types';
import { defaultPresets } from '../src/core/presets/default-presets';
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

async function createInput(tmpRoot: string): Promise<InputFile> {
  const inputPath = path.join(tmpRoot, 'source.jpg');
  await sharp({
    create: {
      width: 80,
      height: 60,
      channels: 3,
      background: { r: 30, g: 90, b: 140 },
    },
  }).jpeg().toFile(inputPath);

  const stat = await fs.stat(inputPath);
  return {
    sourcePath: inputPath,
    relativePath: 'source.jpg',
    fileName: 'source',
    extension: '.jpg',
    fileSize: stat.size,
  };
}

test('planBatchOutputs shows planned rename collision without writing outputs', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-plan-'));
  try {
    const inputFile = await createInput(tmpRoot);
    const existingDir = path.join(tmpRoot, 'optimized');
    await fs.mkdir(existingDir);
    await fs.writeFile(path.join(existingDir, 'source.webp'), 'existing');

    const preset = clonePreset(defaultPresets.find((item) => item.id === 'web-upload') || defaultPresets[0]);
    const plan = await planBatchOutputs({
      files: [inputFile],
      preset,
    });
    preset.export.siblingFolderName = 'mutated-after-plan';

    assert.equal(plan.summary.sourceCount, 1);
    assert.equal(plan.summary.outputCount, 1);
    assert.equal(plan.preset.export.siblingFolderName, 'optimized');
    assert.equal(plan.summary.errorCount, 0);
    assert.equal(plan.entries[0].variants[0].collision, 'renamed');
    assert.equal(path.basename(plan.entries[0].variants[0].outputPath), 'source-2.webp');
    await assert.rejects(fs.access(path.join(existingDir, 'source-2.webp')));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('planBatchOutputs blocks invalid resize and custom export settings', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-plan-invalid-'));
  try {
    const inputFile = await createInput(tmpRoot);
    const preset = clonePreset(defaultPresets[0]);
    preset.resize = {
      ...preset.resize,
      mode: 'width',
      width: undefined,
    };
    preset.export = {
      ...preset.export,
      destination: 'custom',
      customPath: '',
    };

    const plan = await planBatchOutputs({
      files: [inputFile],
      preset,
    });

    assert.equal(plan.summary.errorCount, 2);
    assert.ok(plan.issues.some((item) => item.code === 'resize-width-required'));
    assert.ok(plan.issues.some((item) => item.code === 'export-folder-required'));
    assert.equal(plan.entries[0].variants.length, 0);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('planBatchOutputs applies the first source format across a mixed-format batch', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-plan-batch-format-'));
  try {
    const pngPath = path.join(tmpRoot, 'first.png');
    const jpegPath = path.join(tmpRoot, 'second.jpg');
    await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 30, g: 90, b: 140 },
      },
    }).png().toFile(pngPath);
    await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 140, g: 90, b: 30 },
      },
    }).jpeg().toFile(jpegPath);

    const files: InputFile[] = [];
    for (const inputPath of [pngPath, jpegPath]) {
      const stat = await fs.stat(inputPath);
      const parsed = path.parse(inputPath);
      files.push({
        sourcePath: inputPath,
        relativePath: parsed.base,
        fileName: parsed.name,
        extension: parsed.ext,
        fileSize: stat.size,
      });
    }
    const preset = clonePreset(defaultPresets[0]);
    const plan = await planBatchOutputs({ files, preset });

    assert.equal(plan.preset.output.format, 'png');
    assert.deepEqual(
      plan.entries.map((entry) => entry.variants[0].format),
      ['png', 'png'],
    );
    assert.deepEqual(
      plan.entries.map((entry) => path.extname(entry.variants[0].outputPath)),
      ['.png', '.png'],
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('planBatchOutputs does not produce variants after metadata inspection errors', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-plan-bad-metadata-'));
  const inputPath = path.join(tmpRoot, 'broken.jpg');
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    await fs.writeFile(inputPath, 'not an image');
    const stat = await fs.stat(inputPath);
    const inputFile: InputFile = {
      sourcePath: inputPath,
      relativePath: 'broken.jpg',
      fileName: 'broken',
      extension: '.jpg',
      fileSize: stat.size,
    };
    const preset = clonePreset(defaultPresets[0]);
    preset.export = {
      ...preset.export,
      destination: 'custom',
      customPath: outputDir,
    };

    const plan = await planBatchOutputs({
      files: [inputFile],
      preset,
    });

    assert.equal(plan.summary.errorCount, 1);
    assert.ok(plan.issues.some((item) => item.code === 'metadata-unreadable'));
    assert.equal(plan.summary.outputCount, 0);
    assert.equal(plan.entries[0].variants.length, 0);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
