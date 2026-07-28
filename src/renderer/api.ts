import type {
  InputScanResult,
  InputScanProgress,
  AppPreset,
  InputFile,
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
} from '../core/shared/types';

export interface ElectronAPI {
  chooseSources(): Promise<string[]>;
  chooseFiles(): Promise<string[]>;
  chooseFolder(): Promise<string | null>;
  scanInputs(paths: string[], scanId?: string): Promise<InputScanResult>;
  cancelScan(scanId: string): Promise<void>;
  loadPresets(): Promise<AppPreset[]>;
  savePreset(preset: AppPreset): Promise<AppPreset[]>;
  deletePreset(presetId: string): Promise<AppPreset[]>;
  generatePreview(file: InputFile, preset: AppPreset): Promise<PreviewResult>;
  generateThumbnail(filePath: string): Promise<string>;
  planBatch(request: BatchOutputPlanRequest): Promise<BatchOutputPlanResponse>;
  runBatch(request: DesktopBatchJobRequest): Promise<BatchJobResult>;
  cancelBatch(): Promise<void>;
  openFolder(folderPath: string): Promise<string>;
  openRmbgModelPage(): Promise<void>;
  exportErrorLog(payload: { content: string; defaultFileName?: string }): Promise<string | null>;
  dropFiles(paths: string[], scanId?: string): Promise<InputScanResult>;
  getPathForFile(file: File): string;
  saveSession(data: SessionData): Promise<void>;
  loadSession(): Promise<SessionData | null>;
  checkBackgroundRemover(): Promise<BackgroundRemoverStatus>;
  runBackgroundRemoval(request: BackgroundRemovalJobRequest): Promise<BackgroundRemovalJobResult>;
  cancelBackgroundRemoval(): Promise<void>;
  generateFaviconBundle(request: FaviconBundleRequest): Promise<FaviconBundleResult>;
  onBatchProgress(callback: (progress: BatchProgressUpdate) => void): () => void;
  onScanProgress(callback: (progress: InputScanProgress) => void): () => void;
  onBackgroundRemovalProgress(callback: (progress: BackgroundRemovalProgressUpdate) => void): () => void;
}

// Access the electron API exposed by the preload script
export const api: ElectronAPI = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
