import * as path from 'path';
import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import sharp from 'sharp';
import type {
  AppPreset,
  BatchOutputPlan,
  BatchOutputPlanIssue,
  BatchOutputPlanRequest,
  InputFile,
  PlannedOutputVariant,
} from '../shared/types';
import {
  isMetadataRewriteEnabled,
  isSyntheticImageProcessingEnabled,
  metadataRewriteUsesCreator,
  metadataRewriteUsesTimestamp,
  normalizeMetadataSettings,
} from '../shared/metadata-settings';
import { isBackgroundRemovalEnabled, normalizeBackgroundRemovalSettings } from '../shared/background-removal-settings';
import { getBatchOutputFormat, normalizeImageFormatName } from '../shared/recipe-helpers';
import { getResolvedFormat } from '../processing/build-pipeline';
import { resolveOutputFolder, resolvePlannedOutputPaths } from './export-paths';
import { nativeDecodePlanWarning, prepareSharpInput } from './prepare-sharp-input';

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
    metadata: normalizeMetadataSettings(preset.metadata),
    naming: { ...preset.naming },
    export: { ...preset.export },
    backgroundRemoval: normalizeBackgroundRemovalSettings(preset.backgroundRemoval),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureReadableFile(file: InputFile): Promise<BatchOutputPlanIssue[]> {
  const issues: BatchOutputPlanIssue[] = [];
  try {
    const stat = await fs.stat(file.sourcePath);
    if (!stat.isFile()) {
      issues.push(issue('error', 'source-not-file', 'Source is no longer a readable file.', {
        sourcePath: file.sourcePath,
        section: 'sources',
      }));
      return issues;
    }
    await fs.access(file.sourcePath, fsConstants.R_OK);
  } catch {
    issues.push(issue('error', 'source-unreadable', 'Source file is missing or unreadable.', {
      sourcePath: file.sourcePath,
      section: 'sources',
    }));
  }
  return issues;
}

function validateResize(file: InputFile, preset: AppPreset): BatchOutputPlanIssue[] {
  const r = preset.resize;
  const issues: BatchOutputPlanIssue[] = [];
  const base = {
    sourcePath: file.sourcePath,
    section: 'resize' as const,
  };

  if (r.mode === 'width' && (!Number.isFinite(r.width) || !r.width || r.width <= 0)) {
    issues.push(issue('error', 'resize-width-required', 'Width resize needs a width greater than 0.', base));
  }
  if (r.mode === 'height' && (!Number.isFinite(r.height) || !r.height || r.height <= 0)) {
    issues.push(issue('error', 'resize-height-required', 'Height resize needs a height greater than 0.', base));
  }
  if (
    r.mode === 'fit-box'
    && (
      (!Number.isFinite(r.width) || !r.width || r.width <= 0)
      && (!Number.isFinite(r.height) || !r.height || r.height <= 0)
    )
  ) {
    issues.push(issue('error', 'resize-box-required', 'Fit Box needs a width, height, or both greater than 0.', base));
  }
  if (
    r.mode === 'exact'
    && (!Number.isFinite(r.width) || !r.width || r.width <= 0 || !Number.isFinite(r.height) || !r.height || r.height <= 0)
  ) {
    issues.push(issue('error', 'resize-box-required', 'Stretch to exact size needs width and height greater than 0.', base));
  }
  if (r.mode === 'percent' && (!Number.isFinite(r.percent) || !r.percent || r.percent <= 0)) {
    issues.push(issue('error', 'resize-percent-required', 'Percent resize needs a value greater than 0.', base));
  }

  return issues;
}

async function validateExportFolder(
  file: InputFile,
  preset: AppPreset,
): Promise<{ outputFolder: string; issues: BatchOutputPlanIssue[] }> {
  const issues: BatchOutputPlanIssue[] = [];
  let outputFolder = '';

  try {
    outputFolder = resolveOutputFolder(file, preset.export);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    issues.push(issue('error', 'export-folder-required', message, {
      sourcePath: file.sourcePath,
      section: 'export',
    }));
    return { outputFolder, issues };
  }

  if (preset.export.destination === 'custom') {
    try {
      const stat = await fs.stat(outputFolder);
      if (!stat.isDirectory()) {
        issues.push(issue('error', 'export-folder-not-directory', 'Custom export path is not a folder.', {
          sourcePath: file.sourcePath,
          section: 'export',
          targetPath: outputFolder,
        }));
      } else {
        await fs.access(outputFolder, fsConstants.W_OK);
      }
    } catch {
      issues.push(issue('error', 'export-folder-unwritable', 'Custom export folder is missing or not writable.', {
        sourcePath: file.sourcePath,
        section: 'export',
        targetPath: outputFolder,
      }));
    }
  } else {
    const sourceDir = path.dirname(file.sourcePath);
    try {
      await fs.access(sourceDir, fsConstants.W_OK);
    } catch {
      issues.push(issue('error', 'source-folder-unwritable', 'Source folder is not writable for sibling export.', {
        sourcePath: file.sourcePath,
        section: 'export',
        targetPath: sourceDir,
      }));
    }

    try {
      const stat = await fs.stat(outputFolder);
      if (!stat.isDirectory()) {
        issues.push(issue('error', 'export-target-not-directory', 'Sibling export target already exists and is not a folder.', {
          sourcePath: file.sourcePath,
          section: 'export',
          targetPath: outputFolder,
        }));
      }
    } catch {
      // The sibling folder can be created during processing if the parent is writable.
    }
  }

  return { outputFolder, issues };
}

