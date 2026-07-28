import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppPreset, BatchOutputPlan } from '../src/core/shared/types';
import { DesktopPlanStore } from '../src/main/processing/desktop-plan-store';

const preset: AppPreset = {
  id: 'test',
  name: 'Test',
  description: 'Test preset',
  output: {
    format: 'jpeg',
    jpegQuality: 80,
    pngCompressionLevel: 6,
    webpQuality: 80,
    avifQuality: 50,
    lossless: false,
  },
  resize: {
    mode: 'none',
    noUpscale: true,
    responsiveWidths: [],
  },
  crop: {
    enabled: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    aspectRatio: null,
    aspectAnchor: 'top-left',
    positionMode: 'xy',
  },
  transform: {
    rotation: 0,
    flipH: false,
    flipV: false,
  },
  metadata: {
    mode: 'strip-all',
    convertToSrgb: true,
  },
  naming: {
    keepOriginal: true,
    sanitizeAiTerms: true,
    prefix: '',
    suffix: '',
    findText: '',
    replaceText: '',
    sequential: false,
    sequentialStart: 1,
    template: '{name}',
  },
  export: {
    destination: 'sibling',
    customPath: '',
    siblingFolderName: 'optimized',
    overwrite: false,
    openFolderWhenDone: false,
  },
};

function makePlan(): BatchOutputPlan {
  return {
    preset,
    entries: [],
    issues: [],
    summary: {
      sourceCount: 0,
      outputCount: 0,
      errorCount: 0,
      warningCount: 0,
      destinationFolders: [],
    },
  };
}

test('desktop plan store returns opaque plan IDs for stored plans', () => {
  const store = new DesktopPlanStore({
    ttlMs: 1000,
    now: () => 100,
    idFactory: () => 'fixed',
  });
  const plan = makePlan();

  const response = store.create(plan);

  assert.equal(response.planId, 'desktop-plan-fixed');
  assert.equal(response.plan, plan);
  assert.equal(response.expiresAt, new Date(1100).toISOString());
  assert.equal(store.resolve(response.planId), plan);
});

test('desktop plan store expires old plan IDs', () => {
  let now = 100;
  const store = new DesktopPlanStore({
    ttlMs: 50,
    now: () => now,
    idFactory: () => 'expiring',
  });
  const response = store.create(makePlan());

  now = 151;

  assert.throws(
    () => store.resolve(response.planId),
    /PLAN_EXPIRED/,
  );
});
