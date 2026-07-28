import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppPreset } from '../shared/types';
import { normalizeMetadataSettings } from '../shared/metadata-settings';
import { normalizeBackgroundRemovalSettings } from '../shared/background-removal-settings';
import { defaultPresets } from './default-presets';

export interface PresetStoreSchema {
  customPresets: AppPreset[];
}

export interface UserPresetStore {
  get: (key: 'customPresets') => unknown;
  set: (key: 'customPresets', value: AppPreset[]) => void;
}

const RESERVED_IDS = new Set(defaultPresets.map((preset) => preset.id));

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
    metadata: normalizeMetadataSettings(preset.metadata),
    naming: { ...preset.naming },
    export: { ...preset.export },
    backgroundRemoval: normalizeBackgroundRemovalSettings(preset.backgroundRemoval),
  };
}

function isAppPreset(value: unknown): value is AppPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<AppPreset>;
  return typeof preset.id === 'string' && typeof preset.name === 'string' && typeof preset.description === 'string';
}

function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'preset';
}

function normalizeUserPresetId(
  requestedId: string | undefined,
  name: string,
  existingIds: Set<string>,
): string {
  if (
    requestedId
    && requestedId.trim().length > 0
    && requestedId.trim().toLowerCase().startsWith('user-')
    && !RESERVED_IDS.has(requestedId.trim().toLowerCase())
  ) {
    return requestedId.trim().toLowerCase();
  }

  const base = requestedId && requestedId.trim().length > 0
    ? requestedId.trim().toLowerCase()
    : `user-${slugifyName(name)}`;

  const candidate = RESERVED_IDS.has(base) || !base.startsWith('user-')
    ? `user-${slugifyName(name)}`
    : base;

  if (!existingIds.has(candidate)) return candidate;

  let suffix = 2;
  while (existingIds.has(`${candidate}-${suffix}`)) {
    suffix++;
  }
  return `${candidate}-${suffix}`;
}

export interface UserPresetRepository {
  loadUserPresets: () => AppPreset[];
  saveUserPreset: (inputPreset: AppPreset) => AppPreset[];
  deleteUserPreset: (presetId: string) => AppPreset[];
}

export function createUserPresetRepository(presetStore: UserPresetStore): UserPresetRepository {
  const loadUserPresets = (): AppPreset[] => {
    const raw = presetStore.get('customPresets');
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((preset) => isAppPreset(preset))
      .map((preset) => clonePreset(preset));
  };

  const saveUserPreset = (inputPreset: AppPreset): AppPreset[] => {
    const existing = loadUserPresets();
    const existingIds = new Set(existing.map((preset) => preset.id));
    const normalizedId = normalizeUserPresetId(inputPreset.id, inputPreset.name, existingIds);

    const nextPreset = clonePreset({ ...inputPreset, id: normalizedId });
    const replaceIndex = existing.findIndex((preset) => preset.id === nextPreset.id);

    let updated: AppPreset[];
    if (replaceIndex >= 0) {
      updated = [...existing];
      updated[replaceIndex] = nextPreset;
    } else {
      updated = [...existing, nextPreset];
    }

    presetStore.set('customPresets', updated);
    return updated;
  };

  const deleteUserPreset = (presetId: string): AppPreset[] => {
    const existing = loadUserPresets();
    const updated = existing.filter((preset) => preset.id !== presetId);
    presetStore.set('customPresets', updated);
    return updated;
  };

  return {
    loadUserPresets,
    saveUserPreset,
    deleteUserPreset,
  };
}

export function getDefaultUserPresetFilePath(): string {
  const configRoot = process.env.XDG_CONFIG_HOME
    || (process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : path.join(os.homedir(), '.config'));
  return path.join(configRoot, 'image-puma', 'presets.json');
}

export function createJsonFilePresetStore(filePath = getDefaultUserPresetFilePath()): UserPresetStore {
  const readSchema = (): PresetStoreSchema => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PresetStoreSchema>;
      return {
        customPresets: Array.isArray(parsed.customPresets) ? parsed.customPresets : [],
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { customPresets: [] };
      }
      return { customPresets: [] };
    }
  };

  const writeSchema = (schema: PresetStoreSchema): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempPath, filePath);
  };

  return {
    get: (key) => readSchema()[key],
    set: (key, value) => {
      const schema = readSchema();
      writeSchema({ ...schema, [key]: value });
    },
  };
}
