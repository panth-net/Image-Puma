import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs/promises';
import { InputFile, AppPreset, PlannedOutputVariant, ProcessedFileResult } from '../shared/types';
import { doesPresetChangeImageBytesForFile } from '../shared/recipe-helpers';
import { buildPipeline } from './build-pipeline';
import { applyOutputMetadataPolicy } from './metadata-cleaning';
import { buildSyntheticImageCleanupPlan } from './synthetic-cleaning';
import { ensureNoOverwrite, ensureDir, resolvePlannedOutputPaths } from '../files/export-paths';
import { nativeDecodeRunWarning, prepareSharpInput } from '../files/prepare-sharp-input';
import type { ImageProcessingLimits } from './processing-limits';
import { normalizeImageProcessingLimits } from './processing-limits';
import {
  getIconOutputSize,
  isIconOutputFormat,
  renderIconContainer,
} from './icon-containers';

interface OutputToProcess {
  outputPath: string;
  preset: AppPreset;
  resolvedFormat: string;
}

async function reserveFinalOutputPath(finalPath: string): Promise<void> {
  const handle = await fs.open(finalPath, 'wx');
  await handle.close();
}

async function createTempOutputPath(finalPath: string): Promise<string> {
  const dir = path.dirname(finalPath);
  const ext = path.extname(finalPath);
  const base = path.basename(finalPath, ext);

  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const candidate = path.join(dir, `.${base}.${suffix}.tmp${ext}`);
    try {
      const handle = await fs.open(candidate, 'wx');
      await handle.close();
      await fs.unlink(candidate);
      return candidate;
    } catch {
      // Try another random suffix.
    }
  }

  throw new Error(`Could not reserve a temporary output path for ${finalPath}`);
}

async function moveIntoPlace(tempPath: string, finalPath: string): Promise<void> {
  try {
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch((): void => undefined);
    throw error;
  }
}

async function cleanupPath(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true }).catch((): void => undefined);
}

async function readOutputMetadata(
  finalPath: string,
  file: InputFile,
  shouldProcess: boolean,
  resolvedFormat: string,
  processingLimits?: ImageProcessingLimits,
): Promise<Pick<InputFile, 'width' | 'height'>> {
  if (isIconOutputFormat(resolvedFormat)) {
    const size = getIconOutputSize(resolvedFormat);
    return { width: size, height: size };
  }
  const limits = normalizeImageProcessingLimits(processingLimits);
  try {
    const outputMeta = await sharp(finalPath, { limitInputPixels: limits.limitInputPixels }).metadata();
    return {
      width: outputMeta.width,
      height: outputMeta.height,
    };
  } catch (error) {
    if (shouldProcess) throw error;
    return {
      width: file.width,
      height: file.height,
    };
  }
}

