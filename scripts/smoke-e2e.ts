import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import type { AppPreset } from '../src/core/shared/types';
import { scanInputs } from '../src/core/files/scan-input';
import { defaultPresets } from '../src/core/presets/default-presets';
import { generatePreview } from '../src/core/processing/generate-preview';
import { runBatchCore } from '../src/core/processing/run-batch';

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

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-smoke-'));
  const sourceDir = path.join(tmpRoot, 'in');
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const inputPath = path.join(sourceDir, 'sample.png');

  try {
    await sharp({
      create: {
        width: 200,
        height: 120,
        channels: 3,
        background: { r: 220, g: 40, b: 40 },
      },
    }).png().toFile(inputPath);

    const scan = await scanInputs([sourceDir]);
    assert.equal(scan.files.length, 1, 'expected one imported file');

    const base = clonePreset(defaultPresets.find((preset) => preset.id === 'web-upload') || defaultPresets[0]);
    const preset: AppPreset = {
      ...base,
      output: { ...base.output, format: 'jpeg', jpegQuality: 78 },
      resize: { ...base.resize, mode: 'width', width: 160, responsiveWidths: [80] },
      naming: { ...base.naming, keepOriginal: false, prefix: 'smoke-' },
      export: {
        ...base.export,
        destination: 'custom',
        customPath: outputDir,
        overwrite: true,
        openFolderWhenDone: false,
      },
    };

    const preview = await generatePreview(scan.files[0], preset);
    assert.ok(preview.outputWidth > 0, 'preview width should be > 0');
    assert.ok(preview.outputHeight > 0, 'preview height should be > 0');

    const batch = await runBatchCore(
      {
        files: scan.files,
        preset,
      },
    );

    assert.equal(batch.successCount, 1, 'batch should process one file');
    assert.equal(batch.failureCount, 0, 'batch should have no failures');

    const firstResult = batch.results[0];
    assert.equal(firstResult.success, true, 'result should be successful');
    assert.ok(Array.isArray(firstResult.generatedOutputs), 'responsive outputs should be present');
    assert.equal(firstResult.generatedOutputs?.length, 2, 'expected base + one responsive output');

    for (const output of firstResult.generatedOutputs || []) {
      await fs.access(output.outputPath);
      assert.ok(output.outputSize > 0, 'output file should be non-empty');
    }

    // eslint-disable-next-line no-console
    console.log(`Smoke OK: ${batch.successCount} file processed, ${firstResult.generatedOutputs?.length || 0} outputs generated`);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Smoke script failed:', err);
  process.exit(1);
});
