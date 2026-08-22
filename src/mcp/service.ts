import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  createJsonFilePresetStore,
  createUserPresetRepository,
  type UserPresetRepository,
} from '../core/presets/user-presets';
import { defaultPresets } from '../core/presets/default-presets';
import { scanInputs } from '../core/files/scan-input';
import { planBatchOutputs } from '../core/files/output-plan';
import { isBackgroundRemovalEnabled } from '../core/shared/background-removal-settings';
import { runBatchCore } from '../core/processing/run-batch';
import { generateFaviconBundle } from '../core/processing/generate-favicon-bundle';
import type { AppPreset, BatchOutputPlanIssue, InputFile } from '../core/shared/types';
import { applyCustomSettings, applyQualityJob, IMAGE_PUMA_SETTINGS_SCHEMA, OUTPUT_FORMATS } from './settings-schema';
import { InMemoryMcpPlanStore } from './plan-store';
import type {
  InputIdentity,
  McpDescribePresetInput,
  McpDescribePresetResult,
  McpFileSummary,
  McpListPresetsResult,
  McpPlanInput,
  McpPlanContext,
  McpPlannedOutput,
  McpProgressContext,
  McpRunInput,
  McpRunResult,
  McpFaviconInput,
  McpFaviconResult,
  McpServerLimits,
  StoredMcpPlan,
} from './types';
import { ImagePumaMcpError } from './types';
import {
  type AllowedRoot,
  assertAllowedRootsConfigured,
  canonicalizeExistingDirectory,
  canonicalizeOutputPath,
  normalizeScannedFiles,
  realpathForExistingPath,
  resolveAllowedRoots,
  resolveConfiguredAndDefaultAllowedRoots,
} from './path-policy';

export const DEFAULT_MCP_LIMITS: McpServerLimits = {
  maxFiles: 500,
  maxTotalInputBytes: 5 * 1024 * 1024 * 1024,
  maxMegapixelsPerFile: 100,
  maxConcurrentFiles: 8,
  hashSmallFileBytes: 256 * 1024,
  processingTimeoutSeconds: 120,
};

export interface ImagePumaMcpServiceOptions {
  allowedDirs?: string[];
  /** Merge cwd plus Pictures/Downloads/Documents/Desktop when those folders exist. */
  includeDefaultDirs?: boolean;
  presetRepository?: UserPresetRepository;
  presetFilePath?: string;
  planStore?: InMemoryMcpPlanStore;
  limits?: Partial<McpServerLimits>;
}

interface PresetWithOrigin {
  preset: AppPreset;
  builtIn: boolean;
}

function issue(
  level: BatchOutputPlanIssue['level'],
  code: string,
  message: string,
  details: Partial<BatchOutputPlanIssue> = {},
): BatchOutputPlanIssue {
  return { level, code, message, ...details };
}

