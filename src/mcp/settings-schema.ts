import type { AppPreset, MetadataMode, OutputFormat, ResizeMode } from '../core/shared/types';
import { normalizeBackgroundRemovalSettings } from '../core/shared/background-removal-settings';
import { normalizeMetadataSettings } from '../core/shared/metadata-settings';
import { ImagePumaMcpError } from './types';

const OUTPUT_FORMATS: OutputFormat[] = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'ico', 'icns', 'keep-original'];
const RESIZE_MODES: ResizeMode[] = ['none', 'width', 'height', 'fit-box', 'exact', 'percent'];
const METADATA_MODES: MetadataMode[] = [
  'strip-all',
  'keep-all',
  'keep-exif',
  'keep-icc',
  'keep-xmp',
  'strip-privacy-smart',
  'strip-gps-only',
];

export const IMAGE_PUMA_SETTINGS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'ImagePumaSettings',
  type: 'object',
  additionalProperties: false,
  properties: {
    output: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: { enum: OUTPUT_FORMATS },
        jpegQuality: { type: 'integer', minimum: 1, maximum: 100 },
        pngCompressionLevel: { type: 'integer', minimum: 0, maximum: 9 },
        webpQuality: { type: 'integer', minimum: 1, maximum: 100 },
        avifQuality: { type: 'integer', minimum: 1, maximum: 100 },
        lossless: { type: 'boolean' },
      },
    },
    resize: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { enum: RESIZE_MODES },
        width: { type: 'integer', minimum: 1, maximum: 20000 },
        height: { type: 'integer', minimum: 1, maximum: 20000 },
        percent: { type: 'integer', minimum: 1, maximum: 1000 },
        noUpscale: { type: 'boolean' },
        responsiveWidths: {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 20000 },
          maxItems: 24,
        },
      },
    },
    crop: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        x: { type: 'number', minimum: 0, maximum: 100 },
        y: { type: 'number', minimum: 0, maximum: 100 },
        width: { type: 'number', minimum: 1, maximum: 100 },
        height: { type: 'number', minimum: 1, maximum: 100 },
        aspectRatio: { type: ['string', 'null'] },
        aspectAnchor: { enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] },
        positionMode: { enum: ['xy', 'anchor'] },
        anchorInsideImage: { type: 'boolean' },
      },
    },
    transform: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rotation: { type: 'integer', minimum: -180, maximum: 180 },
        flipH: { type: 'boolean' },
        flipV: { type: 'boolean' },
      },
    },
    metadata: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { enum: METADATA_MODES },
        convertToSrgb: { type: 'boolean' },
        syntheticMode: { enum: ['off', 'process'] },
        rewriteMode: { enum: ['off', 'timestamp-jitter', 'creator', 'timestamp-jitter-and-creator'] },
        creatorName: { type: 'string', maxLength: 200 },
      },
    },
    naming: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keepOriginal: { type: 'boolean' },
        sanitizeAiTerms: { type: 'boolean' },
        prefix: { type: 'string', maxLength: 120 },
        suffix: { type: 'string', maxLength: 120 },
        findText: { type: 'string', maxLength: 120 },
        replaceText: { type: 'string', maxLength: 120 },
        sequential: { type: 'boolean' },
        sequentialStart: { type: 'integer', minimum: 0, maximum: 1000000 },
        template: { type: 'string', maxLength: 240 },
      },
    },
    export: {
      type: 'object',
      additionalProperties: false,
      properties: {
        destination: { enum: ['sibling', 'custom'] },
        customPath: { type: 'string' },
        siblingFolderName: { type: 'string', minLength: 1, maxLength: 120 },
        overwrite: { type: 'boolean' },
        openFolderWhenDone: { type: 'boolean' },
      },
    },
    backgroundRemoval: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', const: false },
      },
      description: 'Background removal is not available in the MCP v1 server.',
    },
  },
} as const;

type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};

type PlainRecord = Record<string, unknown>;

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

