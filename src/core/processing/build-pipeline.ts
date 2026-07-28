import sharp from 'sharp';
import {
  AppPreset,
  InputFile,
  OutputFormat,
  TransformSettings,
} from '../shared/types';
import { computeCropRectPx } from '../shared/crop-geometry';
import {
  getTransformedDimensions,
} from '../shared/transform-geometry';
import {
  applySyntheticImageCleanup,
  type SyntheticImageCleanupPlan,
} from './synthetic-cleaning';
import type { ImageProcessingLimits } from './processing-limits';
import { applySharpTimeout, normalizeImageProcessingLimits } from './processing-limits';
import { isIconOutputFormat } from './icon-containers';

type PipelineMode = 'preview' | 'final';
const SUPPORTED_OUTPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'ico', 'icns']);

export function applyImageTransform(
  pipeline: sharp.Sharp,
  transform: TransformSettings,
): sharp.Sharp {
  const t = transform;
  const sharpRotation = t.flipH === t.flipV ? t.rotation : -t.rotation;

  if (sharpRotation !== 0) {
    pipeline = pipeline.rotate(sharpRotation, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }

  // Sharp applies flip/flop before arbitrary rotation. Negating the rotation
  // when exactly one flip is active makes flip controls mirror the rotated
  // output the user sees, not the source image axes.
  if (t.flipH) {
    pipeline = pipeline.flop();
  }
  if (t.flipV) {
    pipeline = pipeline.flip();
  }

  return pipeline;
}

export function applyVisualEdits(
  pipeline: sharp.Sharp,
  preset: AppPreset,
  metadata?: sharp.Metadata,
  syntheticPlan: SyntheticImageCleanupPlan | null = null,
): sharp.Sharp {
  pipeline = applySyntheticImageCleanup(pipeline, syntheticPlan);

  const origW = syntheticPlan?.finalWidth || metadata?.width || 0;
  const origH = syntheticPlan?.finalHeight || metadata?.height || 0;
  const t = preset.transform;
  pipeline = applyImageTransform(pipeline, t);

  const transformed = getTransformedDimensions(origW, origH, t.rotation);
  let cropRect: ReturnType<typeof computeCropRectPx> = null;
  if (preset.crop.enabled && origW > 0 && origH > 0) {
    cropRect = computeCropRectPx(preset.crop, transformed.width, transformed.height, {
      imageWidth: origW,
      imageHeight: origH,
      rotation: t.rotation,
    });
    if (cropRect) {
      pipeline = pipeline.extract({
        left: cropRect.left,
        top: cropRect.top,
        width: cropRect.width,
        height: cropRect.height,
      });
    }
  }

  const r = preset.resize;
  if (r.mode !== 'none') {
    const resizeOpts: sharp.ResizeOptions = {
      withoutEnlargement: r.noUpscale,
    };

    switch (r.mode) {
      case 'width':
        resizeOpts.width = r.width;
        resizeOpts.fit = 'inside';
        break;
      case 'height':
        resizeOpts.height = r.height;
        resizeOpts.fit = 'inside';
        break;
      case 'fit-box':
        resizeOpts.width = r.width;
        resizeOpts.height = r.height;
        resizeOpts.fit = 'inside';
        break;
      case 'exact':
        resizeOpts.width = r.width;
        resizeOpts.height = r.height;
        resizeOpts.fit = 'fill';
        break;
      case 'percent':
        if (r.percent) {
          const percentBaseW = cropRect ? cropRect.width : transformed.width;
          const percentBaseH = cropRect ? cropRect.height : transformed.height;
          if (percentBaseW > 0 && percentBaseH > 0) {
            resizeOpts.width = Math.round(percentBaseW * (r.percent / 100));
            resizeOpts.height = Math.round(percentBaseH * (r.percent / 100));
          }
          resizeOpts.fit = 'fill';
        }
        break;
    }

    if (resizeOpts.width || resizeOpts.height) {
      pipeline = pipeline.resize(resizeOpts);
    }
  }

  if (preset.metadata.convertToSrgb) {
    pipeline = pipeline.toColorspace('srgb');
  }

  return pipeline;
}

export function buildPipeline(
  file: InputFile,
  preset: AppPreset,
  _mode: PipelineMode,
  metadata?: sharp.Metadata,
  syntheticPlan: SyntheticImageCleanupPlan | null = null,
  sourcePath = file.sourcePath,
  processingLimits?: ImageProcessingLimits,
): sharp.Sharp {
  const limits = normalizeImageProcessingLimits(processingLimits);
  let pipeline = applySharpTimeout(
    sharp(sourcePath, { limitInputPixels: limits.limitInputPixels }),
    limits,
  ).rotate(); // auto-orient first

  // ── Transform ────────────────────────────────────────
  pipeline = applyVisualEdits(pipeline, preset, metadata, syntheticPlan);

  // ── Metadata / Color profile ─────────────────────────
  const meta = preset.metadata;
  const format = resolveFormat(preset.output.format, file.extension);

  // ICO/ICNS containers have no cross-platform metadata contract, so their
  // embedded PNG representations intentionally use Sharp's stripped default.
  if (!isIconOutputFormat(format)) {
    switch (meta.mode) {
      case 'keep-all':
        pipeline = pipeline.keepMetadata();
        break;
      case 'keep-exif':
        pipeline = pipeline.keepExif();
        break;
      case 'keep-icc':
        pipeline = pipeline.keepIccProfile();
        break;
      case 'keep-xmp':
        // Older Sharp builds may not expose keepXmp in typings.
        if (typeof (pipeline as unknown as { keepXmp?: () => sharp.Sharp }).keepXmp === 'function') {
          pipeline = (pipeline as unknown as { keepXmp: () => sharp.Sharp }).keepXmp();
        } else {
          pipeline = pipeline.keepMetadata();
        }
        break;
      case 'strip-privacy-smart':
        // Strict privacy strip: Sharp drops metadata and re-adds only the ICC profile.
        pipeline = pipeline.keepIccProfile();
        break;
      case 'strip-gps-only':
        // Selective cleanup runs after export through ExifTool.
        pipeline = pipeline.keepExif().keepIccProfile();
        break;
      case 'strip-all':
      default:
        // Sharp strips by default
        break;
    }
  }

  // ── Output format ────────────────────────────────────
  const o = preset.output;

  switch (format) {
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality: o.jpegQuality, mozjpeg: true });
      break;
    case 'png':
      pipeline = pipeline.png({ compressionLevel: o.pngCompressionLevel });
      break;
    case 'webp':
      pipeline = pipeline.webp({
        quality: o.webpQuality,
        lossless: o.lossless,
      });
      break;
    case 'avif':
      pipeline = pipeline.avif({
        quality: o.avifQuality,
        lossless: o.lossless,
      });
      break;
    case 'tiff':
      pipeline = pipeline.tiff({ quality: o.jpegQuality });
      break;
  }

  return pipeline;
}

function resolveFormat(format: OutputFormat, originalExt: string): string {
  if (format === 'keep-original') {
    const ext = originalExt.toLowerCase().replace('.', '');
    if (ext === 'jpg') return 'jpeg';
    if (ext === 'tif') return 'tiff';
    return SUPPORTED_OUTPUT_FORMATS.has(ext) ? ext : 'jpeg';
  }
  return SUPPORTED_OUTPUT_FORMATS.has(format) ? format : 'jpeg';
}

export function getResolvedFormat(format: OutputFormat, originalExt: string): string {
  return resolveFormat(format, originalExt);
}
