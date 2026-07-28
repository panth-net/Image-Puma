import type { TransformSettings } from './types';

export function getTransformedDimensions(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const radians = ((rotation || 0) * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));

  return {
    width: Math.max(1, Math.round((safeWidth * absCos) + (safeHeight * absSin))),
    height: Math.max(1, Math.round((safeWidth * absSin) + (safeHeight * absCos))),
  };
}

export function getTransformAdjustedAspect(
  width: number,
  height: number,
  transform: Pick<TransformSettings, 'rotation'>,
): number {
  if (width <= 0 || height <= 0) return 1;
  const transformed = getTransformedDimensions(width, height, transform.rotation);
  return transformed.width / transformed.height;
}

export function isSidewaysRightAngle(rotation: number): boolean {
  const normalized = ((rotation % 180) + 180) % 180;
  return Math.abs(normalized - 90) < 0.0001;
}
