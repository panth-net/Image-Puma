import * as fsp from 'fs/promises';
import sharp from 'sharp';
import { InputFile, AppPreset, PreviewResult } from '../shared/types';
import {
  doesPresetChangeImageBytesForFile,
  normalizeImageFormatName,
} from '../shared/recipe-helpers';
import {
  isMetadataRewriteEnabled,
  isSyntheticImageProcessingEnabled,
  metadataRewriteUsesCreator,
  metadataRewriteUsesTimestamp,
} from '../shared/metadata-settings';
import {
  applyImageTransform,
  applyVisualEdits,
  buildPipeline,
  getResolvedFormat,
} from './build-pipeline';
import { buildSyntheticImageCleanupPlan } from './synthetic-cleaning';
import { prepareSharpInput } from '../files/prepare-sharp-input';
import { isIconOutputFormat, renderIconContainer } from './icon-containers';

function getPreviewMimeType(format: string): string {
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  if (format === 'avif') return 'image/avif';
  return 'image/jpeg';
}

interface RenderedPreviewLayer {
  dataUrl: string;
  width?: number;
  height?: number;
}

/**
 * The "before" and compare-base renders depend only on the source (and, for the
 * compare base, the visual edits) — not on quality settings. Recomputing them on
 * every slider tick meant a full decode, 2400px resize and re-encode per keypress,
 * so they are memoised here. Entries hold multi-megabyte base64 strings, hence
 * the tight bound.
 */
const PREVIEW_LAYER_CACHE_MAX_ENTRIES = 8;
const previewLayerCache = new Map<string, RenderedPreviewLayer>();

function readPreviewLayer(key: string): RenderedPreviewLayer | null {
  const cached = previewLayerCache.get(key);
  if (!cached) return null;
  previewLayerCache.delete(key);
  previewLayerCache.set(key, cached);
  return cached;
}

function writePreviewLayer(key: string, layer: RenderedPreviewLayer): RenderedPreviewLayer {
  previewLayerCache.delete(key);
  previewLayerCache.set(key, layer);
  while (previewLayerCache.size > PREVIEW_LAYER_CACHE_MAX_ENTRIES) {
    const oldest = previewLayerCache.keys().next().value;
    if (oldest === undefined) break;
    previewLayerCache.delete(oldest);
  }
  return layer;
}

async function cachedPreviewLayer(
  key: string,
  render: () => Promise<RenderedPreviewLayer>,
): Promise<RenderedPreviewLayer> {
  const cached = readPreviewLayer(key);
  if (cached) return cached;
  return writePreviewLayer(key, await render());
}