function isPlainRecord(value: unknown): value is PlainRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectUnknownKeys(
  obj: PlainRecord,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      errors.push(`${path}.${key} is not a supported setting`);
    }
  }
}

function getSection(
  settings: PlainRecord,
  key: string,
  allowedKeys: readonly string[],
  errors: string[],
): PlainRecord | undefined {
  const raw = settings[key];
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    errors.push(`${key} must be an object`);
    return undefined;
  }
  collectUnknownKeys(raw, allowedKeys, key, errors);
  return raw;
}

function enumValue<T extends string>(
  section: PlainRecord,
  key: string,
  allowed: readonly T[],
  path: string,
  errors: string[],
): T | undefined {
  const raw = section[key];
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  errors.push(`${path}.${key} must be one of: ${allowed.join(', ')}`);
  return undefined;
}

function boolValue(section: PlainRecord, key: string, path: string, errors: string[]): boolean | undefined {
  const raw = section[key];
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  errors.push(`${path}.${key} must be a boolean`);
  return undefined;
}

function stringValue(
  section: PlainRecord,
  key: string,
  path: string,
  errors: string[],
  options: { minLength?: number; maxLength?: number } = {},
): string | undefined {
  const raw = section[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    errors.push(`${path}.${key} must be a string`);
    return undefined;
  }
  if (options.minLength !== undefined && raw.length < options.minLength) {
    errors.push(`${path}.${key} must be at least ${options.minLength} character${options.minLength === 1 ? '' : 's'}`);
    return undefined;
  }
  if (options.maxLength !== undefined && raw.length > options.maxLength) {
    errors.push(`${path}.${key} must be at most ${options.maxLength} characters`);
    return undefined;
  }
  return raw;
}

function nullableStringValue(
  section: PlainRecord,
  key: string,
  path: string,
  errors: string[],
): string | null | undefined {
  const raw = section[key];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === 'string') return raw;
  errors.push(`${path}.${key} must be a string or null`);
  return undefined;
}

function numberValue(
  section: PlainRecord,
  key: string,
  path: string,
  min: number,
  max: number,
  integer: boolean,
  errors: string[],
): number | undefined {
  const raw = section[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push(`${path}.${key} must be a finite number`);
    return undefined;
  }
  if (integer && !Number.isInteger(raw)) {
    errors.push(`${path}.${key} must be an integer`);
    return undefined;
  }
  return Math.min(max, Math.max(min, raw));
}

