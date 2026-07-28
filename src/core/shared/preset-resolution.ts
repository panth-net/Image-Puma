import type {
  AppPreset,
} from './types';
import { normalizeMetadataSettings } from './metadata-settings';

function cloneResize<T extends { responsiveWidths?: number[] }>(resize: T): T {
  return {
    ...resize,
    responsiveWidths: Array.isArray(resize.responsiveWidths)
      ? [...resize.responsiveWidths]
      : [],
  };
}

export function resolvePreset(base: AppPreset): AppPreset {
  return {
    ...base,
    output: { ...base.output },
    resize: cloneResize(base.resize),
    crop: { ...base.crop },
    transform: { ...base.transform },
    metadata: normalizeMetadataSettings(base.metadata),
    naming: { ...base.naming },
    export: { ...base.export },
  };
}
