import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { resolveOutputFilename, resolveOutputFolder, resolveOutputPath } from '../src/core/files/export-paths';
import { defaultPresets } from '../src/core/presets/default-presets';
import type { AppPreset, ExportSettings, InputFile, NamingSettings } from '../src/core/shared/types';

const inputFile: InputFile = {
  sourcePath: '/tmp/example/sunset.raw.jpg',
  relativePath: 'sunset.raw.jpg',
  fileName: 'sunset.raw',
  extension: '.jpg',
  fileSize: 1024,
};

const baseNaming: NamingSettings = {
  keepOriginal: false,
  sanitizeAiTerms: true,
  prefix: '',
  suffix: '',
  findText: '',
  replaceText: '',
  sequential: true,
  sequentialStart: 5,
  template: '',
};

test('resolveOutputFilename applies template tokens and sequence numbering', () => {
  const name = resolveOutputFilename(
    inputFile,
    {
      ...baseNaming,
      template: '{name}-{width}w-{seq}.{ext}',
    },
    'webp',
    2,
    { width: '640' },
  );

  assert.equal(name, 'sunset.raw-640w-7.webp');
});

test('resolveOutputFilename avoids duplicate extensions from templates', () => {
  const name = resolveOutputFilename(
    inputFile,
    {
      ...baseNaming,
      sequential: false,
      template: '{name}.png',
    },
    'png',
    0,
  );

  assert.equal(name, 'sunset.raw.png');
});

test('resolveOutputFilename applies affix and suffix around kept source filename', () => {
  const name = resolveOutputFilename(
    inputFile,
    {
      ...baseNaming,
      keepOriginal: true,
      prefix: 'web-',
      suffix: '-optimized',
      sequential: false,
    },
    'webp',
    0,
  );

  assert.equal(name, 'web-sunset.raw-optimized.webp');
});

test('resolveOutputFilename strips common AI source terms when enabled', () => {
  const aiNamedInput: InputFile = {
    ...inputFile,
    fileName: 'chatgpt-claude-ai-generated-seedream-gemini-mj.run-portrait',
  };

  const sanitized = resolveOutputFilename(
    aiNamedInput,
    {
      ...baseNaming,
      sequential: false,
    },
    'jpeg',
    0,
  );

  assert.equal(sanitized, 'portrait.jpeg');

  const unsanitized = resolveOutputFilename(
    aiNamedInput,
    {
      ...baseNaming,
      sanitizeAiTerms: false,
      sequential: false,
    },
    'jpeg',
    0,
  );

  assert.equal(unsanitized, 'chatgpt-claude-ai-generated-seedream-gemini-mj.run-portrait.jpeg');
});

test('resolveOutputPath forces AI source stripping for strict privacy metadata mode', () => {
  const aiNamedInput: InputFile = {
    ...inputFile,
    sourcePath: '/tmp/example/claude-ai-generated-seedream-portrait.jpg',
    relativePath: 'claude-ai-generated-seedream-portrait.jpg',
    fileName: 'claude-ai-generated-seedream-portrait',
  };
  const preset: AppPreset = {
    ...defaultPresets[0],
    metadata: {
      mode: 'strip-all',
      convertToSrgb: true,
    },
    naming: {
      ...baseNaming,
      sanitizeAiTerms: false,
      sequential: false,
    },
    export: {
      destination: 'custom',
      customPath: '/tmp/output',
      siblingFolderName: 'optimized',
      overwrite: false,
      openFolderWhenDone: false,
    },
  };

  const outputPath = resolveOutputPath(aiNamedInput, preset, 0, 'jpeg');

  assert.equal(path.basename(outputPath), 'portrait.jpeg');
});

test('resolveOutputFolder requires a chosen path for custom export destinations', () => {
  const customExport: ExportSettings = {
    destination: 'custom',
    customPath: '  ',
    siblingFolderName: 'optimized',
    overwrite: false,
    openFolderWhenDone: false,
  };

  assert.throws(
    () => resolveOutputFolder(inputFile, customExport),
    /Custom export folder is required/,
  );
});
