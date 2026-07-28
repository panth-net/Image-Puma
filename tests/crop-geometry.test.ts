import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCropRectPx, resolveCropPercent } from '../src/core/shared/crop-geometry';
import { getTransformedDimensions } from '../src/core/shared/transform-geometry';
import type { CropSettings } from '../src/core/shared/types';

const fullFrameSquareCrop: CropSettings = {
  enabled: true,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  aspectRatio: '1:1',
  aspectAnchor: 'top-left',
  positionMode: 'xy',
};

function isPointInsideRotatedImage(
  point: { x: number; y: number },
  frame: { width: number; height: number },
  image: { width: number; height: number },
  rotation: number,
): boolean {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centeredX = point.x - (frame.width / 2);
  const centeredY = point.y - (frame.height / 2);
  const imageX = (cos * centeredX) + (sin * centeredY);
  const imageY = (-sin * centeredX) + (cos * centeredY);
  return Math.abs(imageX) <= (image.width / 2) + 0.001
    && Math.abs(imageY) <= (image.height / 2) + 0.001;
}

test('aspect ratio crop resolves a centered square from a full wide frame', () => {
  const resolved = resolveCropPercent(fullFrameSquareCrop, 1600, 800);
  assert.equal(resolved.x, 25);
  assert.equal(resolved.y, 0);
  assert.equal(resolved.width, 50);
  assert.equal(resolved.height, 100);

  const rect = computeCropRectPx(fullFrameSquareCrop, 1600, 800);
  assert.deepEqual(rect, {
    left: 400,
    top: 0,
    width: 800,
    height: 800,
    right: 1200,
    bottom: 800,
  });
});

test('aspect ratio crop resolves a centered square from a full tall frame', () => {
  const resolved = resolveCropPercent(fullFrameSquareCrop, 800, 1600);
  assert.equal(resolved.x, 0);
  assert.equal(resolved.y, 25);
  assert.equal(resolved.width, 100);
  assert.equal(resolved.height, 50);

  const rect = computeCropRectPx(fullFrameSquareCrop, 800, 1600);
  assert.deepEqual(rect, {
    left: 0,
    top: 400,
    width: 800,
    height: 800,
    right: 800,
    bottom: 1200,
  });
});

test('anchored crop can shift inside rotated image bounds', () => {
  const image = { width: 100, height: 60 };
  const rotation = 30;
  const frame = getTransformedDimensions(image.width, image.height, rotation);
  const crop: CropSettings = {
    enabled: true,
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    aspectRatio: null,
    aspectAnchor: 'top-left',
    positionMode: 'anchor',
    anchorInsideImage: true,
  };

  const resolved = resolveCropPercent(crop, frame.width, frame.height, {
    imageWidth: image.width,
    imageHeight: image.height,
    rotation,
  });

  assert.ok(resolved.x > 0);
  assert.ok(resolved.y > 0);

  const left = (resolved.x / 100) * frame.width;
  const top = (resolved.y / 100) * frame.height;
  const width = (resolved.width / 100) * frame.width;
  const height = (resolved.height / 100) * frame.height;

  for (const point of [
    { x: left, y: top },
    { x: left + width, y: top },
    { x: left + width, y: top + height },
    { x: left, y: top + height },
  ]) {
    assert.equal(isPointInsideRotatedImage(point, frame, image, rotation), true);
  }
});

test('anchored crop keeps legacy bounding-box anchor when inside-image option is off', () => {
  const image = { width: 100, height: 60 };
  const rotation = 30;
  const frame = getTransformedDimensions(image.width, image.height, rotation);
  const crop: CropSettings = {
    enabled: true,
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    aspectRatio: null,
    aspectAnchor: 'top-left',
    positionMode: 'anchor',
    anchorInsideImage: false,
  };

  const resolved = resolveCropPercent(crop, frame.width, frame.height, {
    imageWidth: image.width,
    imageHeight: image.height,
    rotation,
  });

  assert.equal(resolved.x, 0);
  assert.equal(resolved.y, 0);
});