function numberArrayValue(
  section: PlainRecord,
  key: string,
  path: string,
  min: number,
  max: number,
  errors: string[],
): number[] | undefined {
  const raw = section[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${path}.${key} must be an array of numbers`);
    return undefined;
  }
  if (raw.length > 24) {
    errors.push(`${path}.${key} must contain at most 24 items`);
    return undefined;
  }

  const values: number[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      errors.push(`${path}.${key}[${index}] must be a finite number`);
      return;
    }
    if (!Number.isInteger(item)) {
      errors.push(`${path}.${key}[${index}] must be an integer`);
      return;
    }
    values.push(Math.min(max, Math.max(min, item)));
  });
  return values;
}

export function applyCustomSettings(basePreset: AppPreset, customSettings: unknown): AppPreset {
  const preset = clonePreset(basePreset);
  if (customSettings === undefined || customSettings === null) return preset;
  if (!isPlainRecord(customSettings)) {
    throw new ImagePumaMcpError('SETTINGS_INVALID', 'customSettings must be an object.');
  }

  const errors: string[] = [];
  collectUnknownKeys(customSettings, [
    'output',
    'resize',
    'crop',
    'transform',
    'metadata',
    'naming',
    'export',
    'backgroundRemoval',
  ], 'customSettings', errors);

  const output = getSection(customSettings, 'output', [
    'format',
    'jpegQuality',
    'pngCompressionLevel',
    'webpQuality',
    'avifQuality',
    'lossless',
  ], errors);
  if (output) {
    preset.output.format = enumValue(output, 'format', OUTPUT_FORMATS, 'output', errors) ?? preset.output.format;
    preset.output.jpegQuality = numberValue(output, 'jpegQuality', 'output', 1, 100, true, errors) ?? preset.output.jpegQuality;
    preset.output.pngCompressionLevel = numberValue(output, 'pngCompressionLevel', 'output', 0, 9, true, errors) ?? preset.output.pngCompressionLevel;
    preset.output.webpQuality = numberValue(output, 'webpQuality', 'output', 1, 100, true, errors) ?? preset.output.webpQuality;
    preset.output.avifQuality = numberValue(output, 'avifQuality', 'output', 1, 100, true, errors) ?? preset.output.avifQuality;
    preset.output.lossless = boolValue(output, 'lossless', 'output', errors) ?? preset.output.lossless;
  }

  const resize = getSection(customSettings, 'resize', [
    'mode',
    'width',
    'height',
    'percent',
    'noUpscale',
    'responsiveWidths',
  ], errors);
  if (resize) {
    preset.resize.mode = enumValue(resize, 'mode', RESIZE_MODES, 'resize', errors) ?? preset.resize.mode;
    preset.resize.width = numberValue(resize, 'width', 'resize', 1, 20000, true, errors) ?? preset.resize.width;
    preset.resize.height = numberValue(resize, 'height', 'resize', 1, 20000, true, errors) ?? preset.resize.height;
    preset.resize.percent = numberValue(resize, 'percent', 'resize', 1, 1000, true, errors) ?? preset.resize.percent;
    preset.resize.noUpscale = boolValue(resize, 'noUpscale', 'resize', errors) ?? preset.resize.noUpscale;
    preset.resize.responsiveWidths = numberArrayValue(resize, 'responsiveWidths', 'resize', 1, 20000, errors)
      ?? preset.resize.responsiveWidths;
  }

  const crop = getSection(customSettings, 'crop', [
    'enabled',
    'x',
    'y',
    'width',
    'height',
    'aspectRatio',
    'aspectAnchor',
    'positionMode',
    'anchorInsideImage',
  ], errors);
  if (crop) {
    preset.crop.enabled = boolValue(crop, 'enabled', 'crop', errors) ?? preset.crop.enabled;
    preset.crop.x = numberValue(crop, 'x', 'crop', 0, 100, false, errors) ?? preset.crop.x;
    preset.crop.y = numberValue(crop, 'y', 'crop', 0, 100, false, errors) ?? preset.crop.y;
    preset.crop.width = numberValue(crop, 'width', 'crop', 1, 100, false, errors) ?? preset.crop.width;
    preset.crop.height = numberValue(crop, 'height', 'crop', 1, 100, false, errors) ?? preset.crop.height;
    const aspectRatio = nullableStringValue(crop, 'aspectRatio', 'crop', errors);
    if (aspectRatio !== undefined) preset.crop.aspectRatio = aspectRatio;
    preset.crop.aspectAnchor = enumValue(crop, 'aspectAnchor', ['top-left', 'top-right', 'bottom-left', 'bottom-right'], 'crop', errors)
      ?? preset.crop.aspectAnchor;
    preset.crop.positionMode = enumValue(crop, 'positionMode', ['xy', 'anchor'], 'crop', errors) ?? preset.crop.positionMode;
    preset.crop.anchorInsideImage = boolValue(crop, 'anchorInsideImage', 'crop', errors) ?? preset.crop.anchorInsideImage;
  }

  const transform = getSection(customSettings, 'transform', ['rotation', 'flipH', 'flipV'], errors);
  if (transform) {
    preset.transform.rotation = numberValue(transform, 'rotation', 'transform', -180, 180, true, errors) ?? preset.transform.rotation;
    preset.transform.flipH = boolValue(transform, 'flipH', 'transform', errors) ?? preset.transform.flipH;
    preset.transform.flipV = boolValue(transform, 'flipV', 'transform', errors) ?? preset.transform.flipV;
  }

  const metadata = getSection(customSettings, 'metadata', [
    'mode',
    'convertToSrgb',
    'syntheticMode',
    'rewriteMode',
    'creatorName',
  ], errors);
  if (metadata) {
    preset.metadata.mode = enumValue(metadata, 'mode', METADATA_MODES, 'metadata', errors) ?? preset.metadata.mode;
    preset.metadata.convertToSrgb = boolValue(metadata, 'convertToSrgb', 'metadata', errors) ?? preset.metadata.convertToSrgb;
    preset.metadata.syntheticMode = enumValue(metadata, 'syntheticMode', ['off', 'process'], 'metadata', errors) ?? preset.metadata.syntheticMode;
    preset.metadata.rewriteMode = enumValue(metadata, 'rewriteMode', ['off', 'timestamp-jitter', 'creator', 'timestamp-jitter-and-creator'], 'metadata', errors)
      ?? preset.metadata.rewriteMode;
    preset.metadata.creatorName = stringValue(metadata, 'creatorName', 'metadata', errors, { maxLength: 200 })
      ?? preset.metadata.creatorName;
  }

  const naming = getSection(customSettings, 'naming', [
    'keepOriginal',
    'sanitizeAiTerms',
    'prefix',
    'suffix',
    'findText',
    'replaceText',
    'sequential',
    'sequentialStart',
    'template',
  ], errors);
  if (naming) {
    preset.naming.keepOriginal = boolValue(naming, 'keepOriginal', 'naming', errors) ?? preset.naming.keepOriginal;
    preset.naming.sanitizeAiTerms = boolValue(naming, 'sanitizeAiTerms', 'naming', errors) ?? preset.naming.sanitizeAiTerms;
    preset.naming.prefix = stringValue(naming, 'prefix', 'naming', errors, { maxLength: 120 }) ?? preset.naming.prefix;
    preset.naming.suffix = stringValue(naming, 'suffix', 'naming', errors, { maxLength: 120 }) ?? preset.naming.suffix;
    preset.naming.findText = stringValue(naming, 'findText', 'naming', errors, { maxLength: 120 }) ?? preset.naming.findText;
    preset.naming.replaceText = stringValue(naming, 'replaceText', 'naming', errors, { maxLength: 120 })
      ?? preset.naming.replaceText;
    preset.naming.sequential = boolValue(naming, 'sequential', 'naming', errors) ?? preset.naming.sequential;
    preset.naming.sequentialStart = numberValue(naming, 'sequentialStart', 'naming', 0, 1000000, true, errors)
      ?? preset.naming.sequentialStart;
    preset.naming.template = stringValue(naming, 'template', 'naming', errors, { maxLength: 240 }) ?? preset.naming.template;
  }

  const exportSettings = getSection(customSettings, 'export', [
    'destination',
    'customPath',
    'siblingFolderName',
    'overwrite',
    'openFolderWhenDone',
  ], errors);
  if (exportSettings) {
    preset.export.destination = enumValue(exportSettings, 'destination', ['sibling', 'custom'], 'export', errors) ?? preset.export.destination;
    preset.export.customPath = stringValue(exportSettings, 'customPath', 'export', errors) ?? preset.export.customPath;
    preset.export.siblingFolderName = stringValue(exportSettings, 'siblingFolderName', 'export', errors, { minLength: 1, maxLength: 120 })
      ?? preset.export.siblingFolderName;
    preset.export.overwrite = boolValue(exportSettings, 'overwrite', 'export', errors) ?? preset.export.overwrite;
    preset.export.openFolderWhenDone = boolValue(exportSettings, 'openFolderWhenDone', 'export', errors) ?? preset.export.openFolderWhenDone;
  }

  const backgroundRemoval = getSection(customSettings, 'backgroundRemoval', ['enabled'], errors);
  if (backgroundRemoval) {
    const enabled = boolValue(backgroundRemoval, 'enabled', 'backgroundRemoval', errors);
    if (enabled) {
      errors.push('backgroundRemoval.enabled is not available in the MCP v1 server');
    }
  }

  if (errors.length > 0) {
    throw new ImagePumaMcpError('SETTINGS_INVALID', 'customSettings failed validation.', { errors });
  }

  return preset as Mutable<AppPreset>;
}
