import type { CropSettings } from './types';

export interface CropRectPx {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface CropResolveOptions {
  imageWidth?: number;
  imageHeight?: number;
  rotation?: number;
}

interface Point {
  x: number;
  y: number;
}

interface HalfPlane {
  a: number;
  b: number;
  c: number;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parseCropAspectRatio(aspectRatio: string | null | undefined): { rw: number; rh: number } | null {
  if (!aspectRatio) return null;
  const parts = aspectRatio.split(':');
  if (parts.length !== 2) return null;
  const rw = Number(parts[0]);
  const rh = Number(parts[1]);
  if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) return null;
  return { rw, rh };
}

export function normalizeCropPercent(crop: Partial<CropSettings> | null | undefined): CropSettings {
  const source = crop || {};
  const width = clamp(toFiniteNumber(source.width, 100), 1, 100);
  const height = clamp(toFiniteNumber(source.height, 100), 1, 100);
  const maxX = Math.max(0, 100 - width);
  const maxY = Math.max(0, 100 - height);

  return {
    enabled: Boolean(source.enabled),
    x: clamp(toFiniteNumber(source.x, 0), 0, maxX),
    y: clamp(toFiniteNumber(source.y, 0), 0, maxY),
    width,
    height,
    aspectRatio: typeof source.aspectRatio === 'string' && source.aspectRatio.length > 0
      ? source.aspectRatio
      : null,
    aspectAnchor: source.aspectAnchor === 'top-right'
      || source.aspectAnchor === 'bottom-left'
      || source.aspectAnchor === 'bottom-right'
      ? source.aspectAnchor
      : 'top-left',
    positionMode: source.positionMode === 'anchor' ? 'anchor' : 'xy',
    anchorInsideImage: Boolean(source.anchorInsideImage),
  };
}

function clipPolygonByHalfPlane(polygon: Point[], halfPlane: HalfPlane): Point[] {
  if (polygon.length === 0) return [];

  const epsilon = 0.000001;
  const nextPolygon: Point[] = [];
  const isInside = (point: Point) => (
    (halfPlane.a * point.x) + (halfPlane.b * point.y) <= halfPlane.c + epsilon
  );
  const intersection = (start: Point, end: Point): Point => {
    const startValue = (halfPlane.a * start.x) + (halfPlane.b * start.y) - halfPlane.c;
    const endValue = (halfPlane.a * end.x) + (halfPlane.b * end.y) - halfPlane.c;
    const denominator = startValue - endValue;
    const t = Math.abs(denominator) <= epsilon ? 0 : startValue / denominator;
    return {
      x: start.x + ((end.x - start.x) * t),
      y: start.y + ((end.y - start.y) * t),
    };
  };

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentInside = isInside(current);
    const previousInside = isInside(previous);

    if (currentInside) {
      if (!previousInside) nextPolygon.push(intersection(previous, current));
      nextPolygon.push(current);
    } else if (previousInside) {
      nextPolygon.push(intersection(previous, current));
    }
  }

  return nextPolygon;
}

function closestPointOnSegment(point: Point, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 0.000001) return start;

  const t = clamp(
    (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared,
    0,
    1,
  );
  return {
    x: start.x + (dx * t),
    y: start.y + (dy * t),
  };
}

