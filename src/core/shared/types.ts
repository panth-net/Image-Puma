/* ── Shared types for Image Puma Desktop ── */

// ── Format ───────────────────────────────────────────────
export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'tiff' | 'ico' | 'icns' | 'keep-original';

// ── Resize ───────────────────────────────────────────────
export type ResizeMode = 'none' | 'width' | 'height' | 'fit-box' | 'exact' | 'percent';

export interface ResizeSettings {
  mode: ResizeMode;
  width?: number;
  height?: number;
  percent?: number;
  noUpscale: boolean;
  responsiveWidths: number[]; // additional width variants (e.g. [320, 640, 1200])
}

// ── Crop ─────────────────────────────────────────────────
export type CropAspectAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type CropPositionMode = 'xy' | 'anchor';

export interface CropSettings {
  enabled: boolean;
  x: number; // percent 0-100
  y: number; // percent 0-100
  width: number; // percent 1-100
  height: number; // percent 1-100
  aspectRatio: string | null; // null or "16:9"
  aspectAnchor: CropAspectAnchor;
  positionMode: CropPositionMode;
  anchorInsideImage?: boolean;
}

// ── Transform ────────────────────────────────────────────
export interface TransformSettings {
  rotation: number; // degrees, -180 to 180
  flipH: boolean;
  flipV: boolean;
}

// ── Metadata ─────────────────────────────────────────────
export type MetadataMode =
  | 'strip-all'
  | 'keep-all'
  | 'keep-exif'
  | 'keep-icc'
  | 'keep-xmp'
  | 'strip-privacy-smart'
  | 'strip-gps-only';

export type SyntheticImageMode = 'off' | 'process';
export type MetadataRewriteMode =
  | 'off'
  | 'timestamp-jitter'
  | 'creator'
  | 'timestamp-jitter-and-creator';

export interface MetadataSettings {
  mode: MetadataMode;
  convertToSrgb: boolean;
  syntheticMode?: SyntheticImageMode;
  rewriteMode?: MetadataRewriteMode;
  creatorName?: string;
}

// ── Output / Compression ────────────────────────────────
export interface OutputSettings {
  format: OutputFormat;
  jpegQuality: number;  // 1-100
  pngCompressionLevel: number; // 0-9
  webpQuality: number;  // 1-100
  avifQuality: number;  // 1-100
  lossless: boolean;
}

// ── Naming ───────────────────────────────────────────────
export interface NamingSettings {
  keepOriginal: boolean;
  sanitizeAiTerms: boolean;
  prefix: string;
  suffix: string;
  findText: string;
  replaceText: string;
  sequential: boolean;
  sequentialStart: number;
  template: string; // e.g. '{name}-{width}w'
}

// ── Export ────────────────────────────────────────────────
export interface ExportSettings {
  destination: 'sibling' | 'custom';
  customPath: string;
  siblingFolderName: string; // e.g. "optimized"
  overwrite: boolean;
  openFolderWhenDone: boolean;
}

// ── Background removal ──────────────────────────────────
export interface BackgroundRemovalRecipeSettings {
  enabled: boolean;
}

// ── Preset ───────────────────────────────────────────────
export interface AppPreset {
  id: string;
  name: string;
  description: string;
  output: OutputSettings;
  resize: ResizeSettings;
  crop: CropSettings;
  transform: TransformSettings;
  metadata: MetadataSettings;
  naming: NamingSettings;
  export: ExportSettings;
  backgroundRemoval?: BackgroundRemovalRecipeSettings;
}

