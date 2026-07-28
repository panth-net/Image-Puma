import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import * as fs from 'fs/promises';
import { Channels } from '../../shared/channels';
import { scanInputs } from '../../core/files/scan-input';
import { IMAGE_DIALOG_EXTENSIONS } from '../../core/files/supported-image-inputs';
import { defaultPresets } from '../../core/presets/default-presets';
import { loadUserPresets, saveUserPreset, deleteUserPreset } from '../presets/user-presets';
import { generatePreview, generateThumbnail } from '../../core/processing/generate-preview';
import { runBatch, cancelBatch } from '../processing/run-batch';
import {
  cancelBackgroundRemoval,
  getBackgroundRemoverStatus,
  runBackgroundRemoval,
} from '../processing/run-background-removal';
import { planBatchOutputs } from '../../core/files/output-plan';
import { saveSession, loadSession } from '../session/session-store';
import { generateFaviconBundle } from '../../core/processing/generate-favicon-bundle';
import {
  InputFile,
  AppPreset,
  DesktopBatchJobRequest,
  BatchOutputPlanRequest,
  BackgroundRemovalJobRequest,
  SessionData,
  FaviconBundleRequest,
} from '../../core/shared/types';
import { DesktopPlanStore } from '../processing/desktop-plan-store';

const desktopPlanStore = new DesktopPlanStore();
const RMBG_MODEL_PAGE_URL = 'https://huggingface.co/briaai/RMBG-2.0';

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const activeScans = new Map<string, { cancelled: boolean }>();

  const runScan = async (
    sender: WebContents,
    paths: string[],
    scanId?: string,
  ) => {
    const id = scanId || `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = { cancelled: false };
    activeScans.set(id, controller);

    try {
      return await scanInputs(paths, {
        scanId: id,
        shouldCancel: () => controller.cancelled,
        onProgress: (progress) => {
          sender.send(Channels.SCAN_PROGRESS, progress);
        },
      });
    } finally {
      activeScans.delete(id);
    }
  };

  ipcMain.handle(Channels.CHOOSE_SOURCES, async () => {
    const win = getWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: IMAGE_DIALOG_EXTENSIONS },
      ],
    });
    return result.filePaths;
  });

  ipcMain.handle(Channels.CHOOSE_FILES, async () => {
    const win = getWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: IMAGE_DIALOG_EXTENSIONS },
      ],
    });
    return result.filePaths;
  });

  ipcMain.handle(Channels.CHOOSE_FOLDER, async () => {
    const win = getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    });
    return result.filePaths[0] || null;
  });

  ipcMain.handle(Channels.SCAN_INPUTS, async (event, paths: string[], scanId?: string) => {
    return runScan(event.sender, paths, scanId);
  });

  ipcMain.handle(Channels.CANCEL_SCAN, async (_event, scanId: string) => {
    const scan = activeScans.get(scanId);
    if (scan) scan.cancelled = true;
  });

  ipcMain.handle(Channels.LOAD_PRESETS, async () => {
    return [...defaultPresets, ...loadUserPresets()];
  });

  ipcMain.handle(Channels.SAVE_PRESET, async (_event, preset: AppPreset) => {
    const userPresets = saveUserPreset(preset);
    return [...defaultPresets, ...userPresets];
  });

  ipcMain.handle(Channels.DELETE_PRESET, async (_event, presetId: string) => {
    const userPresets = deleteUserPreset(presetId);
    return [...defaultPresets, ...userPresets];
  });

  ipcMain.handle(
    Channels.GENERATE_PREVIEW,
    async (_event, file: InputFile, preset: AppPreset) => {
      return generatePreview(file, preset);
    },
  );

  ipcMain.handle(Channels.GENERATE_THUMBNAIL, async (_event, filePath: string) => {
    return generateThumbnail(filePath);
  });

  ipcMain.handle(Channels.PLAN_BATCH, async (_event, request: BatchOutputPlanRequest) => {
    const plan = await planBatchOutputs(request);
    return desktopPlanStore.create(plan);
  });

  ipcMain.handle(Channels.RUN_BATCH, async (_event, request: DesktopBatchJobRequest) => {
    const win = getWindow();
    if (!request.planId) {
      return runBatch({ files: request.files, preset: request.preset }, win);
    }

    const plan = desktopPlanStore.resolve(request.planId);
    return runBatch({ files: request.files, preset: plan.preset, plan }, win);
  });

  ipcMain.handle(Channels.CANCEL_BATCH, async () => {
    cancelBatch();
  });

  ipcMain.handle(Channels.OPEN_FOLDER, async (_event, folderPath: string) => {
    return shell.openPath(folderPath);
  });

  ipcMain.handle(Channels.OPEN_RMBG_MODEL_PAGE, async () => {
    await shell.openExternal(RMBG_MODEL_PAGE_URL);
  });

  ipcMain.handle(
    Channels.EXPORT_ERROR_LOG,
    async (_event, payload: { content: string; defaultFileName?: string }) => {
      const win = getWindow();
      if (!win) return null;

      const saveResult = await dialog.showSaveDialog(win, {
        title: 'Export Error Log',
        defaultPath: payload.defaultFileName || 'image-puma-error-log.txt',
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });

      if (saveResult.canceled || !saveResult.filePath) return null;

      await fs.writeFile(saveResult.filePath, payload.content, 'utf-8');
      return saveResult.filePath;
    },
  );

  ipcMain.handle(Channels.DROP_FILES, async (event, paths: string[], scanId?: string) => {
    return runScan(event.sender, paths, scanId);
  });

  ipcMain.handle(Channels.SESSION_SAVE, async (_event, data: SessionData) => {
    await saveSession(data);
  });

  ipcMain.handle(Channels.SESSION_LOAD, async () => {
    return loadSession();
  });

  ipcMain.handle(Channels.BACKGROUND_REMOVER_STATUS, async () => {
    return getBackgroundRemoverStatus();
  });

  ipcMain.handle(Channels.RUN_BACKGROUND_REMOVAL, async (_event, request: BackgroundRemovalJobRequest) => {
    const win = getWindow();
    return runBackgroundRemoval(request, win);
  });

  ipcMain.handle(Channels.CANCEL_BACKGROUND_REMOVAL, async () => {
    cancelBackgroundRemoval();
  });

  ipcMain.handle(Channels.GENERATE_FAVICON_BUNDLE, async (_event, request: FaviconBundleRequest) => {
    return generateFaviconBundle(request);
  });
}
