import Store from 'electron-store';
import type { AppPreset } from '../../core/shared/types';
import {
  createUserPresetRepository,
  type PresetStoreSchema,
  type UserPresetRepository,
  type UserPresetStore,
} from '../../core/presets/user-presets';

export interface ElectronPresetStoreOptions {
  cwd?: string;
  name?: string;
  projectName?: string;
}

export function createElectronPresetStore(options: ElectronPresetStoreOptions = {}): UserPresetStore {
  return new Store<PresetStoreSchema>({
    projectName: options.projectName || 'image-puma',
    name: options.name || 'image-puma-presets',
    cwd: options.cwd,
    defaults: {
      customPresets: [],
    },
  }) as unknown as UserPresetStore;
}

export function createElectronUserPresetRepository(
  options: ElectronPresetStoreOptions = {},
): UserPresetRepository {
  return createUserPresetRepository(createElectronPresetStore(options));
}

let repository: UserPresetRepository | null = null;

function getRepository(): UserPresetRepository {
  if (!repository) {
    repository = createElectronUserPresetRepository();
  }
  return repository;
}

export function loadUserPresets(): AppPreset[] {
  return getRepository().loadUserPresets();
}

export function saveUserPreset(inputPreset: AppPreset): AppPreset[] {
  return getRepository().saveUserPreset(inputPreset);
}

export function deleteUserPreset(presetId: string): AppPreset[] {
  return getRepository().deleteUserPreset(presetId);
}
