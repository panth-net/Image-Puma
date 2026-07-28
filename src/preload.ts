import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { Channels } from './shared/channels';
import type {
  InputFile,
  InputScanProgress,
  InputScanResult,
  AppPreset,
  PreviewResult,
  DesktopBatchJobRequest,
  BatchOutputPlanRequest,
  BatchOutputPlanResponse,
  BatchJobResult,
  BatchProgressUpdate,
  BackgroundRemovalJobRequest,
  BackgroundRemovalJobResult,
  BackgroundRemovalProgressUpdate,
  BackgroundRemoverStatus,
  SessionData,
  FaviconBundleRequest,
  FaviconBundleResult,
} from './core/shared/types';

const api = {
  chooseSources: (): Promise<string[]> =>
    ipcRenderer.invoke(Channels.CHOOSE_SOURCES),

  chooseFiles: (): Promise<string[]> =>
    ipcRenderer.invoke(Channels.CHOOSE_FILES),

  chooseFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(Channels.CHOOSE_FOLDER),

  scanInputs: (paths: string[], scanId?: string): Promise<InputScanResult> =>
    ipcRenderer.invoke(Channels.SCAN_INPUTS, paths, scanId),

  cancelScan: (scanId: string): Promise<void> =>
    ipcRenderer.invoke(Channels.CANCEL_SCAN, scanId),

  loadPresets: (): Promise<AppPreset[]> =>
    ipcRenderer.invoke(Channels.LOAD_PRESETS),

  savePreset: (preset: AppPreset): Promise<AppPreset[]> =>
    ipcRenderer.invoke(Channels.SAVE_PRESET, preset),

  deletePreset: (presetId: string): Promise<AppPreset[]> =>
    ipcRenderer.invoke(Channels.DELETE_PRESET, presetId),

  generatePreview: (
    file: InputFile,
    preset: AppPreset,
  ): Promise<PreviewResult> =>
    ipcRenderer.invoke(Channels.GENERATE_PREVIEW, file, preset),

  generateThumbnail: (filePath: string): Promise<string> =>
    ipcRenderer.invoke(Channels.GENERATE_THUMBNAIL, filePath),

  planBatch: (request: BatchOutputPlanRequest): Promise<BatchOutputPlanResponse> =>
    ipcRenderer.invoke(Channels.PLAN_BATCH, request),

  runBatch: (request: DesktopBatchJobRequest): Promise<BatchJobResult> =>
    ipcRenderer.invoke(Channels.RUN_BATCH, request),

  cancelBatch: (): Promise<void> =>
    ipcRenderer.invoke(Channels.CANCEL_BATCH),

  openFolder: (folderPath: string): Promise<string> =>
    ipcRenderer.invoke(Channels.OPEN_FOLDER, folderPath),

  openRmbgModelPage: (): Promise<void> =>
    ipcRenderer.invoke(Channels.OPEN_RMBG_MODEL_PAGE),

  exportErrorLog: (payload: { content: string; defaultFileName?: string }): Promise<string | null> =>
    ipcRenderer.invoke(Channels.EXPORT_ERROR_LOG, payload),

  dropFiles: (paths: string[], scanId?: string): Promise<InputScanResult> =>
    ipcRenderer.invoke(Channels.DROP_FILES, paths, scanId),

  getPathForFile: (file: File): string =>
    webUtils.getPathForFile(file),

  saveSession: (data: SessionData): Promise<void> =>
    ipcRenderer.invoke(Channels.SESSION_SAVE, data),

  loadSession: (): Promise<SessionData | null> =>
    ipcRenderer.invoke(Channels.SESSION_LOAD),

  checkBackgroundRemover: (): Promise<BackgroundRemoverStatus> =>
    ipcRenderer.invoke(Channels.BACKGROUND_REMOVER_STATUS),

  runBackgroundRemoval: (request: BackgroundRemovalJobRequest): Promise<BackgroundRemovalJobResult> =>
    ipcRenderer.invoke(Channels.RUN_BACKGROUND_REMOVAL, request),

  cancelBackgroundRemoval: (): Promise<void> =>
    ipcRenderer.invoke(Channels.CANCEL_BACKGROUND_REMOVAL),

  generateFaviconBundle: (request: FaviconBundleRequest): Promise<FaviconBundleResult> =>
    ipcRenderer.invoke(Channels.GENERATE_FAVICON_BUNDLE, request),

  onBatchProgress: (callback: (progress: BatchProgressUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: BatchProgressUpdate) => {
      callback(progress);
    };
    ipcRenderer.on(Channels.BATCH_PROGRESS, handler);
    return () => {
      ipcRenderer.removeListener(Channels.BATCH_PROGRESS, handler);
    };
  },

  onScanProgress: (callback: (progress: InputScanProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: InputScanProgress) => {
      callback(progress);
    };
    ipcRenderer.on(Channels.SCAN_PROGRESS, handler);
    return () => {
      ipcRenderer.removeListener(Channels.SCAN_PROGRESS, handler);
    };
  },

  onBackgroundRemovalProgress: (callback: (progress: BackgroundRemovalProgressUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: BackgroundRemovalProgressUpdate) => {
      callback(progress);
    };
    ipcRenderer.on(Channels.BACKGROUND_REMOVAL_PROGRESS, handler);
    return () => {
      ipcRenderer.removeListener(Channels.BACKGROUND_REMOVAL_PROGRESS, handler);
    };
  },
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