async function collectMetadataWarnings(file: InputFile, preset: AppPreset): Promise<BatchOutputPlanIssue[]> {
  const issues: BatchOutputPlanIssue[] = [];
  let preparedInput: Awaited<ReturnType<typeof prepareSharpInput>> | null = null;
  let meta: sharp.Metadata;
  try {
    preparedInput = await prepareSharpInput(file.sourcePath, { probeDecode: true });
    meta = preparedInput.metadata;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not inspect source metadata.';
    const isNativeDecodeFailure = message.startsWith('Could not decode source image.');
    return [issue('error', isNativeDecodeFailure ? 'source-decode-unsupported' : 'metadata-unreadable', isNativeDecodeFailure ? message : 'Could not inspect source metadata.', {
      sourcePath: file.sourcePath,
      section: 'sources',
    })];
  }

  try {
    if (preparedInput.usedNativeFallback) {
      issues.push(issue('warning', 'source-native-decode-fallback', nativeDecodePlanWarning(), {
        sourcePath: file.sourcePath,
        section: 'sources',
      }));
    }

    const resolvedOutputFormat = getResolvedFormat(preset.output.format, file.extension);
    if (isBackgroundRemovalEnabled(preset) && !['png', 'webp'].includes(resolvedOutputFormat)) {
      issues.push(issue('error', 'background-removal-transparent-format-required', 'Background removal needs PNG or WebP output to preserve transparent cutouts.', {
        sourcePath: file.sourcePath,
        section: 'backgroundRemoval',
      }));
    }

    if (meta.hasAlpha && resolvedOutputFormat === 'jpeg') {
      issues.push(issue('warning', 'transparency-loss', 'Transparency will be lost when this file exports as JPEG.', {
        sourcePath: file.sourcePath,
        section: 'compression',
      }));
    }

    if (preset.output.format === 'keep-original') {
      const normalizedInput = normalizeImageFormatName(file.extension);
      if (normalizedInput !== resolvedOutputFormat) {
        issues.push(issue('warning', 'format-fallback', `Original format ".${normalizedInput}" is not exportable; output will use ${resolvedOutputFormat.toUpperCase()}.`, {
          sourcePath: file.sourcePath,
          section: 'compression',
        }));
      }
    }

    if (preset.metadata.mode === 'strip-privacy-smart') {
      issues.push(issue('warning', 'metadata-smart-strip', 'Privacy-safe mode removes EXIF/XMP/IPTC while keeping the color profile when possible.', {
        sourcePath: file.sourcePath,
        section: 'metadata',
      }));
    }
    if (preset.metadata.mode === 'strip-gps-only') {
      issues.push(issue('warning', 'metadata-selective-strip', 'Best-effort EXIF cleanup removes GPS/device fields with ExifTool, but other EXIF remains.', {
        sourcePath: file.sourcePath,
        section: 'metadata',
      }));
    }
    if (isSyntheticImageProcessingEnabled(preset.metadata)) {
      issues.push(issue('warning', 'metadata-synthetic-processing', 'Synthetic cleanup may remove alpha, crop AI edge artifacts, or crop a detected Gemini watermark.', {
        sourcePath: file.sourcePath,
        section: 'metadata',
      }));
    }
    if (isMetadataRewriteEnabled(preset.metadata)) {
      const rewriteParts: string[] = [];
      if (metadataRewriteUsesTimestamp(preset.metadata)) rewriteParts.push('jittered timestamps');
      if (metadataRewriteUsesCreator(preset.metadata)) rewriteParts.push('creator metadata');
      issues.push(issue('warning', 'metadata-rewrite', `Metadata rewrite will add ${rewriteParts.join(' and ')}.`, {
        sourcePath: file.sourcePath,
        section: 'metadata',
      }));
    }
    if (preset.metadata.convertToSrgb && meta.space && meta.space !== 'srgb') {
      issues.push(issue('warning', 'color-convert-srgb', `Color profile will be converted from ${meta.space} to sRGB.`, {
        sourcePath: file.sourcePath,
        section: 'metadata',
      }));
    }

    return issues;
  } finally {
    await preparedInput.dispose();
  }
}

