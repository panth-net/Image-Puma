import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { AppPreset } from '../src/core/shared/types';
import { defaultPresets } from '../src/core/presets/default-presets';
import { createJsonFilePresetStore, createUserPresetRepository } from '../src/core/presets/user-presets';
import { createElectronUserPresetRepository } from '../src/main/presets/user-presets';

function clonePreset(preset: AppPreset): AppPreset {
  return {
    ...preset,
    output: { ...preset.output },
    resize: {
      ...preset.resize,
      responsiveWidths: Array.isArray(preset.resize.responsiveWidths)
        ? [...preset.resize.responsiveWidths]
        : [],
    },
    crop: { ...preset.crop },
    transform: { ...preset.transform },
    metadata: { ...preset.metadata },
    naming: { ...preset.naming },
    export: { ...preset.export },
  };
}

test('user preset repository saves, updates, clones, and deletes presets', () => {
  const state: { customPresets: unknown } = { customPresets: [] };
  const repo = createUserPresetRepository({
    get: () => state.customPresets,
    set: (_key, value) => {
      state.customPresets = value;
    },
  });

  const base = clonePreset(defaultPresets[0]);
  const firstSave = repo.saveUserPreset({
    ...base,
    id: 'web-upload',
    name: 'Launch Profile',
    description: 'Custom profile',
    resize: {
      ...base.resize,
      mode: 'width',
      width: 1200,
      responsiveWidths: [640, 960],
    },
  });

  assert.equal(firstSave.length, 1);
  assert.ok(firstSave[0].id.startsWith('user-launch-profile'));

  const savedId = firstSave[0].id;
  const secondSave = repo.saveUserPreset({
    ...firstSave[0],
    id: savedId,
    name: 'Launch Profile Updated',
  });

  assert.equal(secondSave.length, 1);
  assert.equal(secondSave[0].id, savedId);
  assert.equal(secondSave[0].name, 'Launch Profile Updated');

  const loaded = repo.loadUserPresets();
  loaded[0].resize.responsiveWidths.push(1440);
  const loadedAgain = repo.loadUserPresets();
  assert.deepEqual(loadedAgain[0].resize.responsiveWidths, [640, 960]);

  const afterDelete = repo.deleteUserPreset(savedId);
  assert.equal(afterDelete.length, 0);
});

test('JSON file preset store persists user presets without Electron', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-presets-'));
  const storePath = path.join(tmpRoot, 'presets.json');

  try {
    const repo = createUserPresetRepository(createJsonFilePresetStore(storePath));
    const base = clonePreset(defaultPresets[0]);
    const saved = repo.saveUserPreset({
      ...base,
      id: '',
      name: 'Headless Profile',
      description: 'Saved by the file store',
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'user-headless-profile');

    const reloadedRepo = createUserPresetRepository(createJsonFilePresetStore(storePath));
    assert.equal(reloadedRepo.loadUserPresets()[0].name, 'Headless Profile');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('Electron preset store adapter persists desktop user presets', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-electron-presets-'));

  try {
    const repo = createElectronUserPresetRepository({
      cwd: tmpRoot,
      name: 'desktop-presets',
      projectName: 'image-puma-test',
    });
    const base = clonePreset(defaultPresets[0]);
    const saved = repo.saveUserPreset({
      ...base,
      id: '',
      name: 'Desktop Profile',
      description: 'Saved by the Electron store adapter',
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'user-desktop-profile');

    const reloadedRepo = createElectronUserPresetRepository({
      cwd: tmpRoot,
      name: 'desktop-presets',
      projectName: 'image-puma-test',
    });
    assert.equal(reloadedRepo.loadUserPresets()[0].name, 'Desktop Profile');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
