import { BrowserWindow } from 'electron';
import type { BatchJobRequest, BatchJobResult, BatchProgressUpdate } from '../../core/shared/types';
import { Channels } from '../../shared/channels';
import { runBatchCore } from '../../core/processing/run-batch';
import {
  cancelBackgroundRemoval,
  getBackgroundRemoverStatus,
  runBackgroundRemoval,
} from './run-background-removal';

let activeBatch: { controller: AbortController } | null = null;

function emitProgress(window: BrowserWindow | null, progress: BatchProgressUpdate): void {
  if (!window || window.isDestroyed()) return;

  const progressFraction = progress.totalCount > 0
    ? progress.completedCount / progress.totalCount
    : -1;
  window.setProgressBar(progress.status === 'completed' || progress.status === 'cancelled' ? -1 : progressFraction);
  if (progress.status === 'stopping') {
    window.setTitle(`Image Puma - Stopping ${progress.completedCount}/${progress.totalCount}`);
  } else if (progress.status === 'running') {
    window.setTitle(`Image Puma - Processing ${progress.completedCount}/${progress.totalCount}`);
  }
  window.webContents.send(Channels.BATCH_PROGRESS, progress);
}

function resetWindowProgress(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  window.setProgressBar(-1);
  window.setTitle('Image Puma');
}

export function cancelBatch(): void {
  activeBatch?.controller.abort();
  cancelBackgroundRemoval();
}

export async function runBatch(
  request: BatchJobRequest,
  window: BrowserWindow | null,
): Promise<BatchJobResult> {
  if (activeBatch) {
    throw new Error('A batch is already running.');
  }

  const controller = new AbortController();
  activeBatch = { controller };

  try {
    return await runBatchCore(request, {
      signal: controller.signal,
      onProgress: (progress) => emitProgress(window, progress),
      backgroundRemoval: {
        assertAvailable: () => {
          const status = getBackgroundRemoverStatus();
          if (!status.available) {
            throw new Error(status.message);
          }
        },
        run: async (backgroundRequest) => {
          const result = await runBackgroundRemoval(backgroundRequest, null);
          return result.results;
        },
      },
    });
  } finally {
    if (activeBatch?.controller === controller) {
      activeBatch = null;
    }
    resetWindowProgress(window);
  }
}
