import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResizeSettings } from '../src/core/shared/types';
import { reconcileResizeToAspect } from '../src/core/shared/size-crop-reconciliation';

function makeResize(overrides: Partial<ResizeSettings>): ResizeSettings {
  return {
    mode: 'fit-box',
    width: undefined,
    height: undefined,
    percent: undefined,
    noUpscale: true,
    responsiveWidths: [],
    ...overrides,
  };
}

test('reconcileResizeToAspect derives height from the edited width', () => {
  const resize = makeResize({
    mode: 'fit-box',
    width: 1200,
    height: 800,
  });

  const next = reconcileResizeToAspect(resize, '1:1', 'width');

  assert.equal(next.width, 1200);
  assert.equal(next.height, 1200);
});

test('reconcileResizeToAspect derives width from the edited height', () => {
  const resize = makeResize({
    mode: 'fit-box',
    width: 1200,
    height: 600,
  });

  const next = reconcileResizeToAspect(resize, '16:9', 'height');

  assert.equal(next.width, 1067);
  assert.equal(next.height, 600);
});

test('reconcileResizeToAspect preserves one-axis resize modes', () => {
  const widthOnly = reconcileResizeToAspect(
    makeResize({ mode: 'width', width: 900 }),
    '1:1',
    'width',
  );
  const heightOnly = reconcileResizeToAspect(
    makeResize({ mode: 'height', height: 500 }),
    '4:5',
    'height',
  );

  assert.equal(widthOnly.mode, 'width');
  assert.equal(widthOnly.width, 900);
  assert.equal(widthOnly.height, 900);
  assert.equal(heightOnly.mode, 'height');
  assert.equal(heightOnly.width, 400);
  assert.equal(heightOnly.height, 500);
});

test('reconcileResizeToAspect leaves non-dimensional resize modes unchanged', () => {
  const percentResize = makeResize({ mode: 'percent', percent: 50 });

  assert.deepEqual(reconcileResizeToAspect(percentResize, '1:1', 'width'), percentResize);
});
