import type { BatchProgressStatus, BatchProgressUpdate, ProcessedFileResult } from '../shared/types';

export interface BatchProgressTracker {
  readonly totalCount: number;
  readonly completedCount: number;
  readonly startedCount: number;
  readonly activeFiles: string[];
  markStarted: (sourcePath: string, currentFile: string, status?: BatchProgressStatus) => BatchProgressUpdate;
  markCompleted: (
    sourcePath: string,
    currentFile: string,
    result: ProcessedFileResult,
    status?: BatchProgressStatus,
  ) => BatchProgressUpdate;
  snapshot: (currentFile: string, status?: BatchProgressStatus) => BatchProgressUpdate;
}

export function createBatchProgressTracker(totalCount: number): BatchProgressTracker {
  let completedCount = 0;
  let startedCount = 0;
  const activeFiles = new Set<string>();

  const buildUpdate = (
    currentFile: string,
    status: BatchProgressStatus = 'running',
    result?: ProcessedFileResult,
  ): BatchProgressUpdate => ({
    completedCount,
    totalCount,
    currentFile,
    status,
    startedCount,
    activeFiles: Array.from(activeFiles),
    result,
  });

  return {
    totalCount,
    get completedCount() {
      return completedCount;
    },
    get startedCount() {
      return startedCount;
    },
    get activeFiles() {
      return Array.from(activeFiles);
    },
    markStarted(
      sourcePath: string,
      currentFile: string,
      status: BatchProgressStatus = 'running',
    ): BatchProgressUpdate {
      startedCount += 1;
      activeFiles.add(sourcePath);
      return buildUpdate(currentFile, status);
    },
    markCompleted(
      sourcePath: string,
      currentFile: string,
      result: ProcessedFileResult,
      status: BatchProgressStatus = 'running',
    ): BatchProgressUpdate {
      activeFiles.delete(sourcePath);
      completedCount += 1;
      return buildUpdate(currentFile, status, result);
    },
    snapshot(currentFile: string, status: BatchProgressStatus = 'running'): BatchProgressUpdate {
      return buildUpdate(currentFile, status);
    },
  };
}