function clonePreset(preset: AppPreset): AppPreset {
  return {
    ...preset,
    output: { ...preset.output },
    resize: {
      ...preset.resize,
      responsiveWidths: Array.isArray(preset.resize.responsiveWidths)
        ? [...preset.resize.responsiveWidths]
        : [],
    },
    crop: { ...preset.crop },
    transform: { ...preset.transform },
    metadata: { ...preset.metadata },
    naming: { ...preset.naming },
    export: { ...preset.export },
    backgroundRemoval: preset.backgroundRemoval ? { ...preset.backgroundRemoval } : undefined,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function fileSummary(file: InputFile): McpFileSummary {
  return {
    sourcePath: file.sourcePath,
    relativePath: file.relativePath,
    fileName: `${file.fileName}${file.extension}`,
    fileSize: file.fileSize,
    width: file.width,
    height: file.height,
    format: file.format,
  };
}

function plannedOutputs(plan: StoredMcpPlan['plan']): McpPlannedOutput[] {
  return plan.entries.flatMap((entry) => entry.variants.map((variant) => ({
    sourcePath: entry.sourcePath,
    outputPath: variant.outputPath,
    baseOutputPath: variant.baseOutputPath,
    format: variant.format,
    width: variant.width,
    height: variant.height,
    collision: variant.collision,
  })));
}

async function hashSmallFile(filePath: string, size: number, maxBytes: number): Promise<string | undefined> {
  if (size > maxBytes) return undefined;
  const data = await fs.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

export async function createInputIdentity(file: InputFile, maxHashBytes: number): Promise<InputIdentity> {
  const stat = await fs.lstat(file.sourcePath);
  if (stat.isSymbolicLink()) {
    throw new ImagePumaMcpError('PLAN_STALE', `Source became a symbolic link: ${file.sourcePath}`, {
      sourcePath: file.sourcePath,
    });
  }
  if (!stat.isFile()) {
    throw new ImagePumaMcpError('PLAN_STALE', `Source is no longer a file: ${file.sourcePath}`, {
      sourcePath: file.sourcePath,
    });
  }

  const realPath = await fs.realpath(file.sourcePath);
  return {
    sourcePath: file.sourcePath,
    realPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: await hashSmallFile(realPath, stat.size, maxHashBytes),
  };
}

function hasUnavailableCapabilities(preset: AppPreset): boolean {
  return isBackgroundRemovalEnabled(preset);
}

function validatePlanInput(input: McpPlanInput): void {
  if (!input || typeof input !== 'object') {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'Plan input must be an object.');
  }
  if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'image_puma_plan needs at least one input path.');
  }
  const invalid = input.inputs.find((item) => typeof item !== 'string' || item.trim().length === 0);
  if (invalid !== undefined) {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'Every input path must be a non-empty string.');
  }
  if (input.quality !== undefined) {
    if (typeof input.quality !== 'number' || !Number.isInteger(input.quality) || input.quality < 1 || input.quality > 100) {
      throw new ImagePumaMcpError('INVALID_ARGUMENT', 'quality must be an integer from 1 to 100, like ImageMagick -quality.');
    }
  }
  if (input.format !== undefined && !OUTPUT_FORMATS.includes(input.format)) {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', `format must be one of: ${OUTPUT_FORMATS.join(', ')}`);
  }
  if (input.lossless !== undefined && typeof input.lossless !== 'boolean') {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'lossless must be a boolean.');
  }
}

function isQualityJob(input: McpPlanInput): boolean {
  return input.quality !== undefined || input.format !== undefined || input.lossless === true;
}

function namingSanitizeWasSet(customSettings: unknown): boolean {
  if (!customSettings || typeof customSettings !== 'object' || Array.isArray(customSettings)) return false;
  const naming = (customSettings as Record<string, unknown>).naming;
  if (!naming || typeof naming !== 'object' || Array.isArray(naming)) return false;
  return Object.prototype.hasOwnProperty.call(naming, 'sanitizeAiTerms');
}

function validateRunInput(input: McpRunInput): void {
  if (!input || typeof input !== 'object') {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'Run input must be an object.');
  }
  if (typeof input.planId !== 'string' || input.planId.trim().length === 0) {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'image_puma_run needs a planId.');
  }
  if (input.confirmed !== true) {
    throw new ImagePumaMcpError('CONFIRMATION_REQUIRED', 'image_puma_run requires confirmed: true.');
  }
}

function validateFaviconInput(input: McpFaviconInput): void {
  if (!input || typeof input !== 'object') {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'Favicon input must be an object.');
  }
  if (typeof input.sourcePath !== 'string' || input.sourcePath.trim().length === 0) {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'image_puma_generate_favicon needs a sourcePath.');
  }
  if (typeof input.outputDir !== 'string' || input.outputDir.trim().length === 0) {
    throw new ImagePumaMcpError('INVALID_ARGUMENT', 'image_puma_generate_favicon needs an outputDir.');
  }
  if (input.confirmed !== true) {
    throw new ImagePumaMcpError('CONFIRMATION_REQUIRED', 'image_puma_generate_favicon requires confirmed: true.');
  }
}