// ── Quick favicon / app icon bundle ────────────────────
export interface FaviconBundleRequest {
  sourcePath: string;
  outputDirectory: string;
  folderName?: string;
  crop?: {
    /** Freeform crop bounds within the source image, expressed as percentages. */
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface FaviconBundleFile {
  fileName: string;
  outputPath: string;
  purpose: string;
  size?: string;
}

export interface FaviconBundleResult {
  sourcePath: string;
  outputDirectory: string;
  files: FaviconBundleFile[];
}

// ── Input file ───────────────────────────────────────────
export interface InputFile {
  sourcePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  fileSize: number;
  width?: number;
  height?: number;
  format?: string;
}

export type SkippedInputReason =
  | 'unsupported-type'
  | 'unreadable'
  | 'duplicate'
  | 'symlink'
  | 'not-file-or-directory'
  | 'empty-folder'
  | 'cancelled';

export interface SkippedInput {
  path: string;
  reason: SkippedInputReason;
  message: string;
}

export interface InputScanResult {
  files: InputFile[];
  skipped: SkippedInput[];
  totalSize: number;
  cancelled?: boolean;
}

export interface InputScanProgress {
  scanId: string;
  checkedCount: number;
  acceptedCount: number;
  skippedCount: number;
  currentPath?: string;
  done: boolean;
  cancelled: boolean;
}

// ── Preview ──────────────────────────────────────────────
export interface PreviewResult {
  dataUrl: string;
  originalDataUrl: string;
  outputWidth: number;
  outputHeight: number;
  outputFormat: string;
  outputSize: number;
  originalWidth: number;
  originalHeight: number;
  originalSize: number;
  warnings: string[];
  cropBaseDataUrl?: string;
  cropBaseWidth?: number;
  cropBaseHeight?: number;
  compareBaseDataUrl?: string;
  compareBaseWidth?: number;
  compareBaseHeight?: number;
}

// ── Batch ────────────────────────────────────────────────
export interface BatchJobRequest {
  files: InputFile[];
  preset: AppPreset;
  plan?: BatchOutputPlan;
}

export interface DesktopBatchJobRequest {
  files: InputFile[];
  preset: AppPreset;
  planId?: string;
}

export interface BatchOutputPlanRequest {
  files: InputFile[];
  preset: AppPreset;
}

export type BatchOutputPlanIssueLevel = 'error' | 'warning';

export interface BatchOutputPlanIssue {
  level: BatchOutputPlanIssueLevel;
  code: string;
  message: string;
  sourcePath?: string;
  section?: 'sources' | 'compression' | 'resize' | 'metadata' | 'naming' | 'backgroundRemoval' | 'export';
  targetPath?: string;
}

export interface PlannedOutputVariant {
  outputPath: string;
  baseOutputPath: string;
  format: string;
  width?: number;
  height?: number;
  collision: 'none' | 'renamed' | 'overwrite';
  preset: AppPreset;
}

export interface PlannedOutputEntry {
  sourcePath: string;
  fileName: string;
  sourceSize: number;
  outputFolder: string;
  variants: PlannedOutputVariant[];
  issues: BatchOutputPlanIssue[];
}

export interface BatchOutputPlan {
  preset: AppPreset;
  entries: PlannedOutputEntry[];
  issues: BatchOutputPlanIssue[];
  summary: {
    sourceCount: number;
    outputCount: number;
    errorCount: number;
    warningCount: number;
    destinationFolders: string[];
  };
}

export interface BatchOutputPlanResponse {
  planId: string;
  plan: BatchOutputPlan;
  expiresAt: string;
}

export interface ProcessedFileResult {
  sourcePath: string;
  outputPath: string;
  originalSize: number;
  outputSize: number;
  success: boolean;
  error?: string;
  warnings?: string[];
  skipped?: boolean;
  cancelled?: boolean;
  startedAt?: string;
  completedAt?: string;
  generatedOutputs?: Array<{
    outputPath: string;
    outputSize: number;
    width?: number;
    height?: number;
  }>;
}

export interface BatchJobResult {
  results: ProcessedFileResult[];
  totalOriginalBytes: number;
  totalOutputBytes: number;
  totalSavedBytes: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  cancelledCount: number;
}

// ── Batch progress (sent via IPC events) ─────────────────
export type BatchProgressStatus = 'running' | 'stopping' | 'completed' | 'cancelled';

export interface BatchProgressUpdate {
  completedCount: number;
  totalCount: number;
  currentFile: string;
  status?: BatchProgressStatus;
  startedCount?: number;
  activeFiles?: string[];
  result?: ProcessedFileResult;
}

// ── Background removal ──────────────────────────────────
export type BackgroundRemovalDestination = 'sibling' | 'custom';
export type BackgroundRemovalOutputFormat = 'png' | 'webp' | 'both';

export interface BackgroundRemovalInputFile extends InputFile {
  outputPath?: string;
  outputFormat?: 'png' | 'webp';
}

export interface BackgroundRemovalSettings {
  destination: BackgroundRemovalDestination;
  customPath: string;
  outputFolderName: string;
  outputFormat: BackgroundRemovalOutputFormat;
  maxWidth?: number;
  maxHeight?: number;
  webpQuality: number;
  overwrite: boolean;
}

export interface BackgroundRemovalJobRequest {
  files: BackgroundRemovalInputFile[];
  settings: BackgroundRemovalSettings;
}

export interface BackgroundRemovalJobResult {
  results: ProcessedFileResult[];
  totalOriginalBytes: number;
  totalOutputBytes: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  cancelledCount: number;
  outputFolders: string[];
  cancelled?: boolean;
}

export type BackgroundRemovalProgressStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'cancelled';

export interface BackgroundRemovalProgressUpdate {
  completedCount: number;
  totalCount: number;
  currentFile: string;
  status: BackgroundRemovalProgressStatus;
  startedCount?: number;
  activeFiles?: string[];
  result?: ProcessedFileResult;
}

export interface BackgroundRemoverStatus {
  available: boolean;
  runtimePath?: string;
  modelPath?: string;
  repoPath?: string;
  pythonPath?: string;
  runnerPath?: string;
  message: string;
  details: string[];
}

// ── Session ─────────────────────────────────────────────
export interface SessionData {
  files: InputFile[];
  activePreset: AppPreset;
  selectedFileIndex: number;
  batchResult?: BatchJobResult | null;
  unavailableSourceCount?: number;
  savedAt?: string;
}
