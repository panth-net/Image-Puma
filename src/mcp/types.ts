import type {
  AppPreset,
  BatchJobResult,
  BatchOutputPlan,
  BatchOutputPlanIssue,
  BatchProgressUpdate,
  InputFile,
  InputScanProgress,
  SkippedInput,
  FaviconBundleResult,
} from '../core/shared/types';

export type McpPlanErrorCode =
  | 'BACKGROUND_REMOVAL_UNAVAILABLE'
  | 'CONFIRMATION_REQUIRED'
  | 'INPUT_LIMIT_EXCEEDED'
  | 'INVALID_ARGUMENT'
  | 'OUTPUT_CHANGED'
  | 'PATH_NOT_ALLOWED'
  | 'PLAN_EXPIRED'
  | 'PLAN_HAS_ERRORS'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_STALE'
  | 'PLAN_CANCELLED'
  | 'PLAN_WARNINGS_NOT_ACCEPTED'
  | 'PRESET_NOT_FOUND'
  | 'SETTINGS_INVALID';

export class ImagePumaMcpError extends Error {
  readonly code: McpPlanErrorCode;
  readonly details?: unknown;

  constructor(code: McpPlanErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ImagePumaMcpError';
    this.code = code;
    this.details = details;
  }
}

export interface McpServerLimits {
  maxFiles: number;
  maxTotalInputBytes: number;
  maxMegapixelsPerFile: number;
  maxConcurrentFiles: number;
  hashSmallFileBytes: number;
  processingTimeoutSeconds: number;
}

export interface McpPlanInput {
  inputs: string[];
  presetId?: string;
  customSettings?: unknown;
  outputDir?: string;
  recursive?: boolean;
  allowOverwrite?: boolean;
}

export interface McpRunInput {
  planId: string;
  confirmed: true;
  acceptWarnings?: boolean;
}

export interface McpFaviconInput {
  sourcePath: string;
  outputDir: string;
  folderName?: string;
  confirmed: true;
}

export type McpFaviconResult = FaviconBundleResult;

export interface McpFileSummary {
  sourcePath: string;
  relativePath: string;
  fileName: string;
  fileSize: number;
  width?: number;
  height?: number;
  format?: string;
}

export interface McpPlannedOutput {
  sourcePath: string;
  outputPath: string;
  baseOutputPath: string;
  format: string;
  width?: number;
  height?: number;
  collision: 'none' | 'renamed' | 'overwrite';
}

export interface McpPlanResult {
  planId: string;
  expiresAt: string;
  effectiveSettings: AppPreset;
  acceptedFiles: McpFileSummary[];
  skippedFiles: SkippedInput[];
  plannedOutputs: McpPlannedOutput[];
  warnings: BatchOutputPlanIssue[];
  errors: BatchOutputPlanIssue[];
  requiresConfirmation: boolean;
  limits: McpServerLimits;
}

export interface McpRunResult {
  planId: string;
  result: BatchJobResult;
  outputFolders: string[];
}

export interface McpPresetSummary {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
}

export interface McpUnavailablePresetSummary extends McpPresetSummary {
  unavailableReason: string;
}

export interface McpListPresetsResult {
  presets: McpPresetSummary[];
  unavailablePresets: McpUnavailablePresetSummary[];
}

export interface McpDescribePresetInput {
  presetId: string;
}

export interface McpDescribePresetResult {
  preset: AppPreset;
  builtIn: boolean;
}

export interface InputIdentity {
  sourcePath: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
}

export interface StoredMcpPlan {
  planId: string;
  createdAt: number;
  expiresAt: number;
  settingsHash: string;
  allowOverwrite: boolean;
  files: InputFile[];
  identities: InputIdentity[];
  preset: AppPreset;
  plan: BatchOutputPlan;
  skippedFiles: SkippedInput[];
  limits: McpServerLimits;
  allowedRoots: Array<{
    inputPath: string;
    realPath: string;
  }>;
}

export interface McpProgressContext {
  signal?: AbortSignal;
  onProgress?: (progress: BatchProgressUpdate) => void | Promise<void>;
}

export interface McpPlanContext {
  signal?: AbortSignal;
  allowedDirs?: string[];
  onScanProgress?: (progress: InputScanProgress) => void | Promise<void>;
}
