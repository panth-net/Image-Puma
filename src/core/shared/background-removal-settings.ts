import type { AppPreset, BackgroundRemovalRecipeSettings } from './types';

export const DEFAULT_BACKGROUND_REMOVAL_SETTINGS: BackgroundRemovalRecipeSettings = {
  enabled: false,
};

export function normalizeBackgroundRemovalSettings(
  settings: Partial<BackgroundRemovalRecipeSettings> | null | undefined,
): BackgroundRemovalRecipeSettings {
  return {
    enabled: Boolean(settings?.enabled),
  };
}

export function isBackgroundRemovalEnabled(preset: Pick<AppPreset, 'backgroundRemoval'>): boolean {
  return normalizeBackgroundRemovalSettings(preset.backgroundRemoval).enabled;
}
