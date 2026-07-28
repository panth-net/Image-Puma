import * as path from 'path';
import * as fs from 'fs/promises';
import { AppPreset, InputFile, NamingSettings, ExportSettings } from '../shared/types';
import {
  sanitizeFileSegment,
  shouldStripAiSourceTerms,
  stripAiSourceTerms,
} from '../shared/filename-sanitizer';
import { getResolvedFormat } from '../processing/build-pipeline';

function applyTemplate(template: string, tokenValues: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(tokenValues)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }
  return rendered;
}

export function resolveOutputFolder(file: InputFile, exportSettings: ExportSettings): string {
  if (exportSettings.destination === 'custom') {
    const customPath = exportSettings.customPath.trim();
    if (!customPath) {
      throw new Error('Custom export folder is required');
    }
    return customPath;
  }
  const sourceDir = path.dirname(file.sourcePath);
  return path.join(sourceDir, exportSettings.siblingFolderName || 'optimized');
}

export function resolveOutputFilename(
  file: InputFile,
  naming: NamingSettings,
  outputFormat: string,
  index: number,
  templateTokens?: Record<string, string>,
  options: { forceSanitizeAiTerms?: boolean } = {},
): string {
  const outputExt = outputFormat === 'keep-original'
    ? file.extension.replace(/^\./, '')
    : outputFormat;

  const sanitizeAiTerms = options.forceSanitizeAiTerms || naming.sanitizeAiTerms !== false;
  const baseNameCandidate = sanitizeAiTerms
    ? stripAiSourceTerms(file.fileName)
    : file.fileName;
  const baseName = sanitizeFileSegment(baseNameCandidate) || 'image';
  let name = baseName;
  let templateApplied = false;

  if (!naming.keepOriginal) {
    if (naming.findText) {
      name = name.split(naming.findText).join(naming.replaceText);
    }

    if (naming.template && naming.template.trim().length > 0) {
      templateApplied = true;
      const sequence = naming.sequential ? naming.sequentialStart + index : index + 1;
      name = applyTemplate(naming.template, {
        name,
        index: String(index + 1),
        seq: String(sequence),
        format: outputExt,
        ext: outputExt,
        width: templateTokens?.width || '',
        height: templateTokens?.height || '',
        ...templateTokens,
      });
    }
  }

  if (!templateApplied) {
    if (naming.prefix) name = naming.prefix + name;
    if (naming.suffix) name = name + naming.suffix;
    if (!naming.keepOriginal && naming.sequential) {
      name = name + '-' + String(naming.sequentialStart + index).padStart(3, '0');
    }
  }

  const sanitizedName = sanitizeFileSegment(name) || baseName;
  const ext = outputFormat === 'keep-original' ? file.extension : '.' + outputFormat;

  // Avoid duplicate extensions when templates include ".jpg"/".png" etc.
  if (sanitizedName.toLowerCase().endsWith(ext.toLowerCase())) {
    return sanitizedName;
  }

  return sanitizedName + ext;
}

export function resolveOutputPath(
  file: InputFile,
  preset: AppPreset,
  index: number,
  resolvedOutputFormat?: string,
  templateTokens?: Record<string, string>,
): string {
  const folder = resolveOutputFolder(file, preset.export);
  const format = resolvedOutputFormat || preset.output.format;
  const filename = resolveOutputFilename(file, preset.naming, format, index, templateTokens, {
    forceSanitizeAiTerms: shouldStripAiSourceTerms(preset.metadata.mode, preset.naming),
  });
  return path.join(folder, filename);
}

export interface PlannedOutputPath {
  preset: AppPreset;
  outputPath: string;
  resolvedFormat: string;
  width?: number;
  height?: number;
}

function normalizeResponsiveWidths(resize: AppPreset['resize']): number[] {
  if (resize.mode !== 'width') return [];
  if (!Array.isArray(resize.responsiveWidths)) return [];
  if (resize.responsiveWidths.length === 0) return [];

  const unique = new Set<number>();
  const additional: number[] = [];
  let baseWidth: number | null = null;

  if (typeof resize.width === 'number' && Number.isFinite(resize.width) && resize.width > 0) {
    baseWidth = Math.round(resize.width);
    unique.add(baseWidth);
  }

  for (const width of resize.responsiveWidths) {
    const rounded = Math.round(Number(width));
    if (!Number.isFinite(rounded) || rounded <= 0) continue;
    if (unique.has(rounded)) continue;
    unique.add(rounded);
    additional.push(rounded);
  }

  if (additional.length === 0) return [];
  return baseWidth ? [baseWidth, ...additional] : additional;
}

function buildResponsiveVariantPreset(basePreset: AppPreset, width: number): AppPreset {
  const suffix = `${basePreset.naming.suffix}${basePreset.naming.suffix ? '-' : ''}${width}w`;

  return {
    ...basePreset,
    resize: {
      ...basePreset.resize,
      mode: 'width',
      width,
      height: undefined,
      percent: undefined,
      responsiveWidths: [],
    },
    naming: {
      ...basePreset.naming,
      keepOriginal: false,
      suffix,
    },
  };
}

export function resolvePlannedOutputPaths(
  file: InputFile,
  preset: AppPreset,
  index: number,
): PlannedOutputPath[] {
  const widths = normalizeResponsiveWidths(preset.resize);
  const presetsToRun = widths.length > 0
    ? widths.map((width) => buildResponsiveVariantPreset(preset, width))
    : [preset];

  return presetsToRun.map((variantPreset) => {
    const resolvedFormat = getResolvedFormat(variantPreset.output.format, file.extension);
    const width = variantPreset.resize.mode === 'width' && variantPreset.resize.width
      ? variantPreset.resize.width
      : undefined;
    const height = variantPreset.resize.mode === 'height' && variantPreset.resize.height
      ? variantPreset.resize.height
      : undefined;
    const outputPath = resolveOutputPath(file, variantPreset, index, resolvedFormat, {
      width: width ? String(width) : '',
      height: height ? String(height) : '',
    });

    return {
      preset: variantPreset,
      outputPath,
      resolvedFormat,
      width,
      height,
    };
  });
}

export async function ensureNoOverwrite(filePath: string): Promise<string> {
  let candidate = filePath;
  let counter = 2;
  let available = false;
  while (!available) {
    try {
      await fs.access(candidate);
      // file exists, increment
      const ext = path.extname(filePath);
      const base = filePath.slice(0, -ext.length);
      candidate = `${base}-${counter}${ext}`;
      counter++;
    } catch {
      available = true;
    }
  }
  return candidate;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