function isPointInPolygon(point: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects = ((pi.y > point.y) !== (pj.y > point.y))
      && point.x < (((pj.x - pi.x) * (point.y - pi.y)) / ((pj.y - pi.y) || 1)) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function closestPointInPolygon(point: Point, polygon: Point[]): Point | null {
  if (polygon.length === 0) return null;
  if (isPointInPolygon(point, polygon)) return point;

  let best = polygon[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  const consider = (candidate: Point) => {
    const dx = candidate.x - point.x;
    const dy = candidate.y - point.y;
    const distance = (dx * dx) + (dy * dy);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  };

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    consider(start);
    consider(closestPointOnSegment(point, start, end));
  }

  return best;
}

function buildFeasibleCropPositionPolygon(
  sourceWidth: number,
  sourceHeight: number,
  cropWidth: number,
  cropHeight: number,
  options: CropResolveOptions,
): Point[] {
  const imageWidth = Math.max(1, toFiniteNumber(options.imageWidth, sourceWidth));
  const imageHeight = Math.max(1, toFiniteNumber(options.imageHeight, sourceHeight));
  const rotation = toFiniteNumber(options.rotation, 0);
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = sourceWidth / 2;
  const centerY = sourceHeight / 2;
  const halfImageWidth = imageWidth / 2;
  const halfImageHeight = imageHeight / 2;
  const maxX = Math.max(0, sourceWidth - cropWidth);
  const maxY = Math.max(0, sourceHeight - cropHeight);
  const cropCorners = [
    { dx: 0, dy: 0 },
    { dx: cropWidth, dy: 0 },
    { dx: cropWidth, dy: cropHeight },
    { dx: 0, dy: cropHeight },
  ];

  let polygon: Point[] = [
    { x: 0, y: 0 },
    { x: maxX, y: 0 },
    { x: maxX, y: maxY },
    { x: 0, y: maxY },
  ];

  for (const corner of cropCorners) {
    const cornerX = corner.dx - centerX;
    const cornerY = corner.dy - centerY;
    const constraints: HalfPlane[] = [
      {
        a: cos,
        b: sin,
        c: halfImageWidth - (cos * cornerX) - (sin * cornerY),
      },
      {
        a: -cos,
        b: -sin,
        c: halfImageWidth + (cos * cornerX) + (sin * cornerY),
      },
      {
        a: -sin,
        b: cos,
        c: halfImageHeight + (sin * cornerX) - (cos * cornerY),
      },
      {
        a: sin,
        b: -cos,
        c: halfImageHeight - (sin * cornerX) + (cos * cornerY),
      },
    ];

    for (const constraint of constraints) {
      polygon = clipPolygonByHalfPlane(polygon, constraint);
      if (polygon.length === 0) return [];
    }
  }

  return polygon;
}

function getAnchorPoint(
  crop: CropSettings,
  sourceWidth: number,
  sourceHeight: number,
): Point {
  const cropWidth = (crop.width / 100) * sourceWidth;
  const cropHeight = (crop.height / 100) * sourceHeight;
  const maxX = Math.max(0, sourceWidth - cropWidth);
  const maxY = Math.max(0, sourceHeight - cropHeight);

  if (crop.aspectAnchor === 'top-right') return { x: maxX, y: 0 };
  if (crop.aspectAnchor === 'bottom-left') return { x: 0, y: maxY };
  if (crop.aspectAnchor === 'bottom-right') return { x: maxX, y: maxY };
  return { x: 0, y: 0 };
}

function resolveAnchoredCropInsideImage(
  crop: CropSettings,
  sourceWidth: number,
  sourceHeight: number,
  options: CropResolveOptions,
): CropSettings {
  if (!crop.anchorInsideImage || crop.positionMode !== 'anchor') return crop;

  const safeSourceWidth = Math.max(1, toFiniteNumber(sourceWidth, 0));
  const safeSourceHeight = Math.max(1, toFiniteNumber(sourceHeight, 0));
  const desiredAnchor = getAnchorPoint(crop, safeSourceWidth, safeSourceHeight);
  const initialCropWidth = Math.max(1, (crop.width / 100) * safeSourceWidth);
  const initialCropHeight = Math.max(1, (crop.height / 100) * safeSourceHeight);
  const minimumScale = Math.max(
    1 / initialCropWidth,
    1 / initialCropHeight,
  );

  let scale = 1;
  let polygon = buildFeasibleCropPositionPolygon(
    safeSourceWidth,
    safeSourceHeight,
    initialCropWidth,
    initialCropHeight,
    options,
  );

  if (polygon.length === 0) {
    let low = minimumScale;
    let high = 1;
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const mid = (low + high) / 2;
      const candidate = buildFeasibleCropPositionPolygon(
        safeSourceWidth,
        safeSourceHeight,
        initialCropWidth * mid,
        initialCropHeight * mid,
        options,
      );
      if (candidate.length > 0) {
        low = mid;
        polygon = candidate;
      } else {
        high = mid;
      }
    }
    scale = low;
  }

  if (polygon.length === 0) return crop;

  const adjustedCropWidth = initialCropWidth * scale;
  const adjustedCropHeight = initialCropHeight * scale;
  const adjustedAnchor = {
    x: clamp(desiredAnchor.x, 0, Math.max(0, safeSourceWidth - adjustedCropWidth)),
    y: clamp(desiredAnchor.y, 0, Math.max(0, safeSourceHeight - adjustedCropHeight)),
  };
  const position = closestPointInPolygon(adjustedAnchor, polygon);
  if (!position) return crop;

  return normalizeCropPercent({
    ...crop,
    x: (position.x / safeSourceWidth) * 100,
    y: (position.y / safeSourceHeight) * 100,
    width: (adjustedCropWidth / safeSourceWidth) * 100,
    height: (adjustedCropHeight / safeSourceHeight) * 100,
  });
}

