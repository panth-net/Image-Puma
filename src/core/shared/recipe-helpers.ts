import type {
  AppPreset,
  InputFile,
  MetadataMode,
  OutputFormat,
} from './types';
import {
  sanitizeFileSegment,
  shouldStripAiSourceTerms,
  stripAiSourceTerms,
} from './filename-sanitizer';
import {
  isMetadataRewriteEnabled,
  isSyntheticImageProcessingEnabled,
  metadataRewriteUsesCreator,
  normalizeMetadataSettings,
} from './metadata-settings';
import { isBackgroundRemovalEnabled } from './background-removal-settings';

export type RecipeSection =
  | 'output'
  | 'resize'
  | 'crop'
  | 'transform'
  | 'metadata'
  | 'naming'
  | 'backgroundRemoval'
  | 'export';

export interface RecipeValidationIssue {
  section: RecipeSection;
  field: string;
  message: string;
}

export const RECIPE_SECTION_LABELS: Record<RecipeSection, string> = {
  output: 'Format',
  resize: 'Resize',
  crop: 'Crop',
  transform: 'Transform',
  metadata: 'Privacy',
  naming: 'Naming',
  backgroundRemoval: 'Remove Background',
  export: 'Export',
};

const SUPPORTED_OUTPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'ico', 'icns']);

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortObject((value as Record<string, unknown>)[key]);
      return sorted;
    }, {});
}

function applyTemplate(template: string, tokenValues: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(tokenValues)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }
  return rendered;
}

export function recipeFingerprint(preset: AppPreset): string {
  return JSON.stringify(sortObject(preset));
}

export function getChangedRecipeSections(base: AppPreset, current: AppPreset): RecipeSection[] {
  return (Object.keys(RECIPE_SECTION_LABELS) as RecipeSection[])
    .filter((section) => (
      JSON.stringify(sortObject(base[section])) !== JSON.stringify(sortObject(current[section]))
    ));
}

export function getResolvedOutputFormat(format: OutputFormat, originalExt: string): string {
  if (format === 'keep-original') {
    const ext = normalizeImageFormatName(originalExt);
    return SUPPORTED_OUTPUT_FORMATS.has(ext) ? ext : 'jpeg';
  }
  return SUPPORTED_OUTPUT_FORMATS.has(format) ? format : 'jpeg';
}

export function getBatchOutputFormat(
  format: OutputFormat,
  files: Array<Pick<InputFile, 'extension'>>,
): Exclude<OutputFormat, 'keep-original'> {
  const anchorExtension = files[0]?.extension || '.jpg';
  return getResolvedOutputFormat(format, anchorExtension) as Exclude<OutputFormat, 'keep-original'>;
}

export function normalizeImageFormatName(formatOrExt: string): string {
  const value = formatOrExt.toLowerCase().replace(/^\./, '');
  if (value === 'jpg' || value === 'jpe' || value === 'jfif') return 'jpeg';
  if (value === 'tif') return 'tiff';
  if (value === 'heic' || value === 'heif' || value === 'heics' || value === 'heifs' || value === 'hif') return 'heif';
  if (value === 'svgz' || value === 'svg.gz') return 'svg';
  return value;
}

export function isOutputNeutral(output: AppPreset['output']): boolean {
  return output.format === 'keep-original'
    && output.jpegQuality === 100
    && output.pngCompressionLevel === 0
    && output.webpQuality === 100
    && output.avifQuality === 100
    && !output.lossless;
}

export function doesPresetChangeImageBytes(preset: AppPreset): boolean {
  return !isOutputNeutral(preset.output)
    || preset.resize.mode !== 'none'
    || preset.crop.enabled
    || preset.transform.rotation !== 0
    || preset.transform.flipH
    || preset.transform.flipV
    || preset.metadata.mode !== 'keep-all'
    || preset.metadata.convertToSrgb
    || isSyntheticImageProcessingEnabled(preset.metadata)
    || isMetadataRewriteEnabled(preset.metadata)
    || isBackgroundRemovalEnabled(preset);
}

export function doesPresetChangeImageBytesForFile(
  file: InputFile,
  preset: AppPreset,
  resolvedOutputFormat = getResolvedOutputFormat(preset.output.format, file.extension),
): boolean {
  return doesPresetChangeImageBytes(preset)
    || normalizeImageFormatName(file.extension) !== normalizeImageFormatName(resolvedOutputFormat);
}