export class ImagePumaMcpService {
  readonly allowedRoots: AllowedRoot[];
  readonly limits: McpServerLimits;
  readonly planStore: InMemoryMcpPlanStore;
  private readonly presetRepository: UserPresetRepository;

  constructor(options: {
    allowedRoots: AllowedRoot[];
    presetRepository: UserPresetRepository;
    planStore?: InMemoryMcpPlanStore;
    limits?: Partial<McpServerLimits>;
  }) {
    this.allowedRoots = options.allowedRoots;
    this.presetRepository = options.presetRepository;
    this.planStore = options.planStore ?? new InMemoryMcpPlanStore();
    this.limits = { ...DEFAULT_MCP_LIMITS, ...options.limits };
  }

  listPresets(): McpListPresetsResult {
    const presets = this.getAllPresets();
    return {
      presets: presets
        .filter(({ preset }) => !hasUnavailableCapabilities(preset))
        .map(({ preset, builtIn }) => ({
          id: preset.id,
          name: preset.name,
          description: preset.description,
          builtIn,
        })),
      unavailablePresets: presets
        .filter(({ preset }) => hasUnavailableCapabilities(preset))
        .map(({ preset, builtIn }) => ({
          id: preset.id,
          name: preset.name,
          description: preset.description,
          builtIn,
          unavailableReason: 'Background removal is not available in the MCP v1 server.',
        })),
    };
  }

  describePreset(input: McpDescribePresetInput): McpDescribePresetResult {
    const { preset, builtIn } = this.resolvePreset(input.presetId);
    if (hasUnavailableCapabilities(preset)) {
      throw new ImagePumaMcpError(
        'BACKGROUND_REMOVAL_UNAVAILABLE',
        `Preset "${preset.name}" requires background removal, which is not available in the MCP v1 server.`,
      );
    }
    return {
      preset: clonePreset(preset),
      builtIn,
    };
  }

  settingsSchema(): Record<string, unknown> {
    return IMAGE_PUMA_SETTINGS_SCHEMA as unknown as Record<string, unknown>;
  }

  async plan(input: McpPlanInput, context: McpPlanContext = {}): Promise<import('./types').McpPlanResult> {
    validatePlanInput(input);
    this.throwIfPlanCancelled(context.signal);
    const allowedRoots = await this.getEffectiveAllowedRoots(context.allowedDirs);
    assertAllowedRootsConfigured(allowedRoots);

    const basePreset = this.resolvePreset(input.presetId).preset;
    if (hasUnavailableCapabilities(basePreset)) {
      throw new ImagePumaMcpError(
        'BACKGROUND_REMOVAL_UNAVAILABLE',
        `Preset "${basePreset.name}" requires background removal, which is not available in the MCP v1 server.`,
      );
    }

    const extraWarnings: BatchOutputPlanIssue[] = [];
    const allowOverwrite = Boolean(input.allowOverwrite);
    const preset = await this.preparePresetForPlan(basePreset, input, extraWarnings, allowedRoots);
    if (hasUnavailableCapabilities(preset)) {
      throw new ImagePumaMcpError(
        'BACKGROUND_REMOVAL_UNAVAILABLE',
        'Background removal is not available in the MCP v1 server.',
      );
    }

    const inputPaths = await Promise.all(input.inputs.map((item) => realpathForExistingPath(item, allowedRoots)));
    this.throwIfPlanCancelled(context.signal);
    const scan = await scanInputs(inputPaths, {
      scanId: 'mcp-plan',
      recursive: input.recursive !== false,
      shouldCancel: () => Boolean(context.signal?.aborted),
      onProgress: (progress) => {
        Promise.resolve(context.onScanProgress?.(progress)).catch((): undefined => undefined);
      },
    });
    if (scan.cancelled || context.signal?.aborted) {
      throw new ImagePumaMcpError('PLAN_CANCELLED', 'Image Puma plan was cancelled before it was stored.');
    }
    const files = await normalizeScannedFiles(scan.files, allowedRoots);
    this.validateInputLimits(files, scan.totalSize);

    this.throwIfPlanCancelled(context.signal);
    const plan = await planBatchOutputs({ files, preset });
    this.throwIfPlanCancelled(context.signal);
    await this.assertPlannedOutputsAllowed(plan, allowedRoots);
    this.throwIfPlanCancelled(context.signal);
    const identities = await Promise.all(files.map((file) => createInputIdentity(file, this.limits.hashSmallFileBytes)));
    this.throwIfPlanCancelled(context.signal);
    plan.issues.push(...extraWarnings);
    plan.summary.warningCount += extraWarnings.filter((item) => item.level === 'warning').length;
    plan.summary.errorCount += extraWarnings.filter((item) => item.level === 'error').length;

    const stored = this.planStore.create({
      settingsHash: hashJson({
        allowOverwrite,
        allowedRoots,
        identities,
        plan,
        preset,
      }),
      allowOverwrite,
      files,
      identities,
      preset,
      plan,
      skippedFiles: scan.skipped,
      limits: this.limits,
      allowedRoots,
    });

    const warnings = plan.issues.filter((item) => item.level === 'warning');
    const errors = plan.issues.filter((item) => item.level === 'error');

    return {
      planId: stored.planId,
      expiresAt: new Date(stored.expiresAt).toISOString(),
      effectiveSettings: clonePreset(preset),
      acceptedFiles: files.map(fileSummary),
      skippedFiles: scan.skipped,
      plannedOutputs: plannedOutputs(plan),
      warnings,
      errors,
      requiresConfirmation: errors.length === 0 && plan.summary.outputCount > 0,
      limits: this.limits,
    };
  }