export function resolveCropPercent(
  crop: Partial<CropSettings> | null | undefined,
  sourceWidth: number,
  sourceHeight: number,
  options: CropResolveOptions = {},
): CropSettings {
  const normalized = normalizeCropPercent(crop);
  const parsed = parseCropAspectRatio(normalized.aspectRatio);
  if (!parsed) {
    return resolveAnchoredCropInsideImage(normalized, sourceWidth, sourceHeight, options);
  }

  const width = Math.max(1, toFiniteNumber(sourceWidth, 0));
  const height = Math.max(1, toFiniteNumber(sourceHeight, 0));
  const sourceAspect = width / height;
  const targetAspect = parsed.rw / parsed.rh;

  let resolvedWidth = normalized.width;
  let resolvedHeight = (resolvedWidth * sourceAspect) / targetAspect;

  if (resolvedHeight > normalized.height) {
    resolvedHeight = normalized.height;
    resolvedWidth = (resolvedHeight * targetAspect) / sourceAspect;
  }

  resolvedWidth = clamp(resolvedWidth, 1, normalized.width);
  resolvedHeight = clamp(resolvedHeight, 1, normalized.height);

  const remainingX = Math.max(0, normalized.width - resolvedWidth);
  const remainingY = Math.max(0, normalized.height - resolvedHeight);
  let x = normalized.x + (remainingX / 2);
  let y = normalized.y + (remainingY / 2);

  if (normalized.positionMode === 'anchor') {
    x = normalized.x;
    y = normalized.y;
    if (normalized.aspectAnchor === 'top-right' || normalized.aspectAnchor === 'bottom-right') {
      x = normalized.x + remainingX;
    }
    if (normalized.aspectAnchor === 'bottom-left' || normalized.aspectAnchor === 'bottom-right') {
      y = normalized.y + remainingY;
    }
  }

  const resolved = normalizeCropPercent({
    ...normalized,
    x,
    y,
    width: resolvedWidth,
    height: resolvedHeight,
  });

  return resolveAnchoredCropInsideImage(resolved, width, height, options);
}

function clampCropRectPx(rect: CropRectPx, sourceWidth: number, sourceHeight: number): CropRectPx {
  const width = Math.max(1, Math.floor(toFiniteNumber(sourceWidth, 0)));
  const height = Math.max(1, Math.floor(toFiniteNumber(sourceHeight, 0)));

  let left = Math.floor(toFiniteNumber(rect.left, 0));
  let top = Math.floor(toFiniteNumber(rect.top, 0));
  let right = Math.ceil(toFiniteNumber(rect.right, width));
  let bottom = Math.ceil(toFiniteNumber(rect.bottom, height));

  left = clamp(left, 0, width - 1);
  top = clamp(top, 0, height - 1);
  right = clamp(right, left + 1, width);
  bottom = clamp(bottom, top + 1, height);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    right,
    bottom,
  };
}

export function computeCropRectPx(
  crop: Partial<CropSettings> | null | undefined,
  sourceWidth: number,
  sourceHeight: number,
  options: CropResolveOptions = {},
): CropRectPx | null {
  const width = Math.max(1, Math.floor(toFiniteNumber(sourceWidth, 0)));
  const height = Math.max(1, Math.floor(toFiniteNumber(sourceHeight, 0)));
  const normalized = resolveCropPercent(crop, width, height, options);

  if (!normalized.enabled) return null;

  const left = Math.floor((normalized.x / 100) * width);
  const top = Math.floor((normalized.y / 100) * height);
  const right = Math.ceil(((normalized.x + normalized.width) / 100) * width);
  const bottom = Math.ceil(((normalized.y + normalized.height) / 100) * height);

  return clampCropRectPx(
    {
      left,
      top,
      right,
      bottom,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    },
    width,
    height,
  );
}