/** Identity of the bytes on disk, so an edited source never serves a stale layer. */
async function getSourceRevision(filePath: string): Promise<string> {
  try {
    const stats = await fsp.stat(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return 'unknown';
  }
}

function toDataUrl(result: { data: Buffer; info: sharp.OutputInfo }): RenderedPreviewLayer {
  return {
    dataUrl: `data:${getPreviewMimeType(result.info.format)};base64,${result.data.toString('base64')}`,
    width: result.info.width,
    height: result.info.height,
  };
}

export function clearPreviewLayerCache(): void {
  previewLayerCache.clear();
}

function shouldUsePngCompareBase(preset: AppPreset, metadata: sharp.Metadata): boolean {
  const normalizedRotation = Math.abs(((preset.transform.rotation % 90) + 90) % 90);
  return Boolean(metadata.hasAlpha) || normalizedRotation > 0.0001;
}

export async function generatePreview(
  file: InputFile,
  preset: AppPreset,
): Promise<PreviewResult> {
  const resolvedOutputFormat = getResolvedFormat(preset.output.format, file.extension);
  const preparedInput = await prepareSharpInput(file.sourcePath, { probeDecode: true });

  try {
    const sourcePath = preparedInput.path;
    const meta = preparedInput.metadata;
    const warnings: string[] = [];

    if (preparedInput.usedNativeFallback) {
      warnings.push('Decoded with macOS ImageIO before compression');
    }
    if (meta.hasAlpha && resolvedOutputFormat === 'jpeg') {
      warnings.push('Transparency will be lost converting to JPEG');
    }
    if (preset.metadata.mode === 'strip-privacy-smart') {
      warnings.push('Privacy-safe mode removes EXIF/XMP/IPTC while keeping color profile (ICC)');
    }
    if (preset.metadata.mode === 'strip-gps-only') {
      warnings.push('Best-effort ExifTool cleanup removes GPS/device fields; other EXIF remains');
    }
    if (preset.output.format === 'keep-original') {
      const normalizedInput = normalizeImageFormatName(file.extension);
      if (normalizedInput !== resolvedOutputFormat) {
        warnings.push(`Original format ".${normalizedInput}" is not exportable; output will use ${resolvedOutputFormat.toUpperCase()}`);
      }
    }
    if (preset.metadata.convertToSrgb && meta.space && meta.space !== 'srgb') {
      warnings.push(`Color profile will be converted from ${meta.space} to sRGB`);
    }
    if (isSyntheticImageProcessingEnabled(preset.metadata)) {
      warnings.push('Synthetic cleanup may remove alpha, crop AI edge artifacts, or crop a detected Gemini watermark');
    }
    if (isMetadataRewriteEnabled(preset.metadata)) {
      const rewriteParts: string[] = [];
      if (metadataRewriteUsesTimestamp(preset.metadata)) rewriteParts.push('timestamps');
      if (metadataRewriteUsesCreator(preset.metadata)) rewriteParts.push('creator');
      warnings.push(`Metadata rewrite will update ${rewriteParts.join(' and ')}`);
    }
    if (isIconOutputFormat(resolvedOutputFormat)) {
      warnings.push(`${resolvedOutputFormat.toUpperCase()} export creates a centered, square multi-size icon`);
    }

    const syntheticPlan = await buildSyntheticImageCleanupPlan(sourcePath, meta, preset.metadata);
    const sourceKey = `${file.sourcePath}::${await getSourceRevision(file.sourcePath)}`;

    // Independent of every output setting, so it survives quality/format edits.
    const originalLayer = await cachedPreviewLayer(`original::${sourceKey}`, async () => {
      const originalPreviewPipeline = sharp(sourcePath)
        .rotate()
        .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true });

      return toDataUrl(meta.hasAlpha
        ? await originalPreviewPipeline.png().toBuffer({ resolveWithObject: true })
        : await originalPreviewPipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true }));
    });
    const originalDataUrl = originalLayer.dataUrl;

    const transformActive = preset.transform.rotation !== 0
      || preset.transform.flipH
      || preset.transform.flipV;
    const cropBaseLayer = transformActive
      ? await cachedPreviewLayer(
        `crop-base::${sourceKey}::${JSON.stringify(preset.transform)}`,
        async () => toDataUrl(await applyImageTransform(sharp(sourcePath).rotate(), preset.transform)
          .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer({ resolveWithObject: true })),
      )
      : null;
    const cropBaseDataUrl = cropBaseLayer?.dataUrl;

    const imageBytesChanged = doesPresetChangeImageBytesForFile(file, preset, resolvedOutputFormat);
    const compareBaseLayer = imageBytesChanged
      ? await cachedPreviewLayer(
        `compare-base::${sourceKey}::${JSON.stringify({
          transform: preset.transform,
          crop: preset.crop,
          resize: preset.resize,
          metadata: preset.metadata,
        })}`,
        async () => {
          const compareBasePipeline = applyVisualEdits(sharp(sourcePath).rotate(), preset, meta);
          return toDataUrl(shouldUsePngCompareBase(preset, meta)
            ? await compareBasePipeline.png().toBuffer({ resolveWithObject: true })
            : await compareBasePipeline.jpeg({ quality: 98, mozjpeg: true }).toBuffer({ resolveWithObject: true }));
        },
      )
      : null;
    const compareBaseDataUrl = compareBaseLayer?.dataUrl;

    if (!imageBytesChanged) {
      return {
        dataUrl: originalDataUrl,
        originalDataUrl,
        outputWidth: meta.width || 0,
        outputHeight: meta.height || 0,
        outputFormat: resolvedOutputFormat,
        outputSize: file.fileSize,
        originalWidth: meta.width || 0,
        originalHeight: meta.height || 0,
        originalSize: file.fileSize,
        warnings,
        cropBaseDataUrl,
        cropBaseWidth: cropBaseLayer?.width,
        cropBaseHeight: cropBaseLayer?.height,
        compareBaseDataUrl,
        compareBaseWidth: compareBaseLayer?.width,
        compareBaseHeight: compareBaseLayer?.height,
      };
    }

    const pipeline = buildPipeline(file, preset, 'preview', meta, syntheticPlan, sourcePath);
    if (isIconOutputFormat(resolvedOutputFormat)) {
      const icon = await renderIconContainer(
        pipeline,
        resolvedOutputFormat,
        preset.output.pngCompressionLevel,
      );
      if (icon.data.length > file.fileSize) {
        warnings.push('Output is larger than input!');
      }
      return {
        dataUrl: `data:image/png;base64,${icon.previewPng.toString('base64')}`,
        originalDataUrl,
        outputWidth: icon.width,
        outputHeight: icon.height,
        outputFormat: resolvedOutputFormat,
        outputSize: icon.data.length,
        originalWidth: meta.width || 0,
        originalHeight: meta.height || 0,
        originalSize: file.fileSize,
        warnings,
        cropBaseDataUrl,
        cropBaseWidth: cropBaseLayer?.width,
        cropBaseHeight: cropBaseLayer?.height,
        compareBaseDataUrl,
        compareBaseWidth: compareBaseLayer?.width,
        compareBaseHeight: compareBaseLayer?.height,
      };
    }
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    if (data.length > file.fileSize) {
      warnings.push('Output is larger than input!');
    }

    const base64 = data.toString('base64');
    const mimeType = getPreviewMimeType(info.format);

    return {
      dataUrl: `data:${mimeType};base64,${base64}`,
      originalDataUrl,
      outputWidth: info.width,
      outputHeight: info.height,
      outputFormat: info.format,
      outputSize: data.length,
      originalWidth: meta.width || 0,
      originalHeight: meta.height || 0,
      originalSize: file.fileSize,
      warnings,
      cropBaseDataUrl,
      cropBaseWidth: cropBaseLayer?.width,
      cropBaseHeight: cropBaseLayer?.height,
      compareBaseDataUrl,
      compareBaseWidth: compareBaseLayer?.width,
      compareBaseHeight: compareBaseLayer?.height,
    };
  } finally {
    await preparedInput.dispose();
  }
}

export async function generateThumbnail(filePath: string): Promise<string> {
  const preparedInput = await prepareSharpInput(filePath, { probeDecode: true });
  try {
    const { data } = await sharp(preparedInput.path)
      .rotate()
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });

    return `data:image/jpeg;base64,${data.toString('base64')}`;
  } finally {
    await preparedInput.dispose();
  }
}
