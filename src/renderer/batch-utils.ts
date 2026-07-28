import type { BatchJobResult, ProcessedFileResult } from '../core/shared/types';

export function getParentFolder(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]+$/, '');
}

export function summarizeBatchResults(results: ProcessedFileResult[]): BatchJobResult {
  let totalOriginalBytes = 0;
  let totalOutputBytes = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let cancelledCount = 0;

  for (const result of results) {
    totalOriginalBytes += result.originalSize;
    if (result.success) {
      totalOutputBytes += result.outputSize;
      successCount++;
    } else if (result.skipped) {
      skippedCount++;
      if (result.cancelled) {
        cancelledCount++;
      }
    } else {
      failureCount++;
    }
  }

  return {
    results,
    totalOriginalBytes,
    totalOutputBytes,
    totalSavedBytes: totalOriginalBytes - totalOutputBytes,
    successCount,
    failureCount,
    skippedCount,
    cancelledCount,
  };
}

export function mergeBatchResults(previous: BatchJobResult, retried: BatchJobResult): BatchJobResult {
  const bySourcePath = new Map<string, ProcessedFileResult>();
  for (const result of previous.results) {
    bySourcePath.set(result.sourcePath, result);
  }
  for (const result of retried.results) {
    bySourcePath.set(result.sourcePath, result);
  }
  return summarizeBatchResults(Array.from(bySourcePath.values()));
}

export function buildErrorLog(result: BatchJobResult): string {
  const lines: string[] = [];
  lines.push('Image Puma Error Log');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Processed: ${result.successCount}`);
  lines.push(`Failed: ${result.failureCount}`);
  lines.push(`Skipped: ${result.skippedCount}`);
  lines.push(`Cancelled: ${result.cancelledCount}`);
  lines.push('');

  const failures = result.results.filter((item) => !item.success && !item.skipped);
  if (failures.length === 0) {
    lines.push('No failures recorded.');
    return lines.join('\n');
  }

  lines.push('Failed Files:');
  for (const failure of failures) {
    lines.push(`- ${failure.sourcePath}`);
    lines.push(`  Error: ${failure.error || 'Unknown error'}`);
  }
  return lines.join('\n');
}
