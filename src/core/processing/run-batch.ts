import * as path from 'path';
import {
  AppPreset,
  BackgroundRemovalInputFile,
  BackgroundRemovalJobRequest,
  BatchJobRequest,
  BatchJobResult,
  BatchOutputPlan,
  BatchProgressUpdate,
  InputFile,
  PlannedOutputVariant,
  ProcessedFileResult,
} from '../shared/types';
import { isBackgroundRemovalEnabled } from '../shared/background-removal-settings';
import { processOneImage } from './process-one-image';
import { createBatchProgressTracker } from './batch-progress';
import { planBatchOutputs } from '../files/output-plan';
import type { ImageProcessingLimits } from './processing-limits';

const DEFAULT_MAX_CONCURRENT_FILES = 4;

export interface RunBatchBackgroundRemoval {
  assertAvailable?: () => void;
  run: (
    request: BackgroundRemovalJobRequest,
    context: { signal?: AbortSignal },
  ) => Promise<ProcessedFileResult[]>;
}

export interface RunBatchCoreOptions {
  onProgress?: (progress: BatchProgressUpdate) => void;
  signal?: AbortSignal;
  maxConcurrentFiles?: number;
  processingLimits?: ImageProcessingLimits;
  backgroundRemoval?: RunBatchBackgroundRemoval;
  processImage?: (
    file: InputFile,
    preset: AppPreset,
    index: number,
    plannedVariants?: PlannedOutputVariant[],
    processingLimits?: ImageProcessingLimits,
  ) => Promise<ProcessedFileResult>;
}

function getDisplayName(file: { fileName: string; extension: string }): string {
  return `${file.fileName}${file.extension}`;
}