async function reserveOutputPath(
  baseOutputPath: string,
  overwrite: boolean,
  reserved: Set<string>,
): Promise<{ outputPath: string; collision: PlannedOutputVariant['collision'] }> {
  const normalizedBaseOutputPath = path.resolve(baseOutputPath);
  if (overwrite) {
    const willOverwrite = await pathExists(baseOutputPath) || reserved.has(normalizedBaseOutputPath);
    reserved.add(normalizedBaseOutputPath);
    return {
      outputPath: baseOutputPath,
      collision: willOverwrite ? 'overwrite' : 'none',
    };
  }

  let candidate = baseOutputPath;
  let counter = 2;
  const ext = path.extname(baseOutputPath);
  const base = baseOutputPath.slice(0, -ext.length);

  while (reserved.has(path.resolve(candidate)) || await pathExists(candidate)) {
    candidate = `${base}-${counter}${ext}`;
    counter++;
  }

  reserved.add(path.resolve(candidate));
  return {
    outputPath: candidate,
    collision: candidate === baseOutputPath ? 'none' : 'renamed',
  };
}

export async function planBatchOutputs(request: BatchOutputPlanRequest): Promise<BatchOutputPlan> {
  const presetSnapshot = clonePreset(request.preset);
  if (presetSnapshot.output.format === 'keep-original' && request.files.length > 0) {
    presetSnapshot.output.format = getBatchOutputFormat(presetSnapshot.output.format, request.files);
  }
  const entries: BatchOutputPlan['entries'] = [];
  const issues: BatchOutputPlanIssue[] = [];
  const reservedOutputs = new Set<string>();
  const destinationFolders = new Set<string>();

  if (request.files.length === 0) {
    issues.push(issue('error', 'no-sources', 'Add at least one source image before running a batch.', {
      section: 'sources',
    }));
  }

  for (const [index, file] of request.files.entries()) {
    const preset = presetSnapshot;
    const entryIssues: BatchOutputPlanIssue[] = [];
    const sourceIssues = await ensureReadableFile(file);
    entryIssues.push(...sourceIssues);
    entryIssues.push(...validateResize(file, preset));

    const exportValidation = await validateExportFolder(file, preset);
    entryIssues.push(...exportValidation.issues);
    if (exportValidation.outputFolder) {
      destinationFolders.add(exportValidation.outputFolder);
    }

    const variants: PlannedOutputVariant[] = [];
    if (!entryIssues.some((item) => item.level === 'error')) {
      entryIssues.push(...await collectMetadataWarnings(file, preset));
    }

    if (!entryIssues.some((item) => item.level === 'error')) {
      const plannedOutputs = resolvePlannedOutputPaths(file, preset, index);

      for (const planned of plannedOutputs) {
        const reserved = await reserveOutputPath(
          planned.outputPath,
          planned.preset.export.overwrite,
          reservedOutputs,
        );
        const collision = reserved.collision;

        if (collision === 'renamed') {
          entryIssues.push(issue('warning', 'output-renamed-to-avoid-overwrite', 'Output filename will be renamed to avoid overwriting an existing file.', {
            sourcePath: file.sourcePath,
            section: 'naming',
            targetPath: reserved.outputPath,
          }));
        } else if (collision === 'overwrite') {
          const overwritesSource = path.resolve(reserved.outputPath) === path.resolve(file.sourcePath);
          entryIssues.push(issue('warning', overwritesSource ? 'output-will-replace-source' : 'output-will-overwrite', overwritesSource
            ? 'Output will replace the original source file using a temporary file.'
            : 'Output may overwrite an existing file.', {
            sourcePath: file.sourcePath,
            section: 'export',
            targetPath: reserved.outputPath,
          }));
        }

        variants.push({
          outputPath: reserved.outputPath,
          baseOutputPath: planned.outputPath,
          format: planned.resolvedFormat,
          width: planned.width,
          height: planned.height,
          collision,
          preset: planned.preset,
        });
      }
    }

    entries.push({
      sourcePath: file.sourcePath,
      fileName: `${file.fileName}${file.extension}`,
      sourceSize: file.fileSize,
      outputFolder: exportValidation.outputFolder,
      variants,
      issues: entryIssues,
    });
    issues.push(...entryIssues);
  }

  const errorCount = issues.filter((item) => item.level === 'error').length;
  const warningCount = issues.filter((item) => item.level === 'warning').length;

  return {
    preset: presetSnapshot,
    entries,
    issues,
    summary: {
      sourceCount: request.files.length,
      outputCount: entries.reduce((total, entry) => total + entry.variants.length, 0),
      errorCount,
      warningCount,
      destinationFolders: Array.from(destinationFolders),
    },
  };
}