  async run(input: McpRunInput, context: McpProgressContext = {}): Promise<McpRunResult> {
    validateRunInput(input);
    const storedPlan = this.planStore.get(input.planId);
    const errors = storedPlan.plan.issues.filter((item) => item.level === 'error');
    const warnings = storedPlan.plan.issues.filter((item) => item.level === 'warning');

    if (errors.length > 0) {
      throw new ImagePumaMcpError('PLAN_HAS_ERRORS', 'This plan has blocking errors and cannot be run.', { errors });
    }
    if (warnings.length > 0 && input.acceptWarnings !== true) {
      throw new ImagePumaMcpError('PLAN_WARNINGS_NOT_ACCEPTED', 'This plan has warnings. Re-run with acceptWarnings: true after review.', {
        warnings,
      });
    }

    await this.assertPlanStillCurrent(storedPlan);
    await this.assertPlannedOutputsRunnable(storedPlan);

    const result = await runBatchCore(
      {
        files: storedPlan.files,
        preset: storedPlan.preset,
        plan: storedPlan.plan,
      },
      {
        signal: context.signal,
        maxConcurrentFiles: storedPlan.limits.maxConcurrentFiles,
        processingLimits: {
          limitInputPixels: Math.floor(storedPlan.limits.maxMegapixelsPerFile * 1_000_000),
          timeoutSeconds: storedPlan.limits.processingTimeoutSeconds,
        },
        onProgress: (progress) => {
          Promise.resolve(context.onProgress?.(progress)).catch((): undefined => undefined);
        },
      },
    );

    return {
      planId: storedPlan.planId,
      result,
      outputFolders: storedPlan.plan.summary.destinationFolders,
    };
  }

  async generateFavicon(
    input: McpFaviconInput,
    context: Pick<McpPlanContext, 'allowedDirs'> = {},
  ): Promise<McpFaviconResult> {
    validateFaviconInput(input);
    const allowedRoots = await this.getEffectiveAllowedRoots(context.allowedDirs);
    assertAllowedRootsConfigured(allowedRoots);
    const sourcePath = await realpathForExistingPath(input.sourcePath, allowedRoots);
    const sourceStat = await fs.lstat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new ImagePumaMcpError('INVALID_ARGUMENT', `Favicon source is not a file: ${sourcePath}`);
    }
    const outputDirectory = await canonicalizeExistingDirectory(input.outputDir, allowedRoots);