function isCancelled(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

function emitProgress(options: RunBatchCoreOptions, progress: BatchProgressUpdate): void {
  options.onProgress?.(progress);
}

function getOutputFormat(outputPath: string): 'png' | 'webp' | null {
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  return null;
}

function getOutputInputFile(outputPath: string, outputSize: number): BackgroundRemovalInputFile | null {
  const outputFormat = getOutputFormat(outputPath);
  if (!outputFormat) return null;

  const parsed = path.parse(outputPath);
  return {
    sourcePath: outputPath,
    outputPath,
    outputFormat,
    relativePath: path.basename(outputPath),
    fileName: parsed.name,
    extension: parsed.ext,
    fileSize: outputSize,
  };
}

function mergeBackgroundRemovalResults(
  results: ProcessedFileResult[],
  backgroundResults: ProcessedFileResult[],
): ProcessedFileResult[] {
  const backgroundByOutputPath = new Map(backgroundResults.map((result) => [path.resolve(result.sourcePath), result]));

  return results.map((result) => {
    if (!result.success || !result.generatedOutputs?.length) return result;

    const warnings = [...(result.warnings || [])];
    const updatedOutputs = result.generatedOutputs.map((output) => {
      const backgroundResult = backgroundByOutputPath.get(path.resolve(output.outputPath));
      const backgroundOutput = backgroundResult?.generatedOutputs?.[0];
      if (!backgroundResult?.success || !backgroundOutput) return output;

      return {
        ...output,
        outputSize: backgroundOutput.outputSize,
        width: backgroundOutput.width,
        height: backgroundOutput.height,
      };
    });

    const failures = result.generatedOutputs
      .map((output) => (
        backgroundByOutputPath.get(path.resolve(output.outputPath))
        || {
          sourcePath: output.outputPath,
          outputPath: '',
          originalSize: output.outputSize,
          outputSize: 0,
          success: false,
          error: 'Background removal did not return a result for this output.',
        }
      ))
      .filter((backgroundResult) => !backgroundResult.success);

    if (failures.length > 0) {
      return {
        ...result,
        success: false,
        error: failures[0].error || 'Background removal failed for one or more exported files.',
        cancelled: failures.some((failure) => failure.cancelled) || undefined,
        skipped: failures.some((failure) => failure.skipped) || undefined,
        generatedOutputs: updatedOutputs,
      };
    }

    warnings.push('Background removed after recipe edits and before final export review.');

    return {
      ...result,
      outputSize: updatedOutputs.reduce((total, output) => total + output.outputSize, 0),
      generatedOutputs: updatedOutputs,
      warnings,
    };
  });
}

async function applyBackgroundRemovalToExportedOutputs(
  results: ProcessedFileResult[],
  preset: BatchJobRequest['preset'],
  options: RunBatchCoreOptions,
): Promise<ProcessedFileResult[]> {
  if (!options.backgroundRemoval) {
    throw new Error('Background removal is unavailable in this adapter.');
  }

  const outputInputs = results
    .filter((result) => result.success)
    .flatMap((result) => result.generatedOutputs || [])
    .map((output) => getOutputInputFile(output.outputPath, output.outputSize))
    .filter((file): file is BackgroundRemovalInputFile => Boolean(file));
  const unsupportedOutput = results
    .filter((result) => result.success)
    .flatMap((result) => result.generatedOutputs || [])
    .find((output) => !getOutputFormat(output.outputPath));

  if (unsupportedOutput) {
    throw new Error('Background removal needs PNG or WebP output to preserve transparent cutouts.');
  }

  if (outputInputs.length === 0) return results;

  emitProgress(options, {
    completedCount: results.length,
    totalCount: results.length,
    currentFile: 'Removing backgrounds from exported files',
    status: isCancelled(options.signal) ? 'stopping' : 'running',
  });

  const firstOutputFolder = path.dirname(outputInputs[0].outputPath || outputInputs[0].sourcePath);
  const backgroundResults = await options.backgroundRemoval.run({
    files: outputInputs,
    settings: {
      destination: 'custom',
      customPath: firstOutputFolder,
      outputFolderName: '',
      outputFormat: 'png',
      webpQuality: preset.output.webpQuality,
      overwrite: true,
    },
  }, { signal: options.signal });

  return mergeBackgroundRemovalResults(results, backgroundResults);
}

async function resolveBatchPlan(request: BatchJobRequest): Promise<BatchOutputPlan> {
  if (!request.plan) {
    return planBatchOutputs(request);
  }

  if (request.plan.entries.length !== request.files.length) {
    throw new Error('Preflight plan no longer matches the selected files.');
  }

  for (const file of request.files) {
    const entry = request.plan.entries.find((item) => item.sourcePath === file.sourcePath);
    if (!entry) {
      throw new Error('Preflight plan no longer matches the selected files.');
    }
    if (entry.variants.length === 0) {
      throw new Error('Preflight plan has no output for one or more selected files.');
    }
  }

  return request.plan;
}

function createCancelledResult(file: InputFile): ProcessedFileResult {
  const now = new Date().toISOString();
  return {
    sourcePath: file.sourcePath,
    outputPath: '',
    originalSize: file.fileSize,
    outputSize: 0,
    success: false,
    skipped: true,
    cancelled: true,
    error: 'Cancelled',
    startedAt: now,
    completedAt: now,
  };
}

export async function runBatchCore(
  request: BatchJobRequest,
  options: RunBatchCoreOptions = {},
): Promise<BatchJobResult> {
  const { files, preset } = request;
  const plan = await resolveBatchPlan(request);
  const blockingIssue = plan.issues.find((item) => item.level === 'error');
  if (blockingIssue) {
    throw new Error(blockingIssue.message);
  }
  if (isBackgroundRemovalEnabled(preset)) {
    if (!options.backgroundRemoval) {
      throw new Error('Background removal is unavailable in this adapter.');
    }
    options.backgroundRemoval.assertAvailable?.();
  }

  const plannedEntryBySourcePath = new Map(
    plan.entries.map((entry) => [entry.sourcePath, entry]),
  );

  const results: ProcessedFileResult[] = [];
  let totalOriginal = 0;
  let totalOutput = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let cancelledCount = 0;
  const progressTracker = createBatchProgressTracker(files.length);
  const processImage = options.processImage || processOneImage;

  const pLimitMod = await import('p-limit');
  const pLimit = pLimitMod.default;
  const limit = pLimit(options.maxConcurrentFiles || DEFAULT_MAX_CONCURRENT_FILES);

  const tasks = files.map((file, index) =>
    limit(async () => {
      const displayName = getDisplayName(file);
      if (isCancelled(options.signal)) {
        const cancelledResult = createCancelledResult(file);
        emitProgress(
          options,
          progressTracker.markCompleted(file.sourcePath, displayName, cancelledResult, 'stopping'),
        );
        return cancelledResult;
      }

      emitProgress(
        options,
        progressTracker.markStarted(file.sourcePath, displayName, 'running'),
      );

      const startedAt = new Date().toISOString();
      const plannedEntry = plannedEntryBySourcePath.get(file.sourcePath);
      const result = {
        ...(await processImage(file, preset, index, plannedEntry?.variants, options.processingLimits)),
        startedAt,
        completedAt: new Date().toISOString(),
      };

      emitProgress(
        options,
        progressTracker.markCompleted(
          file.sourcePath,
          displayName,
          result,
          isCancelled(options.signal) ? 'stopping' : 'running',
        ),
      );

      return result;
    }),
  );

  let allResults = await Promise.all(tasks);

  if (!isCancelled(options.signal) && isBackgroundRemovalEnabled(preset)) {
    allResults = await applyBackgroundRemovalToExportedOutputs(allResults, preset, options);
  }

  for (const r of allResults) {
    results.push(r);
    totalOriginal += r.originalSize;
    if (r.success) {
      totalOutput += r.outputSize;
      successCount++;
    } else if (r.skipped) {
      skippedCount++;
      if (r.cancelled) {
        cancelledCount++;
      }
    } else {
      failureCount++;
    }
  }

  emitProgress(
    options,
    progressTracker.snapshot(
      '',
      isCancelled(options.signal) && cancelledCount > 0 ? 'cancelled' : 'completed',
    ),
  );

  return {
    results,
    totalOriginalBytes: totalOriginal,
    totalOutputBytes: totalOutput,
    totalSavedBytes: totalOriginal - totalOutput,
    successCount,
    failureCount,
    skippedCount,
    cancelledCount,
  };
}
