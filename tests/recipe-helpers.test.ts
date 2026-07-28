import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppPreset, InputFile } from '../src/core/shared/types';
import {
  buildNamingExample,
  doesPresetChangeImageBytes,
  getBatchOutputFormat,
  getChangedRecipeSections,
  isOutputNeutral,
  validatePresetSettings,
} from '../src/core/shared/recipe-helpers';
import { defaultPresets } from '../src/core/presets/default-presets';

const sampleFile: InputFile = {
  sourcePath: '/tmp/chatgpt-product-shot.JPG',
  relativePath: 'chatgpt-product-shot.JPG',
  fileName: 'chatgpt-product-shot',
  extension: '.JPG',
  fileSize: 1024,
};

function clonePreset(preset: AppPreset): AppPreset {
  return {
    ...preset,
    output: { ...preset.output },
    resize: {
      ...preset.resize,
      responsiveWidths: [...preset.resize.responsiveWidths],
    },
    crop: { ...preset.crop },
    transform: { ...preset.transform },
    metadata: { ...preset.metadata },
    naming: { ...preset.naming },
    export: { ...preset.export },
  };
}

test('validatePresetSettings reports invalid required resize values and exact stretch warning', () => {
  const preset = clonePreset(defaultPresets[0]);
  preset.resize = {
    ...preset.resize,
    mode: 'exact',
    width: undefined,
    height: 500,
  };

  const issues = validatePresetSettings(preset);

  assert.ok(issues.some((issue) => issue.field === 'width' && issue.section === 'resize'));
  assert.ok(issues.some((issue) => issue.field === 'mode' && issue.message.includes('distort')));
});

test('validatePresetSettings allows one-axis fit box resize', () => {
  const preset = clonePreset(defaultPresets[0]);
  preset.resize = {
    ...preset.resize,
    mode: 'fit-box',
    width: undefined,
    height: 640,
  };

  assert.deepEqual(validatePresetSettings(preset), []);

  preset.resize.height = undefined;
  const issues = validatePresetSettings(preset);
  assert.ok(issues.some((issue) => issue.field === 'mode' && issue.section === 'resize'));
});

test('validatePresetSettings requires creator name when creator rewrite is enabled', () => {
  const preset = clonePreset(defaultPresets[0]);
  preset.metadata = {
    ...preset.metadata,
    rewriteMode: 'creator',
    creatorName: '',
  };

  const issues = validatePresetSettings(preset);

  assert.ok(issues.some((issue) => issue.field === 'creatorName' && issue.section === 'metadata'));
});

test('buildNamingExample shows sanitized names, sequence, and responsive tokens', () => {
  const preset = clonePreset(defaultPresets[0]);
  preset.output.format = 'webp';
  preset.naming = {
    ...preset.naming,
    sanitizeAiTerms: true,
    keepOriginal: false,
    template: '{name}-{seq}-{width}w',
    sequential: true,
    sequentialStart: 7,
  };

  const example = buildNamingExample(sampleFile, preset, 0, { width: 640 });

  assert.equal(example, 'product-shot-7-640w.webp');
});

test('buildNamingExample forces AI source stripping for strict privacy metadata mode', () => {
  const preset = clonePreset(defaultPresets[0]);
  preset.output.format = 'jpeg';
  preset.metadata.mode = 'strip-all';
  preset.naming = {
    ...preset.naming,
    sanitizeAiTerms: false,
    keepOriginal: true,
  };
  const sourceFile: InputFile = {
    ...sampleFile,
    fileName: 'claude-ai-generated-seedream-product-shot',
    relativePath: 'claude-ai-generated-seedream-product-shot.JPG',
    sourcePath: '/tmp/claude-ai-generated-seedream-product-shot.JPG',
  };

  const example = buildNamingExample(sourceFile, preset);

  assert.equal(example, 'product-shot.jpeg');
});

test('buildNamingExample shows affix and suffix around a locked source filename', () => {
  const preset = clonePreset(defaultPresets[0]);
  preset.output.format = 'webp';
  preset.naming = {
    ...preset.naming,
    keepOriginal: true,
    sanitizeAiTerms: true,
    prefix: 'web-',
    suffix: '-optimized',
  };

  const example = buildNamingExample(sampleFile, preset);

  assert.equal(example, 'web-product-shot-optimized.webp');
});

test('keep-original resolves one format from the first source for the whole batch', () => {
  assert.equal(getBatchOutputFormat('keep-original', [
    { extension: '.png' },
    { extension: '.jpg' },
  ]), 'png');
  assert.equal(getBatchOutputFormat('webp', [
    { extension: '.png' },
    { extension: '.jpg' },
  ]), 'webp');
});

test('recipe section helpers report changed recipe sections', () => {
  const base = clonePreset(defaultPresets[0]);
  const changed = clonePreset(base);
  changed.resize.mode = 'width';
  changed.resize.width = 1200;
  changed.metadata.mode = 'keep-icc';

  assert.deepEqual(getChangedRecipeSections(base, changed), ['resize', 'metadata']);
});

test('image byte change helper only treats fully neutral image settings as passthrough', () => {
  const preset = clonePreset(defaultPresets[0]);
  preset.output = {
    format: 'keep-original',
    jpegQuality: 100,
    pngCompressionLevel: 0,
    webpQuality: 100,
    avifQuality: 100,
    lossless: false,
  };
  preset.resize.mode = 'none';
  preset.crop.enabled = false;
  preset.transform = { rotation: 0, flipH: false, flipV: false };
  preset.metadata = { mode: 'keep-all', convertToSrgb: false };

  assert.equal(isOutputNeutral(preset.output), true);
  assert.equal(doesPresetChangeImageBytes(preset), false);

  preset.output.jpegQuality = 82;
  assert.equal(isOutputNeutral(preset.output), false);
  assert.equal(doesPresetChangeImageBytes(preset), true);
});
