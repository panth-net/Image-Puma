import type sharp from 'sharp';

export interface ImageProcessingLimits {
  limitInputPixels?: number | boolean;
  timeoutSeconds?: number;
}

export interface NormalizedImageProcessingLimits {
  limitInputPixels: number | boolean;
  timeoutSeconds: number;
}

export const DEFAULT_IMAGE_PROCESSING_LIMITS: NormalizedImageProcessingLimits = {
  limitInputPixels: 100_000_000,
  timeoutSeconds: 120,
};

export function normalizeImageProcessingLimits(
  limits: ImageProcessingLimits = {},
): NormalizedImageProcessingLimits {
  const requestedLimit = limits.limitInputPixels ?? DEFAULT_IMAGE_PROCESSING_LIMITS.limitInputPixels;
  const requestedTimeout = limits.timeoutSeconds ?? DEFAULT_IMAGE_PROCESSING_LIMITS.timeoutSeconds;

  return {
    limitInputPixels: requestedLimit,
    timeoutSeconds: Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.floor(requestedTimeout)
      : 0,
  };
}

export function applySharpTimeout(
  pipeline: sharp.Sharp,
  limits: NormalizedImageProcessingLimits,
): sharp.Sharp {
  if (limits.timeoutSeconds <= 0) return pipeline;
  return pipeline.timeout({ seconds: limits.timeoutSeconds });
}
