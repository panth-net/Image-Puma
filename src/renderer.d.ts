// Global type declarations for the renderer process.
// We avoid top-level imports here to keep this as a pure ambient declaration.
// Instead we duplicate the API surface with inline types.

interface ElectronAPI {
  chooseSources(): Promise<string[]>;
  chooseFiles(): Promise<string[]>;
  chooseFolder(): Promise<string | null>;
  scanInputs(paths: string[], scanId?: string): Promise<import('./core/shared/types').InputScanResult>;
  cancelScan(scanId: string): Promise<void>;
  loadPresets(): Promise<import('./core/shared/types').AppPreset[]>;
  savePreset(preset: import('./core/shared/types').AppPreset): Promise<import('./core/shared/types').AppPreset[]>;
  deletePreset(presetId: string): Promise<import('./core/shared/types').AppPreset[]>;
  generatePreview(
    file: import('./core/shared/types').InputFile,
    preset: import('./core/shared/types').AppPreset,
  ): Promise<import('./core/shared/types').PreviewResult>;
  generateThumbnail(filePath: string): Promise<string>;
  planBatch(request: import('./core/shared/types').BatchOutputPlanRequest): Promise<import('./core/shared/types').BatchOutputPlanResponse>;
  runBatch(request: import('./core/shared/types').DesktopBatchJobRequest): Promise<import('./core/shared/types').BatchJobResult>;
  cancelBatch(): Promise<void>;
  openFolder(folderPath: string): Promise<string>;
  exportErrorLog(payload: { content: string; defaultFileName?: string }): Promise<string | null>;
  dropFiles(paths: string[], scanId?: string): Promise<import('./core/shared/types').InputScanResult>;
  getPathForFile(file: File): string;
  saveSession(data: import('./core/shared/types').SessionData): Promise<void>;
  loadSession(): Promise<import('./core/shared/types').SessionData | null>;
  checkBackgroundRemover(): Promise<import('./core/shared/types').BackgroundRemoverStatus>;
  runBackgroundRemoval(
    request: import('./core/shared/types').BackgroundRemovalJobRequest,
  ): Promise<import('./core/shared/types').BackgroundRemovalJobResult>;
  cancelBackgroundRemoval(): Promise<void>;
  generateFaviconBundle(
    request: import('./core/shared/types').FaviconBundleRequest,
  ): Promise<import('./core/shared/types').FaviconBundleResult>;
  onBatchProgress(callback: (progress: import('./core/shared/types').BatchProgressUpdate) => void): () => void;
  onScanProgress(callback: (progress: import('./core/shared/types').InputScanProgress) => void): () => void;
  onBackgroundRemovalProgress(
    callback: (progress: import('./core/shared/types').BackgroundRemovalProgressUpdate) => void,
  ): () => void;
}

interface Window {
  electronAPI: ElectronAPI;
}
