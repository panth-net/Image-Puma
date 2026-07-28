import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppPreset, BatchOutputPlan, InputFile, ProcessedFileResult } from '../src/core/shared/types';
import { defaultPresets } from '../src/core/presets/default-presets';
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

function inputFile(sourcePath: string): InputFile {
  return {
    sourcePath,
    relativePath: sourcePath.split('/').pop() || sourcePath,
    fileName: sourcePath.replace(/^.*\//, '').replace(/\.[^.]+$/, ''),
    extension: '.jpg',
    fileSize: 100,
    width: 20,
    height: 20,
    format: 'jpeg',
  };
}

function planFor(files: InputFile[], preset: AppPreset): BatchOutputPlan {
  const entries: BatchOutputPlan['entries'] = files.map((file) => ({
    sourcePath: file.sourcePath,
    fileName: file.fileName,
    sourceSize: file.fileSize,
    outputFolder: '/out',
    variants: [{
      outputPath: `/out/${file.fileName}.jpg`,
      baseOutputPath: `/out/${file.fileName}.jpg`,
      format: 'jpeg',
      collision: 'none',
      preset,
    }],
    issues: [] as BatchOutputPlan['entries'][number]['issues'],
  }));

  return {
    preset,
    entries,
    issues: [] as BatchOutputPlan['issues'],
    summary: {
      sourceCount: files.length,
      outputCount: files.length,
      errorCount: 0,
      warningCount: 0,
      destinationFolders: ['/out'],
    },
  };
}

function success(file: InputFile): ProcessedFileResult {
  return {
    sourcePath: file.sourcePath,
    outputPath: `/out/${file.fileName}.jpg`,
    originalSize: file.fileSize,
    outputSize: 50,
    success: true,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for condition');
}

test('runBatchCore cancellation is scoped to one overlapping run', async () => {
  const preset = clonePreset(defaultPresets[0]);
  const firstRunFiles = [inputFile('/in/a-1.jpg'), inputFile('/in/a-2.jpg')];
  const secondRunFiles = [inputFile('/in/b-1.jpg'), inputFile('/in/b-2.jpg')];
  const controller = new AbortController();
  const firstRunStarted: string[] = [];
  let releaseFirstFile: (() => void) | null = null;

  const firstRun = runBatchCore(
    { files: firstRunFiles, preset, plan: planFor(firstRunFiles, preset) },
    {
      signal: controller.signal,
      maxConcurrentFiles: 1,
      processImage: async (file) => {
        firstRunStarted.push(file.sourcePath);
        if (file.sourcePath === firstRunFiles[0].sourcePath) {
          await new Promise<void>((resolve) => {
            releaseFirstFile = resolve;
          });
        }
        return success(file);
      },
    },
  );

  await waitFor(() => firstRunStarted.length === 1 && Boolean(releaseFirstFile));

  const secondRun = runBatchCore(
    { files: secondRunFiles, preset, plan: planFor(secondRunFiles, preset) },
    {
      maxConcurrentFiles: 1,
      processImage: async (file) => success(file),
    },
  );

  controller.abort();
  releaseFirstFile?.();

  const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);

  assert.equal(firstResult.successCount, 1);
  assert.equal(firstResult.cancelledCount, 1);
  assert.equal(firstResult.skippedCount, 1);
  assert.equal(secondResult.successCount, 2);
  assert.equal(secondResult.cancelledCount, 0);
  assert.equal(secondResult.skippedCount, 0);
});
