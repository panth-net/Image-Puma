import type { AppPreset, BatchJobResult, BatchOutputPlanIssue, ProcessedFileResult } from '../core/shared/types';
import type { McpFileSummary, McpPlanResult, McpPlannedOutput, McpRunResult } from './types';

export interface McpPlanJobSummary {
  presetId: string;
  format: string;
  quality?: number;
  pngCompression?: number;
  lossless: boolean;
  resize: string;
}

export function summarizeResize(resize: AppPreset['resize']): string {
  if (resize.mode === 'none') return 'none';
  if (resize.mode === 'percent') return `percent ${resize.percent ?? ''}`;
  if (resize.mode === 'width') return `width ${resize.width ?? ''}`;
  if (resize.mode === 'height') return `height ${resize.height ?? ''}`;
  if (resize.mode === 'fit-box') return `fit-box ${resize.width ?? ''}x${resize.height ?? ''}`;
  if (resize.mode === 'exact') return `exact ${resize.width ?? ''}x${resize.height ?? ''}`;
  return resize.mode;
}

export function summarizeJob(preset: AppPreset): McpPlanJobSummary {
  const format = preset.output.format;
  const job: McpPlanJobSummary = {
    presetId: preset.id,
    format,
    lossless: preset.output.lossless,
    resize: summarizeResize(preset.resize),
  };
  if (format === 'png') {
    job.pngCompression = preset.output.pngCompressionLevel;
  } else if (format === 'avif') {
    job.quality = preset.output.avifQuality;
  } else if (format === 'webp') {
    job.quality = preset.output.webpQuality;
  } else {
    job.quality = preset.output.jpegQuality;
  }
  return job;
}

function slimIssue(issue: BatchOutputPlanIssue): Record<string, unknown> {
  return {
    level: issue.level,
    code: issue.code,
    message: issue.message,
    ...(issue.sourcePath ? { sourcePath: issue.sourcePath } : {}),
  };
}

function slimAcceptedFile(file: McpFileSummary): Record<string, unknown> {
  return {
    sourcePath: file.sourcePath,
    fileName: file.fileName,
    fileSize: file.fileSize,
    ...(file.width !== undefined ? { width: file.width } : {}),
    ...(file.height !== undefined ? { height: file.height } : {}),
    ...(file.format ? { format: file.format } : {}),
  };
}

function slimPlannedOutput(output: McpPlannedOutput): Record<string, unknown> {
  return {
    sourcePath: output.sourcePath,
    outputPath: output.outputPath,
    format: output.format,
    collision: output.collision,
  };
}

export function summarizePlanResult(result: McpPlanResult): Record<string, unknown> {
  return {
    planId: result.planId,
    expiresAt: result.expiresAt,
    job: summarizeJob(result.effectiveSettings),
    acceptedFiles: result.acceptedFiles.map(slimAcceptedFile),
    skippedFiles: result.skippedFiles,
    plannedOutputs: result.plannedOutputs.map(slimPlannedOutput),
    warnings: result.warnings.map(slimIssue),
    errors: result.errors.map(slimIssue),
    requiresConfirmation: result.requiresConfirmation,
  };
}

export function planResultText(result: McpPlanResult): string {
  const job = summarizeJob(result.effectiveSettings);
  const quality = job.quality !== undefined ? ` q${job.quality}` : '';
  const lossless = job.lossless ? ' lossless' : '';
  return `Plan ${result.planId}: ${result.acceptedFiles.length} file(s) → ${job.format}${quality}${lossless}, resize ${job.resize}. ${result.plannedOutputs.length} output(s), ${result.warnings.length} warning(s), ${result.errors.length} error(s). Confirm before image_puma_run.`;
}

function slimProcessedFile(file: ProcessedFileResult): Record<string, unknown> {
  return {
    outputPath: file.outputPath,
    success: file.success,
    originalSize: file.originalSize,
    outputSize: file.outputSize,
    ...(file.error ? { error: file.error } : {}),
  };
}

export function summarizeRunResult(result: McpRunResult): Record<string, unknown> {
  const batch: BatchJobResult = result.result;
  return {
    planId: result.planId,
    result: {
      successCount: batch.successCount,
      failureCount: batch.failureCount,
      skippedCount: batch.skippedCount,
      cancelledCount: batch.cancelledCount,
      totalOriginalBytes: batch.totalOriginalBytes,
      totalOutputBytes: batch.totalOutputBytes,
      totalSavedBytes: batch.totalSavedBytes,
      results: batch.results.map(slimProcessedFile),
    },
    outputFolders: result.outputFolders,
  };
}

export function runResultText(result: McpRunResult): string {
  const batch = result.result;
  return `Run ${result.planId}: ${batch.successCount} succeeded, ${batch.failureCount} failed, ${batch.skippedCount} skipped.`;
}
