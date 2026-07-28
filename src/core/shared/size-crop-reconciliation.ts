import type { ResizeSettings } from './types';
import { parseCropAspectRatio } from './crop-geometry';

export type ResizeDimension = 'width' | 'height';

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.max(1, Math.round(value));
}

export function reconcileResizeToAspect(
  resize: ResizeSettings,
  aspectRatio: string | null,
  preferredDimension: ResizeDimension,
): ResizeSettings {
  const parsed = parseCropAspectRatio(aspectRatio);
  if (!parsed || resize.mode === 'none' || resize.mode === 'percent') return resize;

  const targetAspect = parsed.rw / parsed.rh;
  const width = positiveInteger(resize.width);
  const height = positiveInteger(resize.height);
  const next: ResizeSettings = {
    ...resize,
    responsiveWidths: Array.isArray(resize.responsiveWidths)
      ? [...resize.responsiveWidths]
      : [],
  };

  const preserveHeight = (preferredDimension === 'height' && height)
    || (!width && height)
    || resize.mode === 'height';

  if (preserveHeight && height) {
    next.height = height;
    next.width = Math.max(1, Math.round(height * targetAspect));
    return next;
  }

  if (width) {
    next.width = width;
    next.height = Math.max(1, Math.round(width / targetAspect));
  }

  return next;
}