export function validatePresetSettings(preset: AppPreset): RecipeValidationIssue[] {
  const issues: RecipeValidationIssue[] = [];
  const { resize, export: exportSettings } = preset;
  const metadata = normalizeMetadataSettings(preset.metadata);

  const addPositiveNumberIssue = (field: string, label: string) => {
    issues.push({
      section: 'resize',
      field,
      message: `${label} is required and must be greater than 0.`,
    });
  };

  if ((resize.mode === 'width' || resize.mode === 'exact')
    && (!Number.isFinite(resize.width) || !resize.width || resize.width <= 0)) {
    addPositiveNumberIssue('width', 'Width');
  }

  if ((resize.mode === 'height' || resize.mode === 'exact')
    && (!Number.isFinite(resize.height) || !resize.height || resize.height <= 0)) {
    addPositiveNumberIssue('height', 'Height');
  }

  if (resize.mode === 'fit-box'
    && (!Number.isFinite(resize.width) || !resize.width || resize.width <= 0)
    && (!Number.isFinite(resize.height) || !resize.height || resize.height <= 0)) {
    issues.push({
      section: 'resize',
      field: 'mode',
      message: 'Fit Box requires a width, height, or both.',
    });
  }

  if (resize.mode === 'percent'
    && (!Number.isFinite(resize.percent) || !resize.percent || resize.percent <= 0)) {
    addPositiveNumberIssue('percent', 'Percent');
  }

  if (resize.mode === 'percent' && resize.percent && resize.percent > 400) {
    issues.push({
      section: 'resize',
      field: 'percent',
      message: 'Percent must be 400 or lower.',
    });
  }

  if (resize.mode === 'exact') {
    issues.push({
      section: 'resize',
      field: 'mode',
      message: 'Stretch to exact size can distort images. Use Fit Box unless distortion is intentional.',
    });
  }

  if (exportSettings.destination === 'sibling' && exportSettings.siblingFolderName.trim().length === 0) {
    issues.push({
      section: 'export',
      field: 'siblingFolderName',
      message: 'Sibling folder name is required.',
    });
  }

  if (exportSettings.destination === 'custom' && exportSettings.customPath.trim().length === 0) {
    issues.push({
      section: 'export',
      field: 'customPath',
      message: 'Choose a custom export folder before processing.',
    });
  }

  if (
    isBackgroundRemovalEnabled(preset)
    && !['keep-original', 'png', 'webp'].includes(preset.output.format)
  ) {
    issues.push({
      section: 'backgroundRemoval',
      field: 'enabled',
      message: 'Background removal needs PNG or WebP output to preserve transparency.',
    });
  }

  if (metadataRewriteUsesCreator(metadata) && metadata.creatorName.trim().length === 0) {
    issues.push({
      section: 'metadata',
      field: 'creatorName',
      message: 'Creator name is required when creator rewrite is enabled.',
    });
  }

  return issues;
}

export function getMetadataModeCopy(mode: MetadataMode): string {
  const copy: Record<MetadataMode, string> = {
    'strip-all': 'Drops all embedded metadata and strips AI source terms from output filenames.',
    'strip-privacy-smart': 'Drops EXIF/XMP/IPTC and keeps only the color profile when possible.',
    'keep-all': 'Keeps metadata. Use only when privacy is not a concern.',
    'keep-exif': 'Keeps camera EXIF data. Location data may remain.',
    'keep-icc': 'Keeps color profile only. Good for visual consistency with less private metadata.',
    'keep-xmp': 'Keeps XMP metadata where supported.',
    'strip-gps-only': 'Best-effort ExifTool cleanup for GPS, device IDs, lens model, and capture timestamps. Other EXIF remains.',
  };
  return copy[mode];
}

export function buildNamingExample(
  file: InputFile,
  preset: AppPreset,
  index = 0,
  dimensions: { width?: number; height?: number } = {},
): string {
  const outputFormat = getResolvedOutputFormat(preset.output.format, file.extension);
  const outputExt = outputFormat;
  const sanitizeAiTerms = shouldStripAiSourceTerms(preset.metadata.mode, preset.naming);
  const baseNameCandidate = sanitizeAiTerms ? stripAiSourceTerms(file.fileName) : file.fileName;
  const baseName = sanitizeFileSegment(baseNameCandidate) || 'image';
  let name = baseName;
  let templateApplied = false;

  if (!preset.naming.keepOriginal) {
    if (preset.naming.findText) {
      name = name.split(preset.naming.findText).join(preset.naming.replaceText);
    }

    if (preset.naming.template.trim().length > 0) {
      templateApplied = true;
      const sequence = preset.naming.sequential ? preset.naming.sequentialStart + index : index + 1;
      name = applyTemplate(preset.naming.template, {
        name,
        index: String(index + 1),
        seq: String(sequence),
        format: outputExt,
        ext: outputExt,
        width: dimensions.width ? String(dimensions.width) : '',
        height: dimensions.height ? String(dimensions.height) : '',
      });
    }
  }

  if (!templateApplied) {
    if (preset.naming.prefix) name = preset.naming.prefix + name;
    if (preset.naming.suffix) name = name + preset.naming.suffix;
    if (!preset.naming.keepOriginal && preset.naming.sequential) {
      name = `${name}-${String(preset.naming.sequentialStart + index).padStart(3, '0')}`;
    }
  }

  const sanitizedName = sanitizeFileSegment(name) || baseName;
  const ext = `.${outputFormat}`;
  if (sanitizedName.toLowerCase().endsWith(ext.toLowerCase())) {
    return sanitizedName;
  }
  return sanitizedName + ext;
}