export async function processOneImage(
  file: InputFile,
  preset: AppPreset,
  index: number,
  plannedVariants?: PlannedOutputVariant[],
  processingLimits?: ImageProcessingLimits,
): Promise<ProcessedFileResult> {
  try {
    const plannedOutputs: OutputToProcess[] = plannedVariants
      ? plannedVariants.map((variant) => ({
        outputPath: variant.outputPath,
        preset: variant.preset,
        resolvedFormat: variant.format,
      }))
      : await Promise.all(resolvePlannedOutputPaths(file, preset, index).map(async (plannedOutput) => ({
        outputPath: plannedOutput.preset.export.overwrite
          ? plannedOutput.outputPath
          : await ensureNoOverwrite(plannedOutput.outputPath),
        preset: plannedOutput.preset,
        resolvedFormat: plannedOutput.resolvedFormat,
      })));

    const shouldPrepareInput = plannedOutputs.some((plannedOutput) => (
      doesPresetChangeImageBytesForFile(file, plannedOutput.preset, plannedOutput.resolvedFormat)
    ));
    const preparedInput = shouldPrepareInput
      ? await prepareSharpInput(file.sourcePath, { probeDecode: true, processingLimits })
      : null;
    let meta: sharp.Metadata | null = null;

    const generatedOutputs: NonNullable<ProcessedFileResult['generatedOutputs']> = [];
    const warnings: string[] = [];
    let totalOutputSize = 0;

    if (preparedInput?.usedNativeFallback) {
      warnings.push(nativeDecodeRunWarning());
    }

    try {
      for (const plannedOutput of plannedOutputs) {
        const finalPath = plannedOutput.outputPath;
        const dir = path.dirname(finalPath);
        await ensureDir(dir);

        const shouldProcess = doesPresetChangeImageBytesForFile(file, plannedOutput.preset, plannedOutput.resolvedFormat);
        const overwritesExistingOutput = plannedOutput.preset.export.overwrite;
        const writesSource = path.resolve(finalPath) === path.resolve(file.sourcePath);
        const shouldReserveFinalPath = !overwritesExistingOutput;
        const shouldWriteViaTemp = (shouldProcess && writesSource) || shouldReserveFinalPath;
        let reservedFinalPath = false;
        let writePath = finalPath;
        let tempOutputPath: string | null = null;

        try {
          if (shouldReserveFinalPath) {
            await reserveFinalOutputPath(finalPath);
            reservedFinalPath = true;
          }

          if (shouldWriteViaTemp) {
            tempOutputPath = await createTempOutputPath(finalPath);
            writePath = tempOutputPath;
          }

          if (shouldProcess) {
            if (!preparedInput) throw new Error('Could not prepare source image for processing.');
            meta ||= preparedInput.metadata;
            const syntheticPlan = await buildSyntheticImageCleanupPlan(preparedInput.path, meta, plannedOutput.preset.metadata);
            const pipeline = buildPipeline(
              file,
              plannedOutput.preset,
              'final',
              meta,
              syntheticPlan,
              preparedInput.path,
              processingLimits,
            );
            if (isIconOutputFormat(plannedOutput.resolvedFormat)) {
              const icon = await renderIconContainer(
                pipeline,
                plannedOutput.resolvedFormat,
                plannedOutput.preset.output.pngCompressionLevel,
              );
              await fs.writeFile(writePath, icon.data);
            } else {
              await pipeline.toFile(writePath);
            }
            if (syntheticPlan) {
              const syntheticChanges: string[] = [];
              if (syntheticPlan.alphaRemoved) syntheticChanges.push('alpha removed');
              if (syntheticPlan.cropped) syntheticChanges.push('AI edge crop applied');
              if (syntheticPlan.geminiWatermarkCropped) syntheticChanges.push('Gemini watermark crop applied');
              warnings.push(`Synthetic image cleanup: ${syntheticChanges.join(', ')}.`);
            }
            if (!isIconOutputFormat(plannedOutput.resolvedFormat)) {
              const policyResult = await applyOutputMetadataPolicy(writePath, plannedOutput.preset.metadata);
              warnings.push(...policyResult.warnings);
            }
          } else if (finalPath !== file.sourcePath) {
            await fs.copyFile(file.sourcePath, writePath);
          }

          if (shouldWriteViaTemp) {
            await moveIntoPlace(writePath, finalPath);
            reservedFinalPath = false;
          }
        } catch (error) {
          if (tempOutputPath) {
            await cleanupPath(tempOutputPath);
          }
          if (reservedFinalPath) {
            await cleanupPath(finalPath);
          }
          throw error;
        }

        const { size: outputSize } = await fs.stat(finalPath);
        const outputMeta = await readOutputMetadata(
          finalPath,
          file,
          shouldProcess,
          plannedOutput.resolvedFormat,
          processingLimits,
        );
        totalOutputSize += outputSize;
        generatedOutputs.push({
          outputPath: finalPath,
          outputSize,
          width: outputMeta.width,
          height: outputMeta.height,
        });
      }
    } finally {
      await preparedInput?.dispose();
    }

    const firstOutput = generatedOutputs[0];

    return {
      sourcePath: file.sourcePath,
      outputPath: firstOutput?.outputPath || '',
      originalSize: file.fileSize,
      outputSize: totalOutputSize,
      success: true,
      warnings: warnings.length > 0 ? warnings : undefined,
      generatedOutputs,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      sourcePath: file.sourcePath,
      outputPath: '',
      originalSize: file.fileSize,
      outputSize: 0,
      success: false,
      error: message,
    };
  }
}
