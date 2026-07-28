import * as path from 'path';
import sharp from 'sharp';
import type { MetadataSettings } from '../shared/types';
import { isSyntheticImageProcessingEnabled } from '../shared/metadata-settings';

const KNOWN_AI_DIMENSIONS = new Set([
  '1536x1024',
  '1024x1536',
  '2656x1600',
  '1600x2656',
  '1232x928',
  '928x1232',
  '1024x1024',
  '1792x1024',
  '1024x1792',
  '2048x2048',
]);

const SYNTHETIC_SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const EDGE_CROP_PX = 16;
const GEMINI_WM_REF_DIM = 1600;
const GEMINI_WM_OFFSET_RATIO = 81 / GEMINI_WM_REF_DIM;
const GEMINI_WM_SIZE_RATIO = 58 / GEMINI_WM_REF_DIM;
const GEMINI_WM_CROP_RATIO = 0.061;
const GEMINI_WM_COLOR = { r: 0x82, g: 0x85, b: 0x92 };
const GEMINI_WM_COLOR_TOLERANCE = 25;

export interface SyntheticImageCleanupPlan {
  originalWidth: number;
  originalHeight: number;
  finalWidth: number;
  finalHeight: number;
  alphaRemoved: boolean;
  cropped: boolean;
  geminiWatermarkCropped: boolean;
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
}

function isKnownAiDimension(width: number, height: number): boolean {
  return KNOWN_AI_DIMENSIONS.has(`${width}x${height}`);
}

function isGeminiFilename(filePath: string): boolean {
  const stem = path.basename(filePath, path.extname(filePath));
  return /gemini/i.test(stem);
}

function geminiWatermarkMetrics(width: number, height: number): { offset: number; size: number; crop: number } {
  const referenceLength = Math.min(width, height);
  return {
    offset: Math.round(referenceLength * GEMINI_WM_OFFSET_RATIO),
    size: Math.round(referenceLength * GEMINI_WM_SIZE_RATIO),
    crop: Math.round(width * GEMINI_WM_CROP_RATIO),
  };
}

async function detectGeminiWatermark(imagePath: string, width: number, height: number): Promise<boolean> {
  const { offset, size } = geminiWatermarkMetrics(width, height);
  if (size < 10) return false;
  if (width <= offset + size || height <= offset + size) return false;

  try {
    const regionLeft = width - offset - size;
    const regionTop = height - offset - size;
    const { data, info } = await sharp(imagePath)
      .extract({
        left: regionLeft,
        top: regionTop,
        width: size,
        height: size,
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const centerX = Math.floor(size / 2);
    const centerY = Math.floor(size / 2);
    const { r, g, b } = GEMINI_WM_COLOR;
    let matches = 0;
    let total = 0;

    for (let x = 0; x < size; x++) {
      const index = (centerY * size + x) * info.channels;
      if (
        Math.abs(data[index] - r) <= GEMINI_WM_COLOR_TOLERANCE
        && Math.abs(data[index + 1] - g) <= GEMINI_WM_COLOR_TOLERANCE
        && Math.abs(data[index + 2] - b) <= GEMINI_WM_COLOR_TOLERANCE
      ) {
        matches++;
      }
      total++;
    }

    for (let y = 0; y < size; y++) {
      const index = (y * size + centerX) * info.channels;
      if (
        Math.abs(data[index] - r) <= GEMINI_WM_COLOR_TOLERANCE
        && Math.abs(data[index + 1] - g) <= GEMINI_WM_COLOR_TOLERANCE
        && Math.abs(data[index + 2] - b) <= GEMINI_WM_COLOR_TOLERANCE
      ) {
        matches++;
      }
      total++;
    }

    return total > 0 && matches / total > 0.25;
  } catch {
    return false;
  }
}

export async function buildSyntheticImageCleanupPlan(
  imagePath: string,
  metadata: sharp.Metadata,
  settings: MetadataSettings,
): Promise<SyntheticImageCleanupPlan | null> {
  if (!isSyntheticImageProcessingEnabled(settings)) return null;

  const extension = path.extname(imagePath).toLowerCase();
  if (!SYNTHETIC_SUPPORTED_EXTENSIONS.has(extension)) return null;

  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  if (originalWidth <= 0 || originalHeight <= 0) return null;

  const alphaRemoved = Boolean(metadata.hasAlpha) || metadata.channels === 4;
  const needsAiCrop = isKnownAiDimension(originalWidth, originalHeight);
  const hasGeminiWatermark = isGeminiFilename(imagePath)
    || await detectGeminiWatermark(imagePath, originalWidth, originalHeight);

  let cropLeft = needsAiCrop ? EDGE_CROP_PX : 0;
  let cropTop = needsAiCrop ? EDGE_CROP_PX : 0;
  let cropRight = needsAiCrop ? EDGE_CROP_PX : 0;
  let cropBottom = needsAiCrop ? EDGE_CROP_PX : 0;

  if (hasGeminiWatermark) {
    cropRight = Math.max(cropRight, geminiWatermarkMetrics(originalWidth, originalHeight).crop);
  }

  const totalCropX = cropLeft + cropRight;
  const totalCropY = cropTop + cropBottom;
  if (originalWidth <= totalCropX || originalHeight <= totalCropY) {
    cropLeft = 0;
    cropTop = 0;
    cropRight = 0;
    cropBottom = 0;
  }

  const cropped = cropLeft + cropTop + cropRight + cropBottom > 0;
  if (!alphaRemoved && !cropped) return null;

  return {
    originalWidth,
    originalHeight,
    finalWidth: cropped ? originalWidth - cropLeft - cropRight : originalWidth,
    finalHeight: cropped ? originalHeight - cropTop - cropBottom : originalHeight,
    alphaRemoved,
    cropped,
    geminiWatermarkCropped: hasGeminiWatermark && cropRight > 0,
    cropLeft,
    cropTop,
    cropRight,
    cropBottom,
  };
}

export function applySyntheticImageCleanup(
  pipeline: sharp.Sharp,
  plan: SyntheticImageCleanupPlan | null,
): sharp.Sharp {
  if (!plan) return pipeline;

  let nextPipeline = pipeline;
  if (plan.alphaRemoved) {
    nextPipeline = nextPipeline.removeAlpha();
  }
  if (plan.cropped) {
    nextPipeline = nextPipeline.extract({
      left: plan.cropLeft,
      top: plan.cropTop,
      width: plan.finalWidth,
      height: plan.finalHeight,
    });
  }
  return nextPipeline;
}
