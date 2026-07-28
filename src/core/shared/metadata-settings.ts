import type { MetadataSettings } from './types';

export const DEFAULT_ADVANCED_METADATA_SETTINGS = {
  syntheticMode: 'off',
  rewriteMode: 'off',
  creatorName: '',
} as const satisfies Pick<MetadataSettings, 'syntheticMode' | 'rewriteMode' | 'creatorName'>;

export function normalizeMetadataSettings(metadata: MetadataSettings): MetadataSettings {
  return {
    ...metadata,
    syntheticMode: metadata.syntheticMode || DEFAULT_ADVANCED_METADATA_SETTINGS.syntheticMode,
    rewriteMode: metadata.rewriteMode || DEFAULT_ADVANCED_METADATA_SETTINGS.rewriteMode,
    creatorName: metadata.creatorName || DEFAULT_ADVANCED_METADATA_SETTINGS.creatorName,
  };
}

export function isSyntheticImageProcessingEnabled(metadata: MetadataSettings): boolean {
  return normalizeMetadataSettings(metadata).syntheticMode === 'process';
}

export function metadataRewriteUsesTimestamp(metadata: MetadataSettings): boolean {
  const mode = normalizeMetadataSettings(metadata).rewriteMode;
  return mode === 'timestamp-jitter' || mode === 'timestamp-jitter-and-creator';
}

export function metadataRewriteUsesCreator(metadata: MetadataSettings): boolean {
  const mode = normalizeMetadataSettings(metadata).rewriteMode;
  return mode === 'creator' || mode === 'timestamp-jitter-and-creator';
}

export function isMetadataRewriteEnabled(metadata: MetadataSettings): boolean {
  const normalized = normalizeMetadataSettings(metadata);
  return metadataRewriteUsesTimestamp(normalized) || metadataRewriteUsesCreator(normalized);
}