    return generateFaviconBundle({
      sourcePath,
      outputDirectory,
      folderName: input.folderName,
    });
  }

  private getAllPresets(): PresetWithOrigin[] {
    const builtIns = defaultPresets.map((preset) => ({ preset, builtIn: true }));
    const userPresets = this.presetRepository.loadUserPresets().map((preset) => ({ preset, builtIn: false }));
    return [...builtIns, ...userPresets];
  }

  private resolvePreset(presetId?: string): PresetWithOrigin {
    const targetId = presetId || 'default';
    const preset = this.getAllPresets().find((item) => item.preset.id === targetId);
    if (!preset) {
      throw new ImagePumaMcpError('PRESET_NOT_FOUND', `Preset not found: ${targetId}`);
    }
    return {
      preset: clonePreset(preset.preset),
      builtIn: preset.builtIn,
    };
  }

  private async preparePresetForPlan(
    basePreset: AppPreset,
    input: McpPlanInput,
    extraWarnings: BatchOutputPlanIssue[],
    allowedRoots: AllowedRoot[],
  ): Promise<AppPreset> {
    const allowOverwrite = Boolean(input.allowOverwrite);
    const preset = applyQualityJob(
      applyCustomSettings(basePreset, input.customSettings),
      { quality: input.quality, format: input.format, lossless: input.lossless },
    );
    if (isQualityJob(input) && !namingSanitizeWasSet(input.customSettings)) {
      preset.naming.sanitizeAiTerms = false;
    }
    const requestedOverwrite = preset.export.overwrite;

    if (input.outputDir !== undefined) {
      const outputDir = await canonicalizeExistingDirectory(input.outputDir, allowedRoots);
      preset.export.destination = 'custom';
      preset.export.customPath = outputDir;
    } else if (preset.export.destination === 'custom') {
      preset.export.customPath = await canonicalizeExistingDirectory(preset.export.customPath, allowedRoots);
    }

    if (!allowOverwrite && requestedOverwrite) {
      extraWarnings.push(issue(
        'warning',
        'headless-overwrite-disabled',
        'Overwrite was requested by the preset/settings, but MCP plans are no-overwrite unless allowOverwrite is true.',
        { section: 'export' },
      ));
    }

    preset.export.overwrite = allowOverwrite && requestedOverwrite;
    preset.export.openFolderWhenDone = false;
    return preset;
  }

  private validateInputLimits(files: InputFile[], totalSize: number): void {
    if (files.length > this.limits.maxFiles) {
      throw new ImagePumaMcpError('INPUT_LIMIT_EXCEEDED', `Too many input files: ${files.length} > ${this.limits.maxFiles}`, {
        maxFiles: this.limits.maxFiles,
        fileCount: files.length,
      });
    }
    if (totalSize > this.limits.maxTotalInputBytes) {
      throw new ImagePumaMcpError('INPUT_LIMIT_EXCEEDED', `Input bytes exceed the configured limit: ${totalSize} > ${this.limits.maxTotalInputBytes}`, {
        maxTotalInputBytes: this.limits.maxTotalInputBytes,
        totalSize,
      });
    }

    for (const file of files) {
      if (!file.width || !file.height) continue;
      const megapixels = (file.width * file.height) / 1_000_000;
      if (megapixels > this.limits.maxMegapixelsPerFile) {
        throw new ImagePumaMcpError('INPUT_LIMIT_EXCEEDED', `Input image is too large: ${file.sourcePath}`, {
          sourcePath: file.sourcePath,
          megapixels,
          maxMegapixelsPerFile: this.limits.maxMegapixelsPerFile,
        });
      }
    }
  }

  private async assertPlannedOutputsAllowed(plan: StoredMcpPlan['plan'], allowedRoots: AllowedRoot[]): Promise<void> {
    for (const entry of plan.entries) {
      if (entry.outputFolder) {
        await canonicalizeOutputPath(entry.outputFolder, allowedRoots);
      }
      for (const variant of entry.variants) {
        await canonicalizeOutputPath(variant.outputPath, allowedRoots);
      }
    }
  }

  private async assertPlanStillCurrent(storedPlan: StoredMcpPlan): Promise<void> {
    const currentIdentities = await Promise.all(
      storedPlan.files.map((file) => createInputIdentity(file, storedPlan.limits.hashSmallFileBytes)),
    );

    for (const [index, expected] of storedPlan.identities.entries()) {
      const actual = currentIdentities[index];
      if (
        expected.realPath !== actual.realPath
        || expected.size !== actual.size
        || expected.mtimeMs !== actual.mtimeMs
        || (expected.sha256 !== undefined && expected.sha256 !== actual.sha256)
      ) {
        throw new ImagePumaMcpError('PLAN_STALE', `Source changed after planning: ${expected.sourcePath}`, {
          expected,
          actual,
        });
      }
    }

    const settingsHash = hashJson({
      allowOverwrite: storedPlan.allowOverwrite,
      allowedRoots: storedPlan.allowedRoots,
      identities: storedPlan.identities,
      plan: storedPlan.plan,
      preset: storedPlan.preset,
    });
    if (settingsHash !== storedPlan.settingsHash) {
      throw new ImagePumaMcpError('PLAN_STALE', 'Stored plan failed its integrity check.');
    }
  }

  private async assertPlannedOutputsRunnable(storedPlan: StoredMcpPlan): Promise<void> {
    for (const entry of storedPlan.plan.entries) {
      for (const variant of entry.variants) {
        await canonicalizeOutputPath(variant.outputPath, storedPlan.allowedRoots);

        const outputStat = await fs.lstat(variant.outputPath).catch((): null => null);
        if (outputStat?.isSymbolicLink()) {
          throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Output path became a symbolic link: ${variant.outputPath}`, {
            outputPath: variant.outputPath,
          });
        }

        const writesSource = path.resolve(variant.outputPath) === path.resolve(entry.sourcePath);
        if ((variant.collision === 'overwrite' || writesSource) && !storedPlan.allowOverwrite) {
          throw new ImagePumaMcpError('OUTPUT_CHANGED', `Plan would overwrite without plan-time overwrite permission: ${variant.outputPath}`, {
            outputPath: variant.outputPath,
          });
        }

        if (variant.collision !== 'overwrite' && outputStat) {
          throw new ImagePumaMcpError('OUTPUT_CHANGED', `Planned output path now exists. Create a new plan: ${variant.outputPath}`, {
            outputPath: variant.outputPath,
          });
        }
      }
    }
  }

  private async getEffectiveAllowedRoots(additionalAllowedDirs: string[] = []): Promise<AllowedRoot[]> {
    if (additionalAllowedDirs.length === 0) return this.allowedRoots;

    const dynamicRoots = await resolveAllowedRoots(additionalAllowedDirs);
    const roots = [...this.allowedRoots];
    const seen = new Set(roots.map((root) => root.realPath));

    for (const root of dynamicRoots) {
      if (seen.has(root.realPath)) continue;
      seen.add(root.realPath);
      roots.push(root);
    }

    return roots;
  }

  private throwIfPlanCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ImagePumaMcpError('PLAN_CANCELLED', 'Image Puma plan was cancelled before it was stored.');
    }
  }
}

export async function createImagePumaMcpService(options: ImagePumaMcpServiceOptions = {}): Promise<ImagePumaMcpService> {
  const allowedRoots = options.includeDefaultDirs
    ? await resolveConfiguredAndDefaultAllowedRoots(options.allowedDirs || [])
    : await resolveAllowedRoots(options.allowedDirs || []);
  const presetRepository = options.presetRepository
    ?? createUserPresetRepository(createJsonFilePresetStore(options.presetFilePath));

  return new ImagePumaMcpService({
    allowedRoots,
    presetRepository,
    planStore: options.planStore,
    limits: options.limits,
  });
}
