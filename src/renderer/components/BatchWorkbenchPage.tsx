import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AppPreset,
  CropAspectAnchor,
  CropPositionMode,
  CropSettings,
  InputFile,
  InputScanProgress,
  InputScanResult,
  OutputSettings,
  PreviewResult,
  BatchJobResult,
  BatchProgressUpdate,
  ProcessedFileResult,
  ResizeSettings,
  TransformSettings,
} from '../../core/shared/types';
import {
  buildNamingExample,
  getBatchOutputFormat,
  getChangedRecipeSections,
  getMetadataModeCopy,
  isOutputNeutral,
  recipeFingerprint,
  RecipeSection,
  validatePresetSettings,
} from '../../core/shared/recipe-helpers';
import {
  sanitizeFileSegment,
  shouldStripAiSourceTerms,
  stripAiSourceTerms,
} from '../../core/shared/filename-sanitizer';
import {
  isMetadataRewriteEnabled,
  isSyntheticImageProcessingEnabled,
  metadataRewriteUsesCreator,
  metadataRewriteUsesTimestamp,
  normalizeMetadataSettings,
} from '../../core/shared/metadata-settings';
import {
  DEFAULT_BACKGROUND_REMOVAL_SETTINGS,
  isBackgroundRemovalEnabled,
  normalizeBackgroundRemovalSettings,
} from '../../core/shared/background-removal-settings';
import {
  parseCropAspectRatio,
  resolveCropPercent,
} from '../../core/shared/crop-geometry';
import {
  reconcileResizeToAspect,
} from '../../core/shared/size-crop-reconciliation';
import type { ResizeDimension } from '../../core/shared/size-crop-reconciliation';
import {
  getTransformedDimensions,
  getTransformAdjustedAspect,
} from '../../core/shared/transform-geometry';
import { api } from '../api';
import { toLocalFileUrl } from '../local-file-url';
import { BackgroundRemovalModelInfoButton } from './BackgroundRemovalModelInfoButton';
import { ModalDialog } from './ModalDialog';
import { DropZone } from './DropZone';
import { PresetPickerModal } from './PresetPickerModal';
import { SliderNumberInput } from './SliderNumberInput';

type SettingsTab = 'compression' | 'size' | 'transform' | 'metadata' | 'naming' | 'backgroundRemoval' | 'export';
type InspectorMode = 'review' | 'adjust';
type PresetEditMode = 'none' | 'new' | 'copy' | 'user';
type JobStatus = 'active' | 'pending' | 'done' | 'failed' | 'skipped' | 'cancelled';
type PreviewTransform = {
  zoom: number;
  pan: { x: number; y: number };
};

const TAB_LIST: { id: SettingsTab; label: string }[] = [
  { id: 'compression', label: 'Compression' },
  { id: 'size', label: 'Size & Crop' },
  { id: 'transform', label: 'Transform' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'naming', label: 'Naming' },
  { id: 'backgroundRemoval', label: 'Background' },
  { id: 'export', label: 'Export' },
];

const TAB_RECIPE_SECTIONS: Record<SettingsTab, RecipeSection[]> = {
  compression: ['output'],
  size: ['resize', 'crop'],
  transform: ['transform'],
  metadata: ['metadata'],
  naming: ['naming'],
  backgroundRemoval: ['backgroundRemoval'],
  export: ['export'],
};

const CROP_EDGE_SNAP_THRESHOLD_PX = 2;
const PRESET_SAVE_NUDGE_WIDTH = 280;
const PRESET_SAVE_NUDGE_APPROX_HEIGHT = 92;
const PRESET_SAVE_NUDGE_OFFSET = 8;
const PRESET_SAVE_NUDGE_VIEWPORT_MARGIN = 12;
const RATIO_PRESETS: Array<{ label: string; value: string | null }> = [
  { label: 'Custom', value: null },
  { label: '1:1', value: '1:1' },
  { label: '4:5', value: '4:5' },
  { label: '16:9', value: '16:9' },
  { label: '3:2', value: '3:2' },
  { label: '5:4', value: '5:4' },
  { label: '9:16', value: '9:16' },
  { label: '2:3', value: '2:3' },
];
type SettingSelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  hoverExample?: string;
};

const SELECT_MENU_SCROLL_PADDING = 12;

function findNearestVerticalScroller(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;

  while (current && current !== document.body && current !== document.documentElement) {
    const { overflowY } = window.getComputedStyle(current);
    const canScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';

    if (canScroll && current.scrollHeight > current.clientHeight) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function revealSettingSelectPopover(menuElement: HTMLElement): void {
  const popover = menuElement.querySelector<HTMLElement>('.setting-select-popover');
  if (!popover) return;

  const scroller = findNearestVerticalScroller(menuElement);
  if (!scroller) {
    popover.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }

  const popoverRect = popover.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const bottomOverflow = popoverRect.bottom - (scrollerRect.bottom - SELECT_MENU_SCROLL_PADDING);
  const topOverflow = popoverRect.top - (scrollerRect.top + SELECT_MENU_SCROLL_PADDING);

  if (bottomOverflow > 0) {
    scroller.scrollTo({ top: scroller.scrollTop + bottomOverflow, behavior: 'auto' });
  } else if (topOverflow < 0) {
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + topOverflow), behavior: 'auto' });
  }
}

const OUTPUT_FORMAT_OPTIONS: Array<SettingSelectOption<AppPreset['output']['format']>> = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
  { value: 'avif', label: 'AVIF' },
  { value: 'tiff', label: 'TIFF' },
  { value: 'ico', label: 'ICO (Windows Icon)' },
  { value: 'icns', label: 'ICNS (macOS Icon)' },
  { value: 'keep-original', label: 'Match First Source' },
];

const RESIZE_MODE_OPTIONS: Array<SettingSelectOption<AppPreset['resize']['mode']>> = [
  { value: 'none', label: 'No Resize' },
  { value: 'width', label: 'Width Only' },
  { value: 'height', label: 'Height Only' },
  { value: 'fit-box', label: 'Fit Box' },
  { value: 'exact', label: 'Stretch to Exact Size' },
  { value: 'percent', label: 'Percent' },
];

const CROP_ANCHOR_OPTIONS: Array<SettingSelectOption<CropAspectAnchor>> = [
  { value: 'top-left', label: 'Top Left' },
  { value: 'top-right', label: 'Top Right' },
  { value: 'bottom-left', label: 'Bottom Left' },
  { value: 'bottom-right', label: 'Bottom Right' },
];

const METADATA_MODE_OPTIONS: Array<SettingSelectOption<AppPreset['metadata']['mode']>> = [
  {
    value: 'strip-all',
    label: 'Strict Privacy - remove metadata + AI filename traces',
    hoverExample: [
      'Example source:',
      'GPSLatitude = 37.7749 -> delete',
      'DateTimeOriginal = 2026:07:06 14:53:03 -> delete',
      'Creator = Acme Studio -> delete',
      'ICC Profile = Display P3 -> delete',
      'Filename "ChatGPT Image.png" -> cleaned',
    ].join('\n'),
  },
  {
    value: 'strip-privacy-smart',
    label: 'Privacy Safe - keep color profile',
    hoverExample: [
      'Example source:',
      'GPSLatitude = 37.7749 -> delete',
      'Camera Make = Apple -> delete',
      'Creator = Acme Studio -> delete',
      'ICC Profile = Display P3 -> keep',
      'Pixels/colors -> keep appearance',
    ].join('\n'),
  },
  {
    value: 'keep-icc',
    label: 'Color Profile Only',
    hoverExample: [
      'Example source:',
      'GPSLatitude = 37.7749 -> delete',
      'DateTimeOriginal = 2026:07:06 14:53:03 -> delete',
      'Creator = Acme Studio -> delete',
      'Keywords = ai, product -> delete',
      'ICC Profile = Display P3 -> keep',
    ].join('\n'),
  },
  {
    value: 'keep-all',
    label: 'Keep Everything',
    hoverExample: [
      'Example source:',
      'GPSLatitude = 37.7749 -> keep',
      'DateTimeOriginal = 2026:07:06 14:53:03 -> keep',
      'Camera Make = Apple -> keep',
      'Creator = Acme Studio -> keep',
      'ICC Profile = Display P3 -> keep',
    ].join('\n'),
  },
  {
    value: 'keep-exif',
    label: 'Advanced - keep EXIF',
    hoverExample: [
      'Example source:',
      'EXIF ISO = 200 -> keep',
      'EXIF DateTimeOriginal = 2026:07:06 14:53:03 -> keep',
      'EXIF GPSLatitude = 37.7749 -> keep',
      'XMP Creator = Acme Studio -> delete',
      'IPTC Keywords = ai, product -> delete',
    ].join('\n'),
  },
  {
    value: 'keep-xmp',
    label: 'Advanced - keep XMP',
    hoverExample: [
      'Example source:',
      'XMP Title = Campaign hero -> keep',
      'XMP Creator = Acme Studio -> keep',
      'XMP Rights = Copyright 2026 -> keep',
      'EXIF GPSLatitude = 37.7749 -> delete',
      'EXIF Camera Make = Apple -> delete',
    ].join('\n'),
  },
  {
    value: 'strip-gps-only',
    label: 'Advanced - best-effort EXIF cleanup',
    hoverExample: [
      'Example source:',
      'GPSLatitude = 37.7749 -> delete',
      'Camera Serial = C02ABC123 -> delete',
      'OwnerName = Acme Studio -> delete',
      'EXIF ISO = 200 -> keep',
      'ICC Profile = Display P3 -> keep',
    ].join('\n'),
  },
];

const SYNTHETIC_IMAGE_MODE_OPTIONS: Array<SettingSelectOption<NonNullable<AppPreset['metadata']['syntheticMode']>>> = [
  {
    value: 'off',
    label: 'Off',
    description: 'Leave pixels untouched unless another edit changes them.',
    hoverExample: [
      'Example generated PNG:',
      'Transparent alpha -> keep',
      'Extra AI edge padding -> keep',
      'Detected Gemini watermark strip -> keep',
      'Pixels only change if another tab changes them.',
    ].join('\n'),
  },
  {
    value: 'process',
    label: 'Clean generated image',
    description: 'Remove alpha and crop known AI edge/watermark traces.',
    hoverExample: [
      'Example generated PNG:',
      'Transparent alpha -> remove',
      'Extra AI edge padding -> crop out',
      'Detected Gemini watermark strip -> crop out',
      'Main subject/content -> keep',
      'Then normal crop/resize still apply.',
    ].join('\n'),
  },
];

const METADATA_REWRITE_MODE_OPTIONS: Array<SettingSelectOption<NonNullable<AppPreset['metadata']['rewriteMode']>>> = [
  {
    value: 'off',
    label: 'Off',
    description: 'Do not add metadata after cleanup.',
    hoverExample: [
      'Example output:',
      'XMP CreateDate -> do not add',
      'XMP ModifyDate -> do not add',
      'XMP Creator -> do not add',
      'Privacy mode still removes what it removes.',
    ].join('\n'),
  },
  {
    value: 'timestamp-jitter',
    label: 'Jitter timestamps',
    description: 'Add non-round XMP create/modify dates.',
    hoverExample: [
      'Example output:',
      'XMP CreateDate -> add 2026-07-06T14:53:37',
      'XMP ModifyDate -> add 2026-07-06T14:54:12',
      'XMP MetadataDate -> add 2026-07-06T14:55:04',
      'XMP Creator -> do not add',
    ].join('\n'),
  },
  {
    value: 'creator',
    label: 'Creator only',
    description: 'Add the creator name you type below.',
    hoverExample: [
      'Example output:',
      'Creator field = "Acme Studio" -> add',
      'XMP dc:Creator -> add Acme Studio',
      'XMP CreateDate -> do not add',
      'Original GPS/camera data -> still controlled by Privacy mode',
    ].join('\n'),
  },
  {
    value: 'timestamp-jitter-and-creator',
    label: 'Timestamps + creator',
    description: 'Add both after cleanup.',
    hoverExample: [
      'Example output:',
      'XMP CreateDate -> add 2026-07-06T14:53:37',
      'XMP ModifyDate -> add 2026-07-06T14:54:12',
      'Creator field = "Acme Studio" -> add',
      'Original GPS/camera data -> still controlled by Privacy mode',
    ].join('\n'),
  },
];

const EXPORT_DESTINATION_OPTIONS: Array<SettingSelectOption<AppPreset['export']['destination']>> = [
  { value: 'sibling', label: 'Sibling Folder' },
  { value: 'custom', label: 'Custom Folder' },
];
const PREVIEW_ZOOM_MIN = 0.25;
const PREVIEW_ZOOM_MAX = 12;
const PREVIEW_WHEEL_ZOOM_SPEED = 0.0022;
const PREVIEW_PINCH_ZOOM_SPEED = 0.018;
const PREVIEW_WHEEL_DELTA_CAP = 80;
const PREVIEW_HOLD_DELAY_MS = 240;
const PREVIEW_REFRESH_DELAY_MS = 180;
const INTERACTIVE_PREVIEW_REFRESH_DELAY_MS = 450;
const PREVIEW_PREFETCH_DELAY_MS = 700;
const CROP_FOCUS_PADDING_PX = 48;
const PREVIEW_CACHE_SCHEMA_VERSION = 'preview-compare-base-v2';
/**
 * Previews are multi-megabyte base64 data URLs and the cache key includes the
 * whole recipe, so every slider tick would otherwise mint a permanent entry.
 */
const PREVIEW_CACHE_MAX_ENTRIES = 12;
/**
 * A continuous gesture (slider drag, crop drag) fires dozens of updates. They
 * collapse into a single undo entry while the same key keeps arriving.
 */
const HISTORY_COALESCE_WINDOW_MS = 900;
const DEFAULT_PREVIEW_TRANSFORM: PreviewTransform = {
  zoom: 1,
  pan: { x: 0, y: 0 },
};
const RECIPE_NEUTRAL_OUTPUT: AppPreset['output'] = {
  format: 'keep-original',
  jpegQuality: 100,
  pngCompressionLevel: 0,
  webpQuality: 100,
  avifQuality: 100,
  lossless: false,
};
const RECIPE_NEUTRAL_RESIZE: AppPreset['resize'] = {
  mode: 'none',
  noUpscale: true,
  responsiveWidths: [],
};
const RECIPE_NEUTRAL_CROP: AppPreset['crop'] = {
  enabled: false,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  aspectRatio: null,
  aspectAnchor: 'top-left',
  positionMode: 'xy',
  anchorInsideImage: false,
};
const RECIPE_NEUTRAL_TRANSFORM: AppPreset['transform'] = {
  rotation: 0,
  flipH: false,
  flipV: false,
};
const RECIPE_NEUTRAL_METADATA: AppPreset['metadata'] = {
  mode: 'keep-all',
  convertToSrgb: false,
  syntheticMode: 'off',
  rewriteMode: 'off',
  creatorName: '',
};
const RECIPE_NEUTRAL_NAMING: AppPreset['naming'] = {
  keepOriginal: true,
  sanitizeAiTerms: false,
  prefix: '',
  suffix: '',
  findText: '',
  replaceText: '',
  sequential: false,
  sequentialStart: 1,
  template: '',
};
const RECIPE_NEUTRAL_EXPORT: AppPreset['export'] = {
  destination: 'sibling',
  customPath: '',
  siblingFolderName: 'optimized',
  overwrite: false,
  openFolderWhenDone: true,
};

const RECIPE_NEUTRAL_BACKGROUND_REMOVAL: AppPreset['backgroundRemoval'] = {
  ...DEFAULT_BACKGROUND_REMOVAL_SETTINGS,
};
const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  active: 'Active',
  pending: 'Pending',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};
const NEW_PRESET_DEFAULT_NAME = 'Custom Preset';
const BLANK_CUSTOM_PRESET_TEMPLATE: AppPreset = {
  id: 'user-custom-draft',
  name: 'Custom Preset',
  description: 'Start from scratch - no resize, no crop, strip metadata by default',
  output: {
    format: 'keep-original',
    jpegQuality: 82,
    pngCompressionLevel: 6,
    webpQuality: 80,
    avifQuality: 65,
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
    anchorInsideImage: false,
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
    template: '',
  },
  export: {
    destination: 'sibling',
    customPath: '',
    siblingFolderName: 'optimized',
    overwrite: false,
    openFolderWhenDone: true,
  },
  backgroundRemoval: { ...RECIPE_NEUTRAL_BACKGROUND_REMOVAL },
};

function resetPresetSectionToNeutral(
  target: AppPreset,
  section: RecipeSection,
): void {
  if (section === 'output') target.output = { ...RECIPE_NEUTRAL_OUTPUT };
  if (section === 'resize') {
    target.resize = {
      ...RECIPE_NEUTRAL_RESIZE,
      responsiveWidths: [...RECIPE_NEUTRAL_RESIZE.responsiveWidths],
    };
  }
  if (section === 'crop') target.crop = { ...RECIPE_NEUTRAL_CROP };
  if (section === 'transform') target.transform = { ...RECIPE_NEUTRAL_TRANSFORM };
  if (section === 'metadata') target.metadata = { ...RECIPE_NEUTRAL_METADATA };
  if (section === 'naming') target.naming = { ...RECIPE_NEUTRAL_NAMING };
  if (section === 'backgroundRemoval') target.backgroundRemoval = { ...RECIPE_NEUTRAL_BACKGROUND_REMOVAL };
  if (section === 'export') target.export = { ...RECIPE_NEUTRAL_EXPORT };
}

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

function slugifyPresetName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'preset';
}

function createDraftPresetId(name: string): string {
  return `draft-${slugifyPresetName(name)}-${Date.now()}`;
}

function getUsedRecipeSections(preset: AppPreset | null): Record<SettingsTab, boolean> {
  if (!preset) {
    return {
      compression: false,
      size: false,
      transform: false,
      metadata: false,
      naming: false,
      backgroundRemoval: false,
      export: false,
    };
  }

  return {
    compression: !isOutputNeutral(preset.output),
    size: preset.resize.mode !== 'none' || preset.crop.enabled,
    transform: preset.transform.rotation !== 0 || preset.transform.flipH || preset.transform.flipV,
    metadata: preset.metadata.mode !== 'keep-all'
      || preset.metadata.convertToSrgb
      || isSyntheticImageProcessingEnabled(preset.metadata)
      || isMetadataRewriteEnabled(preset.metadata),
    naming: shouldStripAiSourceTerms(preset.metadata.mode, preset.naming)
      || !preset.naming.keepOriginal
      || preset.naming.prefix.length > 0
      || preset.naming.suffix.length > 0
      || preset.naming.findText.length > 0
      || preset.naming.replaceText.length > 0
      || preset.naming.template.length > 0
      || preset.naming.sequential,
    backgroundRemoval: isBackgroundRemovalEnabled(preset),
    export: preset.export.destination !== 'sibling'
      || preset.export.siblingFolderName !== 'optimized'
      || preset.export.customPath.length > 0
      || preset.export.overwrite
      || !preset.export.openFolderWhenDone
      || preset.naming.prefix.length > 0
      || preset.naming.suffix.length > 0,
  };
}

interface BatchWorkbenchPageProps {
  files: InputFile[];
  presets: AppPreset[];
  activePreset: AppPreset | null;
  setActivePreset: React.Dispatch<React.SetStateAction<AppPreset | null>>;
  thumbnails: Record<string, string>;
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  onRunBatch: (presetOverride?: AppPreset) => void;
  onFilesImported: (result: InputScanResult) => void;
  onRemoveFile: (sourcePath: string) => void;
  onClearFiles: () => void;
  batchProgress: BatchProgressUpdate | null;
  batchResult: BatchJobResult | null;
  resultsBySourcePath: Record<string, ProcessedFileResult>;
  activeBatchFiles: InputFile[];
  isProcessing: boolean;
  isStoppingBatch: boolean;
  isRetryingFailures: boolean;
  onCancelBatch: () => void;
  onRetryFailed: () => void;
  onRetrySources: (sourcePaths: string[], usePreviousSettings: boolean) => void;
  onExportErrorLog: () => void;
  onDismissResults: () => void;
  sessionNotice?: string | null;
  sessionWarning?: string | null;
  onDismissSessionNotice?: () => void;
  onDismissSessionWarning?: () => void;
  onSavePresetDraft: (preset: AppPreset) => Promise<AppPreset>;
  onDeletePreset: (preset: AppPreset) => Promise<void>;
  onError: (message: string) => void;
}

interface RecipeSnapshot {
  activePreset: AppPreset;
}

interface FloatingPosition {
  left: number;
  top: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getPresetSaveNudgePosition(target: HTMLElement): FloatingPosition {
  const targetRect = target.getBoundingClientRect();
  const margin = PRESET_SAVE_NUDGE_VIEWPORT_MARGIN;
  const width = Math.min(PRESET_SAVE_NUDGE_WIDTH, window.innerWidth - (margin * 2));
  const maxLeft = Math.max(margin, window.innerWidth - margin - width);
  const maxTop = Math.max(margin, window.innerHeight - margin - PRESET_SAVE_NUDGE_APPROX_HEIGHT);
  const rightLeft = targetRect.right + PRESET_SAVE_NUDGE_OFFSET;
  const leftLeft = targetRect.left - PRESET_SAVE_NUDGE_OFFSET - width;
  const fitsRight = rightLeft + width <= window.innerWidth - margin;
  const fitsLeft = leftLeft >= margin;

  return {
    left: fitsRight
      ? rightLeft
      : fitsLeft
        ? leftLeft
        : clamp(targetRect.left, margin, maxLeft),
    top: clamp(
      targetRect.top + (targetRect.height / 2) - (PRESET_SAVE_NUDGE_APPROX_HEIGHT / 2),
      margin,
      maxTop,
    ),
  };
}

function getOutputAxisTransformMatrix(transform: TransformSettings): string {
  const radians = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scaleX = transform.flipH ? -1 : 1;
  const scaleY = transform.flipV ? -1 : 1;

  return `matrix(${scaleX * cos}, ${scaleY * sin}, ${-scaleX * sin}, ${scaleY * cos}, 0, 0)`;
}

function getContainedFrameSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number; scale: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const safeMaxWidth = Math.max(1, maxWidth);
  const safeMaxHeight = Math.max(1, maxHeight);
  const scale = Math.min(1, safeMaxWidth / safeWidth, safeMaxHeight / safeHeight);

  return {
    width: safeWidth * scale,
    height: safeHeight * scale,
    scale,
  };
}

function getCursorAnchoredPreviewPan(
  pan: { x: number; y: number },
  oldZoom: number,
  nextZoom: number,
  frameRect: DOMRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const transformedCenterX = frameRect.left + frameRect.width / 2;
  const transformedCenterY = frameRect.top + frameRect.height / 2;
  const layoutCenterX = transformedCenterX - pan.x;
  const layoutCenterY = transformedCenterY - pan.y;
  const cursorX = clientX - layoutCenterX;
  const cursorY = clientY - layoutCenterY;
  const zoomRatio = nextZoom / oldZoom;

  return {
    x: pan.x + (cursorX - pan.x) * (1 - zoomRatio),
    y: pan.y + (cursorY - pan.y) * (1 - zoomRatio),
  };
}

function getWheelDeltaPixels(event: React.WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * 400;
  return event.deltaY;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDimensions(file: InputFile): string {
  if (file.width && file.height) return `${file.width} x ${file.height}`;
  return 'Dimensions unknown';
}

function getParentFolder(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]+$/, '');
}

function getBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function createScanId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getResultStatus(result: ProcessedFileResult): JobStatus {
  if (result.success) return 'done';
  if (result.cancelled) return 'cancelled';
  if (result.skipped) return 'skipped';
  return 'failed';
}

function isRetryableResult(result: ProcessedFileResult): boolean {
  return !result.success && (!result.skipped || result.cancelled === true);
}

function getResultOutputPath(result: ProcessedFileResult): string {
  return result.outputPath || result.generatedOutputs?.[0]?.outputPath || '';
}

function getResultDetail(result: ProcessedFileResult): string {
  const base = `${formatSize(result.outputSize)} · ${getBaseName(getResultOutputPath(result))}`;
  if (!result.warnings?.length) return base;
  return `${base} · ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`;
}

function summarizeResize(resize: AppPreset['resize']): string {
  if (resize.mode === 'none') return 'Original dimensions';
  if (resize.mode === 'width') return `Width ${resize.width || '-'} px`;
  if (resize.mode === 'height') return `Height ${resize.height || '-'} px`;
  if (resize.mode === 'fit-box') return `Fit ${resize.width || '-'} x ${resize.height || '-'} px`;
  if (resize.mode === 'exact') return `Exact ${resize.width || '-'} x ${resize.height || '-'} px`;
  return `${resize.percent || '-'}% scale`;
}

function summarizeDestination(preset: AppPreset): string {
  if (preset.export.destination === 'custom') {
    return preset.export.customPath || 'Custom folder not selected';
  }
  return `Sibling: ${preset.export.siblingFolderName || 'optimized'}`;
}

function normalizeCrop(crop: CropSettings): CropSettings {
  const width = clamp(Number(crop.width) || 100, 1, 100);
  const height = clamp(Number(crop.height) || 100, 1, 100);
  const maxX = Math.max(0, 100 - width);
  const maxY = Math.max(0, 100 - height);

  return {
    enabled: Boolean(crop.enabled),
    x: clamp(Number(crop.x) || 0, 0, maxX),
    y: clamp(Number(crop.y) || 0, 0, maxY),
    width,
    height,
    aspectRatio: crop.aspectRatio && crop.aspectRatio.trim().length > 0 ? crop.aspectRatio : null,
    aspectAnchor: crop.aspectAnchor,
    positionMode: crop.positionMode,
    anchorInsideImage: Boolean(crop.anchorInsideImage),
  };
}

function getCropAspectDimensions(imageAspect: number): { width: number; height: number } {
  const safeAspect = Math.max(0.0001, imageAspect);
  return safeAspect >= 1
    ? { width: safeAspect, height: 1 }
    : { width: 1, height: 1 / safeAspect };
}

function applyAnchorPosition(crop: CropSettings): CropSettings {
  const width = clamp(crop.width, 1, 100);
  const height = clamp(crop.height, 1, 100);
  const maxX = Math.max(0, 100 - width);
  const maxY = Math.max(0, 100 - height);

  let x = 0;
  let y = 0;
  if (crop.aspectAnchor === 'top-right') {
    x = maxX;
  } else if (crop.aspectAnchor === 'bottom-left') {
    y = maxY;
  } else if (crop.aspectAnchor === 'bottom-right') {
    x = maxX;
    y = maxY;
  }

  return { ...crop, x, y, width, height };
}

function applyAspectFromAnchor(crop: CropSettings, imageAspect: number): CropSettings {
  const parsed = parseCropAspectRatio(crop.aspectRatio);
  if (!parsed) return normalizeCrop(crop);

  const targetRatio = parsed.rw / parsed.rh;
  let width = 100;
  let height = (width * imageAspect) / targetRatio;

  if (height > 100) {
    height = 100;
    width = (height * targetRatio) / imageAspect;
  }

  return normalizeCrop(
    applyAnchorPosition({
      ...crop,
      width,
      height,
      positionMode: 'anchor',
    }),
  );
}

function applyAspectPreservingOffset(crop: CropSettings, imageAspect: number): CropSettings {
  const parsed = parseCropAspectRatio(crop.aspectRatio);
  if (!parsed) return normalizeCrop(crop);
  if (crop.x === 0 && crop.y === 0 && crop.width === 100 && crop.height === 100) {
    const source = getCropAspectDimensions(imageAspect);
    return resolveCropPercent(crop, source.width, source.height);
  }

  const targetRatio = parsed.rw / parsed.rh;
  const maxWidth = Math.max(1, 100 - crop.x);
  const maxHeight = Math.max(1, 100 - crop.y);

  let width = clamp(crop.width, 1, maxWidth);
  let height = (width * imageAspect) / targetRatio;

  if (height > maxHeight) {
    height = maxHeight;
    width = (height * targetRatio) / imageAspect;
  }

  if (width > maxWidth) {
    width = maxWidth;
    height = (width * imageAspect) / targetRatio;
  }

  return normalizeCrop({
    ...crop,
    width,
    height,
    positionMode: 'xy',
  });
}

/**
 * Only the settings that change rendered pixels or output bytes belong in the
 * preview key. Keying on the whole preset meant the preset name, naming rules and
 * export destination all invalidated the cache — so typing a preset name kicked
 * off a full sharp re-render per keystroke.
 */
function getPreviewRecipeKey(preset: AppPreset): string {
  // `creatorName` is written by ExifTool at export time and never reaches the
  // preview pipeline — only whether creator rewrite is on affects the warnings.
  const metadata = { ...preset.metadata, creatorName: '' };
  return JSON.stringify({
    output: preset.output,
    resize: preset.resize,
    crop: preset.crop,
    transform: preset.transform,
    metadata,
    backgroundRemoval: preset.backgroundRemoval,
  });
}

function getPreviewCacheKey(file: InputFile, resolvedPreset: AppPreset): string {
  return `${PREVIEW_CACHE_SCHEMA_VERSION}::${file.sourcePath}::${getPreviewRecipeKey(resolvedPreset)}`;
}

function getPreviewTransformKey(file: InputFile, preset: AppPreset): string {
  return `${file.sourcePath}::${JSON.stringify(preset.transform)}`;
}

function getPreviewVisualKey(file: InputFile, preset: AppPreset): string {
  return `${file.sourcePath}::${JSON.stringify({
    crop: preset.crop,
    resize: preset.resize,
    transform: preset.transform,
    convertToSrgb: preset.metadata.convertToSrgb,
  })}`;
}

function isTransformActive(preset: AppPreset): boolean {
  return preset.transform.rotation !== 0 || preset.transform.flipH || preset.transform.flipV;
}

function needsGeneratedCompareBase(preset: AppPreset): boolean {
  return isTransformActive(preset)
    || preset.crop.enabled
    || preset.resize.mode !== 'none'
    || preset.metadata.convertToSrgb;
}

function isPreviewCacheUsable(preview: PreviewResult, preset: AppPreset): boolean {
  if (needsGeneratedCompareBase(preset) && !preview.compareBaseDataUrl) return false;
  if (isTransformActive(preset) && !preview.cropBaseDataUrl) return false;
  return true;
}

function SourceThumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) {
    return (
      <span className="source-file-placeholder thumbnail-failed" data-tooltip="Thumbnail unavailable">
        <span>Preview unavailable</span>
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M5 7h14" />
      <path d="M9 7V5h6v2" />
      <path d="M7 7l1 13h8l1-13" />
    </svg>
  );
}

interface RowActionItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

function RowActionsMenu({
  label,
  actions,
}: {
  label: string;
  actions: RowActionItem[];
}) {
  return (
    <details className="row-actions-menu">
      <summary aria-label={label} data-tooltip={label}>...</summary>
      <div className="row-actions-menu-list">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={`row-actions-menu-item ${action.danger ? 'danger' : ''}`}
            disabled={action.disabled}
            onClick={(event) => {
              event.currentTarget.closest('details')?.removeAttribute('open');
              action.onClick();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </details>
  );
}

function SettingSelect<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  value: T;
  options: Array<SettingSelectOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useLayoutEffect(() => {
    if (open && menuRef.current) {
      revealSettingSelectPopover(menuRef.current);
    }
  }, [open]);

  return (
    <div className="preset-menu setting-select" ref={menuRef}>
      <button
        type="button"
        className="preset-menu-trigger setting-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <span>{selectedOption?.label || value}</span>
        <span className="preset-menu-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="preset-menu-popover setting-select-popover" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const active = option.value === value;
            const tooltipText = option.hoverExample;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                data-tooltip={tooltipText}
                data-tooltip-placement={tooltipText ? 'left' : undefined}
                data-tooltip-width={tooltipText ? '380' : undefined}
                className={`preset-option-main setting-select-option ${active ? 'active' : ''}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <strong>{option.label}</strong>
                {option.description && <span>{option.description}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function BatchWorkbenchPage({
  files,
  presets,
  activePreset,
  setActivePreset,
  thumbnails,
  selectedIndex,
  setSelectedIndex,
  onRunBatch,
  onFilesImported,
  onRemoveFile,
  onClearFiles,
  batchProgress,
  batchResult,
  resultsBySourcePath,
  activeBatchFiles,
  isProcessing,
  isStoppingBatch,
  isRetryingFailures,
  onCancelBatch,
  onRetryFailed,
  onRetrySources,
  onExportErrorLog,
  onDismissResults,
  sessionNotice,
  sessionWarning,
  onDismissSessionNotice,
  onDismissSessionWarning,
  onSavePresetDraft,
  onDeletePreset,
  onError,
}: BatchWorkbenchPageProps) {
  const [currentTab, setCurrentTab] = useState<SettingsTab>('compression');
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>('adjust');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewResultKey, setPreviewResultKey] = useState('');
  const [previewTransformKey, setPreviewTransformKey] = useState('');
  const [previewVisualKey, setPreviewVisualKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [sourceDragOver, setSourceDragOver] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceScanProgress, setSourceScanProgress] = useState<InputScanProgress | null>(null);
  const [sourceScanNotice, setSourceScanNotice] = useState<string | null>(null);
  const [compareSplit, setCompareSplit] = useState(50);
  const [previewTransform, setPreviewTransform] = useState<PreviewTransform>(DEFAULT_PREVIEW_TRANSFORM);
  const { zoom: previewZoom, pan: previewPan } = previewTransform;
  const [isSpacePanActive, setIsSpacePanActive] = useState(false);
  const [previewHoldMode, setPreviewHoldMode] = useState<'before' | 'after' | null>(null);
  const [originalSourceIndex, setOriginalSourceIndex] = useState(0);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [presetEditMode, setPresetEditMode] = useState<PresetEditMode>('none');
  const [presetEditOriginal, setPresetEditOriginal] = useState<AppPreset | null>(null);
  const [presetEditBaseline, setPresetEditBaseline] = useState<AppPreset | null>(null);
  const [presetDraftName, setPresetDraftName] = useState('');
  const [presetSaveError, setPresetSaveError] = useState<string | null>(null);
  const [presetSaveNudgeVisible, setPresetSaveNudgeVisible] = useState(false);
  const [presetSaveNudgePosition, setPresetSaveNudgePosition] = useState<FloatingPosition | null>(null);
  const [undoStack, setUndoStack] = useState<RecipeSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<RecipeSnapshot[]>([]);
  const [responsiveWidthDraft, setResponsiveWidthDraft] = useState('');
  const [responsiveWidthError, setResponsiveWidthError] = useState<string | null>(null);
  const [jobDetailsOpen, setJobDetailsOpen] = useState(false);
  const [resultDetailsOpen, setResultDetailsOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [summaryGuardOpen, setSummaryGuardOpen] = useState(false);
  const [presetDeleteTarget, setPresetDeleteTarget] = useState<AppPreset | null>(null);
  const [presetDeleteError, setPresetDeleteError] = useState<string | null>(null);
  const [previewViewportSize, setPreviewViewportSize] = useState({ width: 0, height: 0 });

  const previewCacheRef = useRef<Map<string, PreviewResult>>(new Map());
  const previewSettledRef = useRef<Set<string>>(new Set());
  const previewKeyRef = useRef<string>('');
  const previewSourcePathRef = useRef<string>('');
  const previewViewerRef = useRef<HTMLDivElement | null>(null);
  const imageFrameRef = useRef<HTMLDivElement | null>(null);
  const cropFocusFrameRef = useRef<number | null>(null);
  const sourceDragCounterRef = useRef(0);
  const activeSourceScanIdRef = useRef<string | null>(null);
  const isSpacePanActiveRef = useRef(false);
  const lastResizeDimensionRef = useRef<ResizeDimension>('width');
  const previewHoldKeysRef = useRef<Set<'before' | 'after'>>(new Set());
  const previewHoldTimersRef = useRef<Record<'before' | 'after', number | null>>({
    before: null,
    after: null,
  });
  const cancelledSourceScanIdsRef = useRef<Set<string>>(new Set());
  const presetSaveButtonRef = useRef<HTMLButtonElement | null>(null);
  const presetSaveNudgeRef = useRef<HTMLDivElement | null>(null);
  const previewInFlightRef = useRef<Map<string, Promise<PreviewResult | null>>>(new Map());
  const historyCoalesceRef = useRef<{ key: string; at: number } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const dragPendingRef = useRef<(() => void) | null>(null);
  const selectedSourceRowRef = useRef<HTMLDivElement | null>(null);
  const activePresetRef = useRef<AppPreset | null>(activePreset);

  // Handlers read the latest recipe from this ref instead of a render closure,
  // which keeps their identity stable across the dozens of renders a drag emits.
  activePresetRef.current = activePreset;

  const selectedFile = files[selectedIndex] || null;
  const isPresetEditing = presetEditMode !== 'none';
  const savedActivePreset = useMemo(() => {
    if (!activePreset) return null;
    return presets.find((preset) => preset.id === activePreset.id) || null;
  }, [activePreset, presets]);
  const recipeBaselinePreset = isPresetEditing ? presetEditBaseline : savedActivePreset;
  const isRecipeDirty = useMemo(() => {
    if (!activePreset || !recipeBaselinePreset) return false;
    return recipeFingerprint(activePreset) !== recipeFingerprint(recipeBaselinePreset);
  }, [activePreset, recipeBaselinePreset]);
  const recipeValidationIssues = useMemo(() => (
    activePreset ? validatePresetSettings(activePreset) : []
  ), [activePreset]);
  const blockingValidationIssues = [
    ...recipeValidationIssues,
  ].filter((issue) => issue.field !== 'mode');

  const resolvedSelectedPreset = useMemo(() => {
    if (!activePreset || !selectedFile) return null;
    const preset = clonePreset(activePreset);
    if (preset.output.format === 'keep-original') {
      preset.output.format = getBatchOutputFormat(preset.output.format, files);
    }
    return preset;
  }, [activePreset, files, selectedFile]);
  const scopedPreviewPreset = useMemo(() => {
    if (!resolvedSelectedPreset) return null;
    return clonePreset(resolvedSelectedPreset);
  }, [resolvedSelectedPreset]);
  const scopedPreviewCacheKey = useMemo(() => (
    selectedFile && scopedPreviewPreset
      ? getPreviewCacheKey(selectedFile, scopedPreviewPreset)
      : ''
  ), [scopedPreviewPreset, selectedFile]);
  const scopedPreviewTransformKey = useMemo(() => (
    selectedFile && scopedPreviewPreset
      ? getPreviewTransformKey(selectedFile, scopedPreviewPreset)
      : ''
  ), [scopedPreviewPreset, selectedFile]);
  const scopedPreviewVisualKey = useMemo(() => (
    selectedFile && scopedPreviewPreset
      ? getPreviewVisualKey(selectedFile, scopedPreviewPreset)
      : ''
  ), [scopedPreviewPreset, selectedFile]);
  const isPreviewCurrent = Boolean(preview && previewResultKey === scopedPreviewCacheKey);
  const isPreviewTransformCurrent = Boolean(preview && previewTransformKey === scopedPreviewTransformKey);
  const isPreviewVisualCurrent = Boolean(preview && previewVisualKey === scopedPreviewVisualKey);

  const editingPreset = activePreset;
  const editingValidationIssues = useMemo(() => (
    editingPreset ? validatePresetSettings(editingPreset) : []
  ), [editingPreset]);
  const usedRecipeSections = useMemo(() => getUsedRecipeSections(editingPreset), [editingPreset]);
  const hasPresetRecipeEdits = useMemo(() => {
    if (!editingPreset || !presetEditBaseline) return false;
    return getChangedRecipeSections(presetEditBaseline, editingPreset).length > 0;
  }, [editingPreset, presetEditBaseline]);

  const canEditTab = !isProcessing && inspectorMode === 'adjust';
  const recipePresetOptions = useMemo(() => presets, [presets]);
  const totalSourceSize = useMemo(
    () => files.reduce((total, file) => total + file.fileSize, 0),
    [files],
  );
  const jobFiles = isProcessing && activeBatchFiles.length > 0 ? activeBatchFiles : files;
  const completedJobCount = jobFiles.reduce((count, file) => (
    resultsBySourcePath[file.sourcePath] ? count + 1 : count
  ), 0);
  const jobPercent = jobFiles.length > 0 ? (completedJobCount / jobFiles.length) * 100 : 0;
  const needsCustomFolder = activePreset?.export.destination === 'custom'
    && activePreset.export.customPath.trim().length === 0;
  const firstSuccessfulResult = batchResult?.results.find((result) => result.success) || null;
  const outputFolder = firstSuccessfulResult ? getParentFolder(firstSuccessfulResult.outputPath) : '';
  const combinedResultsBySourcePath = useMemo(() => {
    const next: Record<string, ProcessedFileResult> = {};
    if (batchResult) {
      for (const result of batchResult.results) {
        next[result.sourcePath] = result;
      }
    }
    for (const [sourcePath, result] of Object.entries(resultsBySourcePath)) {
      next[sourcePath] = result;
    }
    return next;
  }, [batchResult, resultsBySourcePath]);
  const activeSourcePathSet = useMemo(() => (
    new Set(batchProgress?.activeFiles || [])
  ), [batchProgress?.activeFiles]);
  const getFileJobStatus = useCallback((file: InputFile): JobStatus => {
    const result = combinedResultsBySourcePath[file.sourcePath];
    if (result) return getResultStatus(result);
    if (activeSourcePathSet.has(file.sourcePath)) return 'active';
    return 'pending';
  }, [activeSourcePathSet, combinedResultsBySourcePath]);
  const jobRows = useMemo(() => jobFiles.map((file, index) => {
    const result = combinedResultsBySourcePath[file.sourcePath];
    const status = getFileJobStatus(file);
    return {
      file,
      index,
      status,
      result,
    };
  }), [combinedResultsBySourcePath, getFileJobStatus, jobFiles]);
  const jobCounts = useMemo(() => {
    const counts: Record<'all' | JobStatus, number> = {
      all: jobRows.length,
      active: 0,
      pending: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
    };
    for (const row of jobRows) {
      counts[row.status] += 1;
    }
    return counts;
  }, [jobRows]);
  const recoverableResults = useMemo(() => (
    batchResult?.results.filter(isRetryableResult) || []
  ), [batchResult]);
  const sourceRows = useMemo(() => files.map((file, index) => ({
    file,
    index,
    status: getFileJobStatus(file),
    result: combinedResultsBySourcePath[file.sourcePath],
  })), [combinedResultsBySourcePath, files, getFileJobStatus]);
  const actionableJobCount = jobCounts.failed + jobCounts.cancelled;
  const shouldShowJobDetails = isProcessing
    ? jobDetailsOpen || actionableJobCount > 0
    : Boolean(batchResult && resultDetailsOpen);
  const resultReceiptTone = recoverableResults.length > 0 ? 'needs-action' : 'success';

  const captureRecipeSnapshot = useCallback((): RecipeSnapshot | null => {
    const current = activePresetRef.current;
    if (!current) return null;
    return {
      activePreset: clonePreset(current),
    };
  }, []);

  const restoreRecipeSnapshot = useCallback((snapshot: RecipeSnapshot) => {
    setActivePreset(clonePreset(snapshot.activePreset));
  }, [setActivePreset]);

  /**
   * `coalesceKey` marks updates that belong to one continuous gesture so a
   * slider drag leaves one undo entry instead of one per animation frame.
   */
  const pushRecipeHistory = useCallback((coalesceKey?: string) => {
    if (coalesceKey) {
      const active = historyCoalesceRef.current;
      const now = Date.now();
      if (active && active.key === coalesceKey && now - active.at < HISTORY_COALESCE_WINDOW_MS) {
        active.at = now;
        return;
      }
      historyCoalesceRef.current = { key: coalesceKey, at: now };
    } else {
      historyCoalesceRef.current = null;
    }

    const snapshot = captureRecipeSnapshot();
    if (!snapshot) return;
    setUndoStack((prev) => [...prev.slice(-24), snapshot]);
    setRedoStack([]);
  }, [captureRecipeSnapshot]);

  const endRecipeHistoryCoalesce = useCallback(() => {
    historyCoalesceRef.current = null;
  }, []);

  /**
   * Pointer moves arrive far faster than the browser paints. Collapsing them to
   * one state update per frame keeps the crop box glued to the cursor instead of
   * queueing a re-render of the whole workbench per mousemove event.
   */
  const scheduleDragUpdate = useCallback((run: () => void) => {
    dragPendingRef.current = run;
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const pending = dragPendingRef.current;
      dragPendingRef.current = null;
      pending?.();
    });
  }, []);

  const flushDragUpdates = useCallback(() => {
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    const pending = dragPendingRef.current;
    dragPendingRef.current = null;
    pending?.();
  }, []);

  useEffect(() => () => {
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
    }
    dragPendingRef.current = null;
  }, []);

  const undoRecipeChange = useCallback(() => {
    if (undoStack.length === 0) return;
    const current = captureRecipeSnapshot();
    if (!current) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev.slice(-24), current]);
    restoreRecipeSnapshot(previous);
  }, [captureRecipeSnapshot, restoreRecipeSnapshot, undoStack]);

  const redoRecipeChange = useCallback(() => {
    if (redoStack.length === 0) return;
    const current = captureRecipeSnapshot();
    if (!current) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev.slice(-24), current]);
    restoreRecipeSnapshot(next);
  }, [captureRecipeSnapshot, redoStack, restoreRecipeSnapshot]);

  const selectPreset = useCallback((presetId: string) => {
    if (isProcessing || isPresetEditing) return;
    const preset = recipePresetOptions.find((item) => item.id === presetId);
    if (!preset) return;
    setActivePreset(clonePreset(preset));
    setUndoStack([]);
    setRedoStack([]);
    setPresetMenuOpen(false);
  }, [isPresetEditing, isProcessing, recipePresetOptions, setActivePreset]);

  const requestPresetSwitch = useCallback((presetId: string) => {
    if (presetId === activePreset?.id) return;
    selectPreset(presetId);
  }, [activePreset?.id, selectPreset]);

  const clearPresetEditSession = useCallback(() => {
    setPresetEditMode('none');
    setPresetEditOriginal(null);
    setPresetEditBaseline(null);
    setPresetDraftName('');
    setPresetSaveError(null);
    setPresetSaveNudgeVisible(false);
    setPresetSaveNudgePosition(null);
    setSummaryGuardOpen(false);
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const beginPresetEdit = useCallback((preset: AppPreset, mode: 'copy' | 'user') => {
    if (isProcessing || isPresetEditing) return;
    const draft = clonePreset(preset);
    if (mode === 'copy') {
      draft.name = `${preset.name} Copy`;
      draft.id = createDraftPresetId(draft.name);
    }
    setPresetEditOriginal(activePreset ? clonePreset(activePreset) : null);
    setPresetEditBaseline(clonePreset(draft));
    setPresetEditMode(mode);
    setPresetDraftName(draft.name);
    setPresetSaveError(null);
    setPresetSaveNudgeVisible(false);
    setPresetSaveNudgePosition(null);
    setActivePreset(draft);
    setPresetMenuOpen(false);
    setUndoStack([]);
    setRedoStack([]);
    setInspectorMode('adjust');
  }, [activePreset, isPresetEditing, isProcessing, setActivePreset]);

  const beginNewCustomPreset = useCallback(() => {
    if (isProcessing || isPresetEditing) return;
    // Capture whatever the user has dialled in right now. Starting from a blank
    // template silently discarded their current recipe.
    const draft = clonePreset(activePreset || BLANK_CUSTOM_PRESET_TEMPLATE);
    draft.name = NEW_PRESET_DEFAULT_NAME;
    draft.description = 'Saved from your current settings';
    draft.id = createDraftPresetId(draft.name);
    setPresetEditOriginal(activePreset ? clonePreset(activePreset) : null);
    setPresetEditBaseline(clonePreset(draft));
    setPresetEditMode('new');
    setPresetDraftName(draft.name);
    setPresetSaveError(null);
    setPresetSaveNudgeVisible(false);
    setPresetSaveNudgePosition(null);
    setActivePreset(draft);
    setPresetMenuOpen(false);
    setUndoStack([]);
    setRedoStack([]);
    setInspectorMode('adjust');
  }, [activePreset, isPresetEditing, isProcessing, setActivePreset]);

  const cancelPresetEdit = useCallback(() => {
    if (presetEditOriginal) {
      setActivePreset(clonePreset(presetEditOriginal));
    }
    clearPresetEditSession();
  }, [clearPresetEditSession, presetEditOriginal, setActivePreset]);

  /**
   * Typing stays in local draft state. Writing each keystroke into `activePreset`
   * re-ran every recipe memo and re-rendered the workbench per character; the name
   * is only committed to the preset on save.
   */
  const updatePresetDraftName = useCallback((name: string) => {
    setPresetDraftName(name);
    setPresetSaveError(null);
  }, []);

  const savePresetEdit = useCallback(async (): Promise<boolean> => {
    if (!activePreset) return false;
    if (!isPresetEditing && !isRecipeDirty) return true;

    const trimmedName = isPresetEditing ? presetDraftName.trim() : activePreset.name.trim();
    if (isPresetEditing && !trimmedName) {
      setPresetSaveError('Preset name is required.');
      return false;
    }

    const draft = clonePreset(activePreset);
    const isSavedUserPreset = draft.id.startsWith('user-');
    if (isPresetEditing) {
      draft.name = trimmedName;
      if (presetEditMode !== 'user' || !isSavedUserPreset) {
        draft.id = `user-${slugifyPresetName(trimmedName)}-${Date.now()}`;
      }
    } else if (!isSavedUserPreset) {
      draft.name = `${activePreset.name} Copy`;
      draft.id = `user-${slugifyPresetName(draft.name)}-${Date.now()}`;
    }

    try {
      setPresetSaveNudgeVisible(false);
      setPresetSaveNudgePosition(null);
      const savedPreset = await onSavePresetDraft(draft);
      setActivePreset(clonePreset(savedPreset));
      clearPresetEditSession();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPresetSaveError(`Could not save preset: ${message}`);
      return false;
    }
  }, [
    activePreset,
    clearPresetEditSession,
    isRecipeDirty,
    isPresetEditing,
    onSavePresetDraft,
    presetDraftName,
    presetEditMode,
    setActivePreset,
  ]);

  const requestPresetSave = useCallback(() => {
    // A brand-new preset already carries the recipe the user had open, so the
    // "you haven't edited anything yet" nudge only applies to copy/edit sessions.
    const needsEditNudge = isPresetEditing && presetEditMode !== 'new' && !hasPresetRecipeEdits;
    if (needsEditNudge && !presetSaveNudgeVisible) {
      setPresetSaveError(null);
      if (presetSaveButtonRef.current) {
        setPresetSaveNudgePosition(getPresetSaveNudgePosition(presetSaveButtonRef.current));
      }
      setPresetSaveNudgeVisible(true);
      return;
    }

    void savePresetEdit();
  }, [hasPresetRecipeEdits, isPresetEditing, presetEditMode, presetSaveNudgeVisible, savePresetEdit]);

  useEffect(() => {
    if (!isPresetEditing || hasPresetRecipeEdits) {
      setPresetSaveNudgeVisible(false);
      setPresetSaveNudgePosition(null);
    }
  }, [hasPresetRecipeEdits, isPresetEditing]);

  useLayoutEffect(() => {
    if (!presetSaveNudgeVisible) return undefined;

    const updatePresetSaveNudgePosition = () => {
      const button = presetSaveButtonRef.current;
      if (!button || !document.body.contains(button)) {
        setPresetSaveNudgeVisible(false);
        setPresetSaveNudgePosition(null);
        return;
      }
      setPresetSaveNudgePosition(getPresetSaveNudgePosition(button));
    };

    updatePresetSaveNudgePosition();
    window.addEventListener('scroll', updatePresetSaveNudgePosition, true);
    window.addEventListener('resize', updatePresetSaveNudgePosition);

    return () => {
      window.removeEventListener('scroll', updatePresetSaveNudgePosition, true);
      window.removeEventListener('resize', updatePresetSaveNudgePosition);
    };
  }, [presetSaveNudgeVisible]);

  useEffect(() => {
    if (!presetSaveNudgeVisible) return undefined;

    const closePresetSaveNudgeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (presetSaveButtonRef.current?.contains(target)) return;
      if (presetSaveNudgeRef.current?.contains(target)) return;

      setPresetSaveNudgeVisible(false);
      setPresetSaveNudgePosition(null);
    };

    document.addEventListener('pointerdown', closePresetSaveNudgeOnOutsideClick, true);

    return () => {
      document.removeEventListener('pointerdown', closePresetSaveNudgeOnOutsideClick, true);
    };
  }, [presetSaveNudgeVisible]);

  const requestFileSummary = useCallback(() => {
    if (isPresetEditing || isRecipeDirty) {
      setSummaryGuardOpen(true);
      return;
    }
    setInspectorMode('review');
  }, [isPresetEditing, isRecipeDirty]);

  const confirmSaveAndShowSummary = useCallback(async () => {
    const saved = await savePresetEdit();
    if (saved) {
      setSummaryGuardOpen(false);
      setInspectorMode('review');
    }
  }, [savePresetEdit]);

  const discardEditsAndShowSummary = useCallback(() => {
    setSummaryGuardOpen(false);
    if (isPresetEditing) {
      cancelPresetEdit();
      setInspectorMode('review');
      return;
    }
    if (savedActivePreset) {
      setActivePreset(clonePreset(savedActivePreset));
    }
    setUndoStack([]);
    setRedoStack([]);
    setInspectorMode('review');
  }, [cancelPresetEdit, isPresetEditing, savedActivePreset, setActivePreset]);

  const requestPresetDelete = useCallback((preset: AppPreset) => {
    if (isProcessing || !preset.id.startsWith('user-')) return;
    setPresetDeleteTarget(preset);
    setPresetDeleteError(null);
    setPresetMenuOpen(false);
  }, [isProcessing]);

  const confirmPresetDelete = useCallback(async () => {
    if (!presetDeleteTarget) return;

    try {
      await onDeletePreset(presetDeleteTarget);
      setPresetDeleteTarget(null);
      setPresetDeleteError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPresetDeleteError(`Could not delete preset: ${message}`);
    }
  }, [onDeletePreset, presetDeleteTarget]);

  const resetCurrentSection = useCallback(() => {
    if (!activePreset) return;
    pushRecipeHistory();

    const next = clonePreset(activePreset);
    for (const section of TAB_RECIPE_SECTIONS[currentTab]) {
      resetPresetSectionToNeutral(next, section);
    }
    if (currentTab === 'export') {
      next.naming = {
        ...next.naming,
        prefix: '',
        suffix: '',
      };
    }
    setActivePreset(next);
  }, [activePreset, currentTab, pushRecipeHistory, setActivePreset]);

  const getImageAspect = useCallback(() => {
    if (!editingPreset) return 1;
    const transformActive = editingPreset.transform.rotation !== 0
      || editingPreset.transform.flipH
      || editingPreset.transform.flipV;
    if (transformActive && preview?.cropBaseWidth && preview.cropBaseHeight) {
      return preview.cropBaseWidth / preview.cropBaseHeight;
    }
    const originalWidth = preview?.originalWidth || selectedFile?.width || 0;
    const originalHeight = preview?.originalHeight || selectedFile?.height || 0;
    if (originalWidth <= 0 || originalHeight <= 0) return 1;
    return getTransformAdjustedAspect(originalWidth, originalHeight, editingPreset.transform);
  }, [
    editingPreset,
    preview?.cropBaseHeight,
    preview?.cropBaseWidth,
    preview?.originalHeight,
    preview?.originalWidth,
    selectedFile?.height,
    selectedFile?.width,
  ]);

  const getCropFrame = useCallback(() => {
    const originalWidth = Math.max(1, preview?.originalWidth || selectedFile?.width || 1);
    const originalHeight = Math.max(1, preview?.originalHeight || selectedFile?.height || 1);
    const rotation = editingPreset?.transform.rotation || 0;
    const transformed = getTransformedDimensions(originalWidth, originalHeight, rotation);

    return {
      width: transformed.width,
      height: transformed.height,
      options: {
        imageWidth: originalWidth,
        imageHeight: originalHeight,
        rotation,
      },
    };
  }, [
    editingPreset?.transform.rotation,
    preview?.originalHeight,
    preview?.originalWidth,
    selectedFile?.height,
    selectedFile?.width,
  ]);

  /**
   * All recipe edits go through the functional setState form so overlapping
   * updates (drag handler + keyboard + async callback in the same tick) compose
   * instead of the last writer clobbering the others with a stale snapshot.
   */
  const updateOutput = useCallback((updater: (output: OutputSettings) => OutputSettings, coalesceKey?: string) => {
    if (!activePresetRef.current) return;
    pushRecipeHistory(coalesceKey);
    setActivePreset((prev) => (prev ? { ...prev, output: updater(prev.output) } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  const updateResize = useCallback((updater: (resize: ResizeSettings) => ResizeSettings, coalesceKey?: string) => {
    if (!activePresetRef.current) return;
    pushRecipeHistory(coalesceKey);
    setActivePreset((prev) => (prev ? { ...prev, resize: updater(prev.resize) } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  const updateResizeDimension = useCallback((dimension: ResizeDimension, value: number | undefined) => {
    if (!activePresetRef.current) return;
    lastResizeDimensionRef.current = dimension;
    pushRecipeHistory();
    setActivePreset((prev) => (prev ? {
      ...prev,
      resize: {
        ...prev.resize,
        [dimension]: value,
      },
      crop: prev.crop.aspectRatio
        ? normalizeCrop({ ...prev.crop, aspectRatio: null })
        : prev.crop,
    } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  const updateCrop = useCallback((updater: (crop: CropSettings) => CropSettings, coalesceKey?: string) => {
    if (!activePresetRef.current) return;
    pushRecipeHistory(coalesceKey);
    setActivePreset((prev) => (prev ? { ...prev, crop: normalizeCrop(updater(prev.crop)) } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  const updateTransform = useCallback((updater: (transform: TransformSettings) => TransformSettings, coalesceKey?: string) => {
    if (!activePresetRef.current) return;
    pushRecipeHistory(coalesceKey);
    setActivePreset((prev) => (prev ? { ...prev, transform: updater(prev.transform) } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  const updateMetadata = useCallback((updater: (metadata: AppPreset['metadata']) => AppPreset['metadata'], coalesceKey?: string) => {
    if (!activePresetRef.current) return;
    pushRecipeHistory(coalesceKey);
    setActivePreset((prev) => (prev ? { ...prev, metadata: updater(prev.metadata) } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  const updateNaming = useCallback((updater: (naming: AppPreset['naming']) => AppPreset['naming'], coalesceKey?: string) => {
    if (!activePresetRef.current) return;
    pushRecipeHistory(coalesceKey);
    setActivePreset((prev) => (prev ? { ...prev, naming: updater(prev.naming) } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  const updateBackgroundRemoval = useCallback((updater: (settings: NonNullable<AppPreset['backgroundRemoval']>) => AppPreset['backgroundRemoval']) => {
    if (!activePresetRef.current) return;
    pushRecipeHistory();
    setActivePreset((prev) => (prev ? {
      ...prev,
      backgroundRemoval: normalizeBackgroundRemovalSettings(updater(normalizeBackgroundRemovalSettings(prev.backgroundRemoval))),
    } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  const updateExport = useCallback((updater: (ex: AppPreset['export']) => AppPreset['export'], coalesceKey?: string) => {
    if (!activePresetRef.current) return;
    pushRecipeHistory(coalesceKey);
    setActivePreset((prev) => (prev ? { ...prev, export: updater(prev.export) } : prev));
  }, [pushRecipeHistory, setActivePreset]);

  useEffect(() => api.onScanProgress((progress) => {
    if (progress.scanId !== activeSourceScanIdRef.current) return;
    setSourceScanProgress(progress);
  }), []);

  useEffect(() => {
    if (isProcessing) {
      setResultDetailsOpen(false);
      setJobDetailsOpen(false);
    }
  }, [isProcessing]);

  useEffect(() => {
    if (!batchResult) return;
    const hasRecoverableResults = batchResult.results.some(isRetryableResult);
    setResultDetailsOpen(hasRecoverableResults);
  }, [batchResult]);

  const importPaths = useCallback(async (
    paths: string[],
    errorPrefix: string,
    mode: 'scan' | 'drop' = 'scan',
  ) => {
    if (paths.length === 0) return;

    const scanId = createScanId(`source-${mode}`);
    activeSourceScanIdRef.current = scanId;
    cancelledSourceScanIdsRef.current.delete(scanId);
    setSourceScanNotice(null);
    setSourceScanProgress({
      scanId,
      checkedCount: 0,
      acceptedCount: 0,
      skippedCount: 0,
      done: false,
      cancelled: false,
    });
    setSourceLoading(true);

    try {
      const result = mode === 'drop'
        ? await api.dropFiles(paths, scanId)
        : await api.scanInputs(paths, scanId);
      if (result.cancelled || cancelledSourceScanIdsRef.current.has(scanId)) {
        setSourceScanNotice('Import cancelled. No files from that scan were added.');
        return;
      }
      onFilesImported(result);
    } catch (err) {
      if (!cancelledSourceScanIdsRef.current.has(scanId)) {
        const message = err instanceof Error ? err.message : String(err);
        onError(`${errorPrefix}: ${message}`);
      }
    } finally {
      cancelledSourceScanIdsRef.current.delete(scanId);
      // A newer import may have started while this one was in flight; only the
      // scan that still owns the ref may clear the progress UI.
      if (activeSourceScanIdRef.current === scanId) {
        activeSourceScanIdRef.current = null;
        setSourceLoading(false);
        setSourceScanProgress(null);
      }
    }
  }, [onError, onFilesImported]);

  const cancelSourceScan = useCallback(() => {
    const scanId = activeSourceScanIdRef.current;
    if (!scanId) return;
    cancelledSourceScanIdsRef.current.add(scanId);
    activeSourceScanIdRef.current = null;
    setSourceLoading(false);
    setSourceScanNotice('Import cancelled. No files from that scan were added.');
    void api.cancelScan(scanId);
  }, []);

  const handleSourceDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    sourceDragCounterRef.current = 0;
    setSourceDragOver(false);
    const paths: string[] = [];
    for (let i = 0; i < event.dataTransfer.files.length; i++) {
      paths.push(api.getPathForFile(event.dataTransfer.files[i]));
    }

    await importPaths(paths, 'Could not import dropped files', 'drop');
  }, [importPaths]);

  const handleSourceDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    sourceDragCounterRef.current++;
    setSourceDragOver(true);
  }, []);

  const handleSourceDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  const handleSourceDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    sourceDragCounterRef.current--;
    if (sourceDragCounterRef.current <= 0) {
      sourceDragCounterRef.current = 0;
      setSourceDragOver(false);
    }
  }, []);

  const chooseSourceInputs = useCallback(async () => {
    try {
      const paths = await api.chooseSources();
      await importPaths(paths, 'Could not choose sources');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`Could not choose sources: ${message}`);
    }
  }, [importPaths, onError]);

  const handleRunFromWorkbench = useCallback(async () => {
    if (!activePreset) return;
    if (needsCustomFolder) {
      setCurrentTab('export');
      setInspectorMode('adjust');
      try {
        const folder = await api.chooseFolder();
        if (!folder) {
          return;
        }
        const presetWithFolder: AppPreset = {
          ...activePreset,
          export: {
            ...activePreset.export,
            destination: 'custom',
            customPath: folder,
          },
        };
        updateExport((ex) => ({
          ...ex,
          destination: 'custom',
          customPath: folder,
        }));
        onRunBatch(presetWithFolder);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onError(`Could not choose export folder: ${message}`);
      }
      return;
    }
    onRunBatch(activePreset);
  }, [activePreset, needsCustomFolder, onError, onRunBatch, updateExport]);

  const handleOpenOutputFolder = useCallback(async () => {
    if (!outputFolder) return;
    const result = await api.openFolder(outputFolder);
    if (result) {
      onError(`Could not open output folder: ${result}`);
    }
  }, [onError, outputFolder]);

  const requestClearFiles = useCallback(() => {
    if (isProcessing) return;
    if (batchResult || isRecipeDirty) {
      setClearConfirmOpen(true);
      return;
    }
    onClearFiles();
  }, [batchResult, isProcessing, isRecipeDirty, onClearFiles]);

  const dismissResults = useCallback(() => {
    setResultDetailsOpen(false);
    setJobDetailsOpen(false);
    onDismissResults();
  }, [onDismissResults]);

  const confirmClearFiles = useCallback(() => {
    setClearConfirmOpen(false);
    onClearFiles();
  }, [onClearFiles]);

  const openSourceFolder = useCallback(async (sourcePath: string) => {
    const result = await api.openFolder(getParentFolder(sourcePath));
    if (result) {
      onError(`Could not open source folder: ${result}`);
    }
  }, [onError]);

  const openResultOutput = useCallback(async (result: ProcessedFileResult) => {
    const outputPath = getResultOutputPath(result);
    const folder = outputPath ? getParentFolder(outputPath) : getParentFolder(result.sourcePath);
    const openResult = await api.openFolder(folder);
    if (openResult) {
      onError(`Could not open folder: ${openResult}`);
    }
  }, [onError]);

  const copyResultError = useCallback(async (result: ProcessedFileResult) => {
    const message = result.error || 'Processing failed without an error message.';
    try {
      await navigator.clipboard.writeText(`${getBaseName(result.sourcePath)}: ${message}`);
    } catch {
      onError('Could not copy error text.');
    }
  }, [onError]);

  /** Store a preview as most-recently-used and evict the coldest entries. */
  const rememberPreview = useCallback((cacheKey: string, result: PreviewResult) => {
    const cache = previewCacheRef.current;
    cache.delete(cacheKey);
    cache.set(cacheKey, result);

    while (cache.size > PREVIEW_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
      previewSettledRef.current.delete(oldest);
    }
  }, []);

  const readPreviewCache = useCallback((cacheKey: string): PreviewResult | null => {
    const cache = previewCacheRef.current;
    const cached = cache.get(cacheKey);
    if (!cached) return null;
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }, []);

  const applyPreviewResult = useCallback((
    file: InputFile,
    previewPreset: AppPreset,
    cacheKey: string,
    result: PreviewResult,
  ) => {
    if (previewKeyRef.current !== cacheKey) return;
    setPreview(result);
    setPreviewResultKey(cacheKey);
    setPreviewTransformKey(getPreviewTransformKey(file, previewPreset));
    setPreviewVisualKey(getPreviewVisualKey(file, previewPreset));
    previewSourcePathRef.current = file.sourcePath;
    setLoading(false);
  }, []);

  /**
   * One request per cache key. Without this, the selected preview and the
   * neighbour prefetch can queue duplicate sharp jobs for the same recipe.
   */
  const requestPreview = useCallback((
    file: InputFile,
    previewPreset: AppPreset,
    cacheKey: string,
  ): Promise<PreviewResult | null> => {
    const existing = previewInFlightRef.current.get(cacheKey);
    if (existing) return existing;

    const request = api.generatePreview(file, previewPreset)
      .then((result) => {
        rememberPreview(cacheKey, result);
        return result;
      })
      .catch((err: unknown): PreviewResult | null => {
        console.error('Preview error:', err);
        return null;
      })
      .finally(() => {
        if (previewSettledRef.current.size > PREVIEW_CACHE_MAX_ENTRIES * 4) {
          previewSettledRef.current.clear();
        }
        previewSettledRef.current.add(cacheKey);
        previewInFlightRef.current.delete(cacheKey);
      });

    previewInFlightRef.current.set(cacheKey, request);
    return request;
  }, [rememberPreview]);

  const loadPreviewForFile = useCallback(async (
    file: InputFile,
    previewPreset: AppPreset,
    setAsCurrent: boolean,
  ) => {
    const cacheKey = getPreviewCacheKey(file, previewPreset);

    const cached = readPreviewCache(cacheKey);
    if (cached && !isPreviewCacheUsable(cached, previewPreset)) {
      previewCacheRef.current.delete(cacheKey);
      previewSettledRef.current.delete(cacheKey);
    } else if (cached) {
      if (setAsCurrent) applyPreviewResult(file, previewPreset, cacheKey, cached);
      return;
    }

    const result = await requestPreview(file, previewPreset, cacheKey);
    if (!setAsCurrent || previewKeyRef.current !== cacheKey) return;

    if (result) {
      applyPreviewResult(file, previewPreset, cacheKey, result);
    } else {
      setPreviewError('Preview is unavailable for this sample. Select another image or re-add this source if it came from a restored session.');
      setLoading(false);
    }
  }, [applyPreviewResult, readPreviewCache, requestPreview]);

  const retrySelectedPreview = useCallback(() => {
    if (!selectedFile || !scopedPreviewPreset) return;
    const cacheKey = getPreviewCacheKey(selectedFile, scopedPreviewPreset);
    previewCacheRef.current.delete(cacheKey);
    previewSettledRef.current.delete(cacheKey);
    previewKeyRef.current = cacheKey;
    previewSourcePathRef.current = selectedFile.sourcePath;
    setPreviewError(null);
    setPreview(null);
    setPreviewResultKey('');
    setPreviewTransformKey('');
    setPreviewVisualKey('');
    setLoading(true);
    void loadPreviewForFile(selectedFile, scopedPreviewPreset, true);
  }, [loadPreviewForFile, scopedPreviewPreset, selectedFile]);

  const revealSelectedSource = useCallback(async () => {
    if (!selectedFile) return;
    await openSourceFolder(selectedFile.sourcePath);
  }, [openSourceFolder, selectedFile]);

  useEffect(() => {
    if (!selectedFile || !scopedPreviewPreset || !scopedPreviewCacheKey) return;

    const cacheKey = scopedPreviewCacheKey;
    previewKeyRef.current = cacheKey;
    previewSettledRef.current.delete(cacheKey);
    setPreviewError(null);
    const cachedPreviewCandidate = previewCacheRef.current.get(cacheKey) || null;
    const cachedPreview = cachedPreviewCandidate && isPreviewCacheUsable(cachedPreviewCandidate, scopedPreviewPreset)
      ? cachedPreviewCandidate
      : null;
    if (cachedPreviewCandidate && !cachedPreview) {
      previewCacheRef.current.delete(cacheKey);
      previewSettledRef.current.delete(cacheKey);
    }
    const sourceChanged = previewSourcePathRef.current !== selectedFile.sourcePath;
    if (cachedPreview) {
      setPreview(cachedPreview);
      setPreviewResultKey(cacheKey);
      setPreviewTransformKey(getPreviewTransformKey(selectedFile, scopedPreviewPreset));
      setPreviewVisualKey(getPreviewVisualKey(selectedFile, scopedPreviewPreset));
      previewSourcePathRef.current = selectedFile.sourcePath;
    } else if (sourceChanged) {
      setPreview(null);
      setPreviewResultKey('');
      setPreviewTransformKey('');
      setPreviewVisualKey('');
      previewSourcePathRef.current = selectedFile.sourcePath;
    }
    setLoading(!cachedPreview);

    const timeout = setTimeout(() => {
      if (
        previewKeyRef.current === cacheKey
        && !previewCacheRef.current.has(cacheKey)
        && !previewSettledRef.current.has(cacheKey)
      ) {
        setLoading(false);
        setPreviewError('Preview is taking longer than expected. Select another sample or re-add this source if it came from a restored session.');
      }
    }, 12000);

    const refreshDelay = currentTab === 'size' || currentTab === 'transform'
      ? INTERACTIVE_PREVIEW_REFRESH_DELAY_MS
      : PREVIEW_REFRESH_DELAY_MS;

    const timer = setTimeout(() => {
      void loadPreviewForFile(selectedFile, scopedPreviewPreset, true);
    }, refreshDelay);

    return () => {
      clearTimeout(timer);
      clearTimeout(timeout);
    };
  }, [currentTab, loadPreviewForFile, scopedPreviewCacheKey, scopedPreviewPreset, selectedFile]);

  // Warm the neighbouring previews only once the selected one has landed and the
  // user has paused, so prefetching never competes with the visible preview.
  useEffect(() => {
    if (!scopedPreviewPreset || !isPreviewCurrent || files.length < 2) return undefined;

    const timer = setTimeout(() => {
      for (const index of [selectedIndex - 1, selectedIndex + 1]) {
        const neighbour = files[index];
        if (neighbour) void loadPreviewForFile(neighbour, scopedPreviewPreset, false);
      }
    }, PREVIEW_PREFETCH_DELAY_MS);

    return () => clearTimeout(timer);
  }, [files, isPreviewCurrent, loadPreviewForFile, scopedPreviewPreset, selectedIndex]);

  useEffect(() => {
    const viewer = previewViewerRef.current;
    if (!viewer) return undefined;

    const updateViewportSize = () => {
      const rect = viewer.getBoundingClientRect();
      const styles = window.getComputedStyle(viewer);
      const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const width = Math.max(1, rect.width - paddingX);
      const height = Math.max(1, rect.height - paddingY);

      setPreviewViewportSize((current) => (
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height }
      ));
    };

    updateViewportSize();

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateViewportSize)
      : null;
    resizeObserver?.observe(viewer);
    window.addEventListener('resize', updateViewportSize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateViewportSize);
    };
  }, []);

  // Keep the selected source visible. Previously an inline ref callback ran this
  // on every render, forcing a synchronous layout of the whole list mid-drag.
  useEffect(() => {
    selectedSourceRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, selectedFile?.sourcePath]);

  useEffect(() => {
    setCompareSplit(50);
    setPreviewTransform(DEFAULT_PREVIEW_TRANSFORM);
    isSpacePanActiveRef.current = false;
    setIsSpacePanActive(false);
    setPreviewHoldMode(null);
    setOriginalSourceIndex(0);
  }, [selectedFile?.sourcePath]);

  useEffect(() => {
    setOriginalSourceIndex(0);
  }, [preview?.originalDataUrl, selectedFile?.sourcePath]);

  // Arrow key navigation for file list
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input/textarea/select
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (
        currentTab === 'size'
        && canEditTab
        && editingPreset?.crop.enabled
        && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)
      ) {
        e.preventDefault();
        const delta = e.shiftKey ? 5 : 1;
        updateCrop((crop) => {
          const normalized = normalizeCrop(crop);
          const maxX = Math.max(0, 100 - normalized.width);
          const maxY = Math.max(0, 100 - normalized.height);
          if (e.key === 'ArrowLeft') return { ...normalized, x: clamp(normalized.x - delta, 0, maxX) };
          if (e.key === 'ArrowRight') return { ...normalized, x: clamp(normalized.x + delta, 0, maxX) };
          if (e.key === 'ArrowUp') return { ...normalized, y: clamp(normalized.y - delta, 0, maxY) };
          return { ...normalized, y: clamp(normalized.y + delta, 0, maxY) };
        });
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(Math.min(selectedIndex + 1, files.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(Math.max(selectedIndex - 1, 0));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canEditTab, currentTab, editingPreset?.crop.enabled, files.length, selectedIndex, setSelectedIndex, updateCrop]);

  useEffect(() => {
    const handleHistoryKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;

      event.preventDefault();
      if (event.shiftKey) {
        redoRecipeChange();
      } else {
        undoRecipeChange();
      }
    };
    window.addEventListener('keydown', handleHistoryKeyDown);
    return () => window.removeEventListener('keydown', handleHistoryKeyDown);
  }, [redoRecipeChange, undoRecipeChange]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      const tag = element.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return element.isContentEditable;
    };

    const isTextEntryTarget = (target: EventTarget | null): boolean => {
      const element = target as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
      if (!element) return false;
      if (element.isContentEditable) return true;
      if (element.tagName === 'TEXTAREA') return true;
      if (element.tagName !== 'INPUT') return false;
      const input = element as HTMLInputElement;
      return ['email', 'password', 'search', 'tel', 'text', 'url'].includes(input.type);
    };

    const syncPreviewHoldMode = () => {
      if (previewHoldKeysRef.current.has('after')) {
        setPreviewHoldMode('after');
      } else if (previewHoldKeysRef.current.has('before')) {
        setPreviewHoldMode('before');
      } else {
        setPreviewHoldMode(null);
      }
    };

    const clearPreviewHoldTimer = (mode: 'before' | 'after') => {
      const timer = previewHoldTimersRef.current[mode];
      if (timer !== null) {
        window.clearTimeout(timer);
        previewHoldTimersRef.current[mode] = null;
      }
    };

    const clearPreviewHoldTimers = () => {
      clearPreviewHoldTimer('before');
      clearPreviewHoldTimer('after');
    };

    const startPreviewHold = (mode: 'before' | 'after') => {
      if (previewHoldKeysRef.current.has(mode) || previewHoldTimersRef.current[mode] !== null) return;

      previewHoldTimersRef.current[mode] = window.setTimeout(() => {
        previewHoldTimersRef.current[mode] = null;
        previewHoldKeysRef.current.add(mode);
        syncPreviewHoldMode();
      }, PREVIEW_HOLD_DELAY_MS);
    };

    const stopPreviewHold = (mode: 'before' | 'after') => {
      clearPreviewHoldTimer(mode);
      previewHoldKeysRef.current.delete(mode);
      syncPreviewHoldMode();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isPlainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (isPlainKey && !isEditableTarget(event.target) && key === 'b') {
        startPreviewHold('before');
        return;
      }
      if (isPlainKey && !isEditableTarget(event.target) && key === 'n') {
        startPreviewHold('after');
        return;
      }
      if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
        if (isTextEntryTarget(event.target)) return;
        event.preventDefault();
        isSpacePanActiveRef.current = true;
        setIsSpacePanActive(true);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'b') {
        stopPreviewHold('before');
        return;
      }
      if (key === 'n') {
        stopPreviewHold('after');
        return;
      }
      if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
        isSpacePanActiveRef.current = false;
        setIsSpacePanActive(false);
      }
    };

    const onWindowBlur = () => {
      clearPreviewHoldTimers();
      previewHoldKeysRef.current.clear();
      setPreviewHoldMode(null);
      isSpacePanActiveRef.current = false;
      setIsSpacePanActive(false);
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onWindowBlur);

    return () => {
      clearPreviewHoldTimers();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, []);

  const startPan = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSpacePanActiveRef.current) return;
    if ((e.target as HTMLElement).closest('.crop-region-react')) return;
    if ((e.target as HTMLElement).closest('.crop-handle-react')) return;
    if ((e.target as HTMLElement).closest('.compare-divider')) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startPanX = previewPan.x;
    const startPanY = previewPan.y;

    const onMove = (moveEvent: MouseEvent) => {
      const { clientX, clientY } = moveEvent;
      scheduleDragUpdate(() => {
        setPreviewTransform((current) => ({
          ...current,
          pan: {
            x: startPanX + clientX - startX,
            y: startPanY + clientY - startY,
          },
        }));
      });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      flushDragUpdates();
    };

    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [flushDragUpdates, previewPan.x, previewPan.y, scheduleDragUpdate]);

  const handleWheelZoom = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const deltaPixels = clamp(
      getWheelDeltaPixels(e),
      -PREVIEW_WHEEL_DELTA_CAP,
      PREVIEW_WHEEL_DELTA_CAP,
    );
    const zoomSpeed = e.ctrlKey ? PREVIEW_PINCH_ZOOM_SPEED : PREVIEW_WHEEL_ZOOM_SPEED;
    const zoomFactor = Math.exp(-deltaPixels * zoomSpeed);
    const rect = imageFrameRef.current?.getBoundingClientRect();
    const clientX = e.clientX;
    const clientY = e.clientY;

    setPreviewTransform((current) => {
      const nextZoom = clamp(
        Number((current.zoom * zoomFactor).toFixed(3)),
        PREVIEW_ZOOM_MIN,
        PREVIEW_ZOOM_MAX,
      );
      if (nextZoom === current.zoom) return current;

      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return {
          ...current,
          zoom: nextZoom,
        };
      }

      return {
        zoom: nextZoom,
        pan: getCursorAnchoredPreviewPan(current.pan, current.zoom, nextZoom, rect, clientX, clientY),
      };
    });
  }, []);

  const focusCropInPreview = useCallback((): boolean => {
    const viewer = previewViewerRef.current;
    const frame = imageFrameRef.current;
    if (!viewer || !frame) return false;

    const frameWidth = frame.offsetWidth;
    const frameHeight = frame.offsetHeight;
    const viewerRect = viewer.getBoundingClientRect();
    if (frameWidth <= 0 || frameHeight <= 0 || viewerRect.width <= 0 || viewerRect.height <= 0) {
      return false;
    }

    if (!editingPreset?.crop.enabled) {
      setPreviewTransform(DEFAULT_PREVIEW_TRANSFORM);
      return true;
    }

    const cropFrame = getCropFrame();
    const crop = resolveCropPercent(
      editingPreset.crop,
      cropFrame.width,
      cropFrame.height,
      cropFrame.options,
    );
    const cropWidthPx = Math.max(1, (crop.width / 100) * frameWidth);
    const cropHeightPx = Math.max(1, (crop.height / 100) * frameHeight);
    const availableWidth = Math.max(1, viewerRect.width - CROP_FOCUS_PADDING_PX * 2);
    const availableHeight = Math.max(1, viewerRect.height - CROP_FOCUS_PADDING_PX * 2);
    const nextZoom = clamp(
      Number(Math.min(availableWidth / cropWidthPx, availableHeight / cropHeightPx, PREVIEW_ZOOM_MAX).toFixed(2)),
      PREVIEW_ZOOM_MIN,
      PREVIEW_ZOOM_MAX,
    );

    const cropCenterX = ((crop.x + crop.width / 2) / 100) * frameWidth;
    const cropCenterY = ((crop.y + crop.height / 2) / 100) * frameHeight;

    setPreviewTransform({
      zoom: nextZoom,
      pan: {
        x: (frameWidth / 2 - cropCenterX) * nextZoom,
        y: (frameHeight / 2 - cropCenterY) * nextZoom,
      },
    });
    return true;
  }, [editingPreset, getCropFrame]);

  const scheduleCropPreviewFocus = useCallback(() => {
    if (cropFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(cropFocusFrameRef.current);
    }

    let attempts = 0;
    const run = () => {
      cropFocusFrameRef.current = null;
      if (focusCropInPreview() || attempts >= 8) return;

      attempts += 1;
      cropFocusFrameRef.current = window.requestAnimationFrame(run);
    };

    cropFocusFrameRef.current = window.requestAnimationFrame(run);
  }, [focusCropInPreview]);

  const selectSettingsTab = useCallback((tab: SettingsTab) => {
    setCurrentTab(tab);
    if (tab === 'size' && editingPreset?.crop.enabled) {
      scheduleCropPreviewFocus();
    }
  }, [editingPreset?.crop.enabled, scheduleCropPreviewFocus]);

  useEffect(() => () => {
    if (cropFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(cropFocusFrameRef.current);
    }
  }, []);

  const updateCompareSplitFromClientX = useCallback((clientX: number, element: HTMLElement | null) => {
    const stack = element?.closest('.compare-stack') as HTMLElement | null;
    const rect = stack?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setCompareSplit(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100));
  }, []);

  const startCompareDrag = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget;
    updateCompareSplitFromClientX(event.clientX, target);

    const onMove = (moveEvent: MouseEvent) => {
      const { clientX } = moveEvent;
      scheduleDragUpdate(() => updateCompareSplitFromClientX(clientX, target));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      flushDragUpdates();
    };

    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [flushDragUpdates, scheduleDragUpdate, updateCompareSplitFromClientX]);

  const handleCompareDividerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setCompareSplit((value) => clamp(value - 2, 0, 100));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setCompareSplit((value) => clamp(value + 2, 0, 100));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setCompareSplit(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setCompareSplit(100);
    }
  }, []);

  const startCropMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!editingPreset || !canEditTab || currentTab !== 'size') return;
    if ((e.target as HTMLElement).dataset.handle) return;

    const rect = imageFrameRef.current?.getBoundingClientRect();
    if (!rect) return;

    const cropFrame = getCropFrame();
    const startCrop = resolveCropPercent(
      editingPreset.crop,
      cropFrame.width,
      cropFrame.height,
      cropFrame.options,
    );
    const startMX = e.clientX;
    const startMY = e.clientY;

    const onMove = (moveEvent: MouseEvent) => {
      const { clientX, clientY } = moveEvent;
      scheduleDragUpdate(() => {
        const dx = ((clientX - startMX) / rect.width) * 100;
        const dy = ((clientY - startMY) / rect.height) * 100;
        const snapX = (CROP_EDGE_SNAP_THRESHOLD_PX / rect.width) * 100;
        const snapY = (CROP_EDGE_SNAP_THRESHOLD_PX / rect.height) * 100;

        let newX = clamp(startCrop.x + dx, 0, 100 - startCrop.width);
        let newY = clamp(startCrop.y + dy, 0, 100 - startCrop.height);

        if (newX < snapX) newX = 0;
        if (newY < snapY) newY = 0;
        if (newX + startCrop.width > 100 - snapX) newX = 100 - startCrop.width;
        if (newY + startCrop.height > 100 - snapY) newY = 100 - startCrop.height;

        updateCrop(() => ({ ...startCrop, x: newX, y: newY }), 'crop.move');
      });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      flushDragUpdates();
      endRecipeHistoryCoalesce();
    };

    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [
    canEditTab,
    currentTab,
    editingPreset,
    endRecipeHistoryCoalesce,
    flushDragUpdates,
    getCropFrame,
    scheduleDragUpdate,
    updateCrop,
  ]);

  const startCropResize = useCallback((handle: string, e: React.MouseEvent<HTMLDivElement>) => {
    if (!editingPreset || !canEditTab || currentTab !== 'size') return;
    const rect = imageFrameRef.current?.getBoundingClientRect();
    if (!rect) return;

    const cropFrame = getCropFrame();
    const startCrop = resolveCropPercent(
      editingPreset.crop,
      cropFrame.width,
      cropFrame.height,
      cropFrame.options,
    );
    const startMX = e.clientX;
    const startMY = e.clientY;
    const imageAspect = getImageAspect();

    const applyResize = (clientX: number, clientY: number) => {
      const dx = ((clientX - startMX) / rect.width) * 100;
      const dy = ((clientY - startMY) / rect.height) * 100;
      const snapX = (CROP_EDGE_SNAP_THRESHOLD_PX / rect.width) * 100;
      const snapY = (CROP_EDGE_SNAP_THRESHOLD_PX / rect.height) * 100;

      let x = startCrop.x;
      let y = startCrop.y;
      let width = startCrop.width;
      let height = startCrop.height;

      if (handle.includes('w')) {
        x = startCrop.x + dx;
        width = startCrop.width - dx;
      }
      if (handle.includes('e')) {
        width = startCrop.width + dx;
      }
      if (handle.includes('n')) {
        y = startCrop.y + dy;
        height = startCrop.height - dy;
      }
      if (handle.includes('s')) {
        height = startCrop.height + dy;
      }

      if (handle.includes('w') && x < snapX) {
        width += x;
        x = 0;
      }
      if (handle.includes('n') && y < snapY) {
        height += y;
        y = 0;
      }
      if (handle.includes('e') && x + width > 100 - snapX) {
        width = 100 - x;
      }
      if (handle.includes('s') && y + height > 100 - snapY) {
        height = 100 - y;
      }

      if (width < 2) {
        width = 2;
        if (handle.includes('w')) x = startCrop.x + startCrop.width - 2;
      }
      if (height < 2) {
        height = 2;
        if (handle.includes('n')) y = startCrop.y + startCrop.height - 2;
      }

      if (x < 0) {
        width += x;
        x = 0;
      }
      if (y < 0) {
        height += y;
        y = 0;
      }
      if (x + width > 100) width = 100 - x;
      if (y + height > 100) height = 100 - y;

      const parsedAspect = parseCropAspectRatio(startCrop.aspectRatio);
      if (parsedAspect) {
        const ratio = parsedAspect.rw / parsedAspect.rh;
        if (handle === 'n' || handle === 's') {
          width = height * ratio / imageAspect;
          if (x + width > 100) {
            width = 100 - x;
            height = width * imageAspect / ratio;
          }
        } else if (handle === 'w' || handle === 'e') {
          height = width * imageAspect / ratio;
          if (y + height > 100) {
            height = 100 - y;
            width = height * ratio / imageAspect;
          }
        } else {
          height = width * imageAspect / ratio;
          if (y + height > 100) {
            height = 100 - y;
            width = height * ratio / imageAspect;
          }
          if (handle.includes('n')) {
            y = startCrop.y + startCrop.height - height;
          }
        }
      }

      updateCrop(() => normalizeCrop({ ...startCrop, x, y, width, height }), 'crop.resize');
    };

    const onMove = (moveEvent: MouseEvent) => {
      const { clientX, clientY } = moveEvent;
      scheduleDragUpdate(() => applyResize(clientX, clientY));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      flushDragUpdates();
      endRecipeHistoryCoalesce();
    };

    e.preventDefault();
    e.stopPropagation();
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [
    canEditTab,
    currentTab,
    editingPreset,
    endRecipeHistoryCoalesce,
    flushDragUpdates,
    getCropFrame,
    getImageAspect,
    scheduleDragUpdate,
    updateCrop,
  ]);

  if (files.length === 0) {
    return (
      <DropZone
        files={files}
        thumbnails={thumbnails}
        presets={presets}
        activePreset={activePreset}
        onPresetChange={(preset) => requestPresetSwitch(preset.id)}
        onDeletePreset={onDeletePreset}
        onFilesImported={onFilesImported}
        onRemoveFile={onRemoveFile}
        onClearFiles={onClearFiles}
        onError={onError}
      />
    );
  }

  if (!activePreset || !editingPreset || !selectedFile || !resolvedSelectedPreset) {
    return null;
  }

  const o = editingPreset.output;
  const r = editingPreset.resize;
  const responsiveWidths = Array.isArray(r.responsiveWidths) ? r.responsiveWidths : [];
  const cropFrame = getCropFrame();
  const c = resolveCropPercent(
    editingPreset.crop,
    cropFrame.width,
    cropFrame.height,
    cropFrame.options,
  );
  const t = editingPreset.transform;
  const currentSectionValidationIssues = editingValidationIssues.filter((issue) => (
    TAB_RECIPE_SECTIONS[currentTab].includes(issue.section)
  ));
  const selectedOutputFormat = getBatchOutputFormat(editingPreset.output.format, files);
  const metadataSettings = normalizeMetadataSettings(editingPreset.metadata);
  const backgroundRemovalSettings = normalizeBackgroundRemovalSettings(editingPreset.backgroundRemoval);
  const syntheticImageMode = metadataSettings.syntheticMode || 'off';
  const metadataRewriteMode = metadataSettings.rewriteMode || 'off';
  const syntheticImageProcessingEnabled = isSyntheticImageProcessingEnabled(metadataSettings);
  const metadataRewriteEnabled = isMetadataRewriteEnabled(metadataSettings);
  const timestampRewriteEnabled = metadataRewriteUsesTimestamp(metadataSettings);
  const creatorRewriteEnabled = metadataRewriteUsesCreator(metadataSettings);
  const creatorNameMissing = creatorRewriteEnabled && (metadataSettings.creatorName || '').trim().length === 0;
  const metadataRewriteHelpCopy = timestampRewriteEnabled && creatorRewriteEnabled
    ? 'Adds jittered XMP timestamps and the creator metadata you provide after cleanup.'
    : timestampRewriteEnabled
      ? 'Adds jittered XMP timestamps after cleanup.'
      : 'Adds only the creator metadata you provide after cleanup.';
  const metadataRewritePrivacyNote = editingPreset.metadata.mode === 'strip-all'
    ? ' Strict privacy still removes original metadata first; this intentionally adds only the selected fields back.'
    : '';
  const visibleCurrentSectionValidationIssues = currentSectionValidationIssues.filter((issue) => !(
    currentTab === 'metadata'
    && issue.field === 'creatorName'
    && creatorRewriteEnabled
  ));
  const strictPrivacyForcesAiTermStripping = editingPreset.metadata.mode === 'strip-all';
  const aiTermStrippingEnabled = shouldStripAiSourceTerms(editingPreset.metadata.mode, editingPreset.naming);
  const exportFilenameCandidate = aiTermStrippingEnabled
    ? stripAiSourceTerms(selectedFile.fileName)
    : selectedFile.fileName;
  const exportFilenameStem = sanitizeFileSegment(exportFilenameCandidate) || 'image';
  const exportFileEnding = `.${selectedOutputFormat}`;
  const namingExample = buildNamingExample(selectedFile, resolvedSelectedPreset, selectedIndex, {
    width: preview?.outputWidth || r.width,
    height: preview?.outputHeight || r.height,
  });
  const currentTabLabel = TAB_LIST.find((tab) => tab.id === currentTab)?.label || 'Settings';
  const inspectorBatchJob = (
    <div className={`workbench-run-bar inspector-run-bar ${needsCustomFolder ? 'needs-attention' : ''}`}>
      <div className="run-bar-summary">
        <div className="inspector-run-title-row">
          <div className="section-label">
            {isProcessing ? (isStoppingBatch ? 'Stopping Batch' : 'Processing') : batchResult ? 'Results' : 'Batch Job'}
          </div>
          {batchResult && !isProcessing && (
            <button
              type="button"
              className="btn btn-ghost inspector-results-title-close"
              aria-label="Close results"
              data-tooltip="Close results"
              onClick={dismissResults}
            >
              <svg className="preset-button-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 6 12 12" />
                <path d="m18 6-12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="run-bar-title">
          {isProcessing
            ? `${completedJobCount} of ${jobFiles.length} processed`
            : batchResult
              ? `${batchResult.successCount} processed${batchResult.failureCount > 0 ? `, ${batchResult.failureCount} failed` : ''}`
              : `${files.length} source image${files.length !== 1 ? 's' : ''} using ${activePreset.name}`}
        </div>
        <div className="text-xs text-secondary">
          {isProcessing
            ? activeSourcePathSet.size > 0
              ? `Working on ${activeSourcePathSet.size} file${activeSourcePathSet.size === 1 ? '' : 's'}`
              : isStoppingBatch ? 'Finishing in-flight files' : 'Preparing files'
            : batchResult
              ? `${formatSize(batchResult.totalOriginalBytes)} to ${formatSize(batchResult.totalOutputBytes)} · ${batchResult.totalSavedBytes >= 0 ? 'Saved' : 'Increased by'} ${formatSize(Math.abs(batchResult.totalSavedBytes))}`
              : `${summarizeResize(activePreset.resize)} · ${activePreset.output.format} · ${summarizeDestination(activePreset)}`}
        </div>
        {isProcessing && (
          <div className="batch-progress-bar compact inspector-run-progress" aria-label={`${Math.round(jobPercent)}% complete`}>
            <div className="batch-progress-fill" style={{ width: `${jobPercent}%` }} />
          </div>
        )}
        {needsCustomFolder && (
          <div className="run-bar-warning">Choose a custom export folder before processing.</div>
        )}
        {!needsCustomFolder && blockingValidationIssues.length > 0 && (
          <div className="run-bar-warning">{blockingValidationIssues[0].message}</div>
        )}
      </div>
      <div className="run-bar-actions">
        {isProcessing ? (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setJobDetailsOpen((open) => !open)}
              aria-expanded={shouldShowJobDetails}
            >
              {shouldShowJobDetails ? 'Hide Queue' : 'View Queue'}
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={onCancelBatch} disabled={isStoppingBatch}>
              {isStoppingBatch ? 'Stopping...' : 'Cancel'}
            </button>
          </>
        ) : batchResult ? (
          <>
            {outputFolder && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleOpenOutputFolder()}>
                Open Output
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setResultDetailsOpen((open) => !open)}
              aria-expanded={shouldShowJobDetails}
            >
              {shouldShowJobDetails ? 'Hide Log' : 'View Log'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-run-batch"
            onClick={handleRunFromWorkbench}
            disabled={blockingValidationIssues.length > 0}
          >
            {needsCustomFolder ? 'Choose Folder' : `Run Batch (${files.length})`}
          </button>
        )}
      </div>
    </div>
  );

  const savings = preview ? preview.originalSize - preview.outputSize : 0;
  const savingsPercent = preview && preview.originalSize > 0
    ? (Math.abs(savings / preview.originalSize) * 100).toFixed(1)
    : '0';
  const savingsSign = savings >= 0 ? '-' : '+';
  const savingsDeltaText = `${savingsSign}${formatSize(Math.abs(savings))} (${savingsSign}${savingsPercent}%)`;
  const compressionEstimateSizeText = !preview
    ? 'Calculating estimate...'
    : !isPreviewCurrent
      ? 'Updating estimate...'
      : `${formatSize(preview.originalSize)} -> ${formatSize(preview.outputSize)}`;

  const localFileSource = toLocalFileUrl(selectedFile.sourcePath);
  const originalCandidates = [
    preview?.originalDataUrl,
    localFileSource,
  ].filter((value): value is string => Boolean(value));
  const originalSource = originalCandidates[originalSourceIndex] || null;
  const transformActive = isTransformActive(editingPreset);
  const shouldUseStableTransformPreview = currentTab === 'transform' && transformActive;
  const processedSource = !shouldUseStableTransformPreview && preview
    && isPreviewCurrent
    && preview.dataUrl !== preview.originalDataUrl
    ? preview.dataUrl
    : null;
  const visualEditsActive = transformActive
    || c.enabled
    || r.mode !== 'none'
    || editingPreset.metadata.convertToSrgb;
  const canUseTransformOnlyCompareBase = transformActive
    && !c.enabled
    && r.mode === 'none'
    && !editingPreset.metadata.convertToSrgb;
  const compareBaseSource = !shouldUseStableTransformPreview && preview
    && (isPreviewCurrent || isPreviewVisualCurrent)
    ? preview.compareBaseDataUrl
      || (canUseTransformOnlyCompareBase ? preview.cropBaseDataUrl || null : null)
      || (visualEditsActive ? null : originalSource)
    : null;
  const cropEditSource = currentTab === 'size' && c.enabled
    ? transformActive
      ? preview && isPreviewTransformCurrent
        ? preview.cropBaseDataUrl || null
        : null
      : originalSource
    : null;
  const isCropOverlayVisible = currentTab === 'size' && c.enabled && Boolean(cropEditSource);
  const isCropSurfaceLoading = currentTab === 'size'
    && c.enabled
    && transformActive
    && !cropEditSource
    && loading;
  const localTransformActive = shouldUseStableTransformPreview
    || (!processedSource
      && !cropEditSource
      && !compareBaseSource
      && transformActive);
  const originalFrameWidth = Math.max(1, preview?.originalWidth || selectedFile.width || 1);
  const originalFrameHeight = Math.max(1, preview?.originalHeight || selectedFile.height || 1);
  const transformedFrame = getTransformedDimensions(originalFrameWidth, originalFrameHeight, t.rotation);
  const localFrame = getContainedFrameSize(
    transformedFrame.width,
    transformedFrame.height,
    previewViewportSize.width || transformedFrame.width,
    previewViewportSize.height || transformedFrame.height,
  );
  const localImageWidth = originalFrameWidth * localFrame.scale;
  const localImageHeight = originalFrameHeight * localFrame.scale;
  const localTransformFrameStyle: React.CSSProperties | undefined = localTransformActive
    ? {
      width: `${localFrame.width}px`,
      height: `${localFrame.height}px`,
    }
    : undefined;
  const localBaseImageStyle: React.CSSProperties | undefined = localTransformActive
    ? {
      width: `${localImageWidth}px`,
      height: `${localImageHeight}px`,
      left: `${(localFrame.width - localImageWidth) / 2}px`,
      top: `${(localFrame.height - localImageHeight) / 2}px`,
    }
    : undefined;
  const localTransformStyle: React.CSSProperties | undefined = localTransformActive && previewHoldMode !== 'before'
    ? {
      ...localBaseImageStyle,
      transform: getOutputAxisTransformMatrix(t),
    }
    : localBaseImageStyle;
  const isCompareFrameVisible = !cropEditSource && Boolean(
    processedSource && (compareBaseSource || !visualEditsActive),
  );
  const isCompareOverlayVisible = Boolean(
    processedSource && isCompareFrameVisible,
  );
  const singleImagePreview = Boolean(cropEditSource) || !isCompareFrameVisible;
  const displaySource = cropEditSource
    || (processedSource && !isCompareFrameVisible
      ? processedSource
      : compareBaseSource || originalSource);
  const beforeDisplaySource = isCompareFrameVisible
    ? compareBaseSource || originalSource
    : originalSource;
  const afterDisplaySource = processedSource;
  const effectiveCompareSplit = previewHoldMode === 'before'
    ? 100
    : previewHoldMode === 'after'
      ? 0
      : compareSplit;
  const isCompareDividerVisible = Boolean(isCompareFrameVisible && !previewHoldMode);
  const isPreviewHoldBadgeVisible = Boolean(isCompareFrameVisible);
  const isPreviewResetVisible = Boolean(
    originalSource
      && (
        Math.abs(previewZoom - DEFAULT_PREVIEW_TRANSFORM.zoom) > 0.001
        || Math.abs(previewPan.x - DEFAULT_PREVIEW_TRANSFORM.pan.x) > 0.5
        || Math.abs(previewPan.y - DEFAULT_PREVIEW_TRANSFORM.pan.y) > 0.5
      ),
  );
  const compareDividerStyle = {
    left: `${effectiveCompareSplit}%`,
    '--preview-inverse-zoom': `${1 / Math.max(previewZoom, 0.001)}`,
  } as React.CSSProperties;

  const applyRatio = (ratio: string | null) => {
    if (!activePreset) return;
    const imageAspect = getImageAspect();
    const nextCropBase = normalizeCrop({ ...activePreset.crop, aspectRatio: ratio });
    const nextCrop = !ratio
      ? normalizeCrop(nextCropBase)
      : nextCropBase.positionMode === 'anchor'
        ? applyAspectFromAnchor(nextCropBase, imageAspect)
        : applyAspectPreservingOffset(nextCropBase, imageAspect);
    const nextResize = ratio
      ? reconcileResizeToAspect(activePreset.resize, ratio, lastResizeDimensionRef.current)
      : activePreset.resize;

    pushRecipeHistory();
    setActivePreset({
      ...activePreset,
      crop: nextCrop,
      resize: nextResize,
    });
  };

  const rotateBy = (delta: number) => {
    updateTransform((transform) => ({
      ...transform,
      rotation: clamp(Math.round((transform.rotation + delta) * 10) / 10, -180, 180),
    }));
  };

  const applyHorizontalFlip = () => {
    updateTransform((transform) => ({
      ...transform,
      flipH: !transform.flipH,
    }));
  };

  const applyVerticalFlip = () => {
    updateTransform((transform) => ({
      ...transform,
      flipV: !transform.flipV,
    }));
  };

  const addResponsiveWidthDraft = () => {
    const tokens = responsiveWidthDraft
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      setResponsiveWidthError('Enter a width in pixels.');
      return;
    }

    const parsed: number[] = [];
    for (const token of tokens) {
      const width = Number(token);
      if (!Number.isInteger(width) || width <= 0) {
        setResponsiveWidthError(`"${token}" is not a valid positive pixel width.`);
        return;
      }
      parsed.push(width);
    }

    const unique = new Set(responsiveWidths);
    for (const width of parsed) unique.add(width);
    updateResize((resize) => ({
      ...resize,
      responsiveWidths: Array.from(unique).sort((a, b) => a - b),
    }));
    setResponsiveWidthDraft('');
    setResponsiveWidthError(null);
  };

  const removeResponsiveWidth = (width: number) => {
    updateResize((resize) => ({
      ...resize,
      responsiveWidths: responsiveWidths.filter((item) => item !== width),
    }));
  };

  return (
    <>
    <div
      className={`batch-workbench fade-in ${sourceDragOver ? 'source-drag-over' : ''}`}
      onDrop={handleSourceDrop}
      onDragEnter={handleSourceDragEnter}
      onDragOver={handleSourceDragOver}
      onDragLeave={handleSourceDragLeave}
    >
      <aside className="source-tray">
        <div className="source-tray-header">
          <div>
            <div className="section-label">Batch Sources</div>
            <div className="source-tray-title">
              {files.length} image{files.length !== 1 ? 's' : ''}
            </div>
            <div className="text-xs text-secondary">{formatSize(totalSourceSize)} selected</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={requestClearFiles} disabled={isProcessing}>
            Clear
          </button>
        </div>

        <div className={`source-add-zone source-add-zone-compact ${sourceDragOver ? 'drag-over' : ''}`}>
          {sourceLoading ? (
            <div className="source-scan-status">
              <div className="spinner spinner-sm" />
              <span>Scanning sources...</span>
              {sourceScanProgress && (
                <small>
                  {sourceScanProgress.checkedCount} checked
                  {' · '}
                  {sourceScanProgress.acceptedCount} images
                  {' · '}
                  {sourceScanProgress.skippedCount} skipped
                </small>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={cancelSourceScan}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="source-add-picker"
              onClick={() => void chooseSourceInputs()}
              disabled={isProcessing}
            >
              Click or drop files or folders
            </button>
          )}
          {sourceScanNotice && (
            <div className="source-import-summary">{sourceScanNotice}</div>
          )}
        </div>

        {selectedFile && (
          <div className="selected-source-detail">
            <span>{formatSize(selectedFile.fileSize)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDimensions(selectedFile)}</span>
          </div>
        )}

        <div className="source-list">
          {sourceRows.map(({ file: f, index: i, status }) => {
            const isSelectedSource = i === selectedIndex;
            return (
              <div
                key={f.sourcePath}
                className={`source-file-row ${isSelectedSource ? 'active' : ''}`}
                ref={isSelectedSource ? selectedSourceRowRef : undefined}
              >
                <button
                  type="button"
                  className="source-file-select"
                  onClick={() => setSelectedIndex(i)}
                >
                  <SourceThumbnail src={thumbnails[f.sourcePath] || toLocalFileUrl(f.sourcePath)} />
                  <span className="source-file-meta">
                    <span className="source-file-name">{f.fileName}{f.extension}</span>
                    <span className="source-file-detail">
                      {isSelectedSource ? `${formatSize(f.fileSize)} · ${formatDimensions(f)}` : ''}
                      {status !== 'pending' && (
                        <>
                          {isSelectedSource ? ' · ' : ''}
                          <span className={`status-text status-${status}`}>{JOB_STATUS_LABELS[status]}</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="source-remove-button"
                  onClick={() => onRemoveFile(f.sourcePath)}
                  disabled={isProcessing}
                  aria-label={`Remove ${f.fileName}${f.extension}`}
                >
                  <TrashIcon />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="preview-main-panel">
        {(sessionWarning || sessionNotice) && (
          <div className={`workflow-banner ${sessionWarning ? 'workflow-banner-warning' : 'workflow-banner-info'}`}>
            <span>{sessionWarning || sessionNotice}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={sessionWarning ? onDismissSessionWarning : onDismissSessionNotice}
            >
              Dismiss
            </button>
          </div>
        )}
        <div
          ref={previewViewerRef}
          className={`preview-viewer preview-checkerboard ${isSpacePanActive ? 'pan-ready' : ''}`}
          onMouseDown={startPan}
          onWheel={handleWheelZoom}
        >
          {originalSource ? (
            <div
              className="preview-image-frame"
              style={{ transform: `matrix(${previewZoom}, 0, 0, ${previewZoom}, ${previewPan.x}, ${previewPan.y})` }}
            >
              <div
                ref={imageFrameRef}
                className={`compare-stack ${localTransformActive ? 'local-transform-frame' : ''}`}
                style={localTransformFrameStyle}
              >
                {singleImagePreview ? (
                  <img
                    className={`preview-image ${localTransformStyle ? 'local-transform-image' : ''}`}
                    src={displaySource || originalSource}
                    alt={previewHoldMode === 'before' ? 'Original preview' : 'Processed preview'}
                    draggable={false}
                    style={localTransformStyle}
                    onError={() => {
                      if (displaySource === originalSource) {
                        setOriginalSourceIndex((index) => (
                          Math.min(index + 1, originalCandidates.length)
                        ));
                      }
                    }}
                  />
                ) : (
                  <>
                    <img
                      className="preview-image"
                      src={beforeDisplaySource || originalSource}
                      alt="Before preview"
                      draggable={false}
                      onError={() => {
                        if (beforeDisplaySource === originalSource) {
                          setOriginalSourceIndex((index) => (
                            Math.min(index + 1, originalCandidates.length)
                          ));
                        }
                      }}
                    />
                    {isCompareOverlayVisible && (
                      <img
                        className="preview-image compare-overlay-image"
                        src={afterDisplaySource || originalSource}
                        alt="Processed preview"
                        draggable={false}
                        style={{ clipPath: `inset(0 0 0 ${effectiveCompareSplit}%)` }}
                      />
                    )}
                  </>
                )}
                {isCompareDividerVisible && (
                  <div
                    className="compare-divider"
                    style={compareDividerStyle}
                    onMouseDown={startCompareDrag}
                    onKeyDown={handleCompareDividerKeyDown}
                    tabIndex={0}
                    role="slider"
                    aria-label="Before and after split"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(compareSplit)}
                  />
                )}

                {isCropOverlayVisible && (
                  <div className="crop-overlay-react">
                    <svg
                      className="crop-dim-react"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        fillRule="evenodd"
                        d={`M0 0H100V100H0Z M${c.x} ${c.y}H${c.x + c.width}V${c.y + c.height}H${c.x}Z`}
                      />
                    </svg>

                    <div
                      className="crop-region-react"
                      style={{ top: `${c.y}%`, left: `${c.x}%`, width: `${c.width}%`, height: `${c.height}%` }}
                      onMouseDown={startCropMove}
                    >
                      {['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'].map((handle) => (
                        <div
                          key={handle}
                          className={`crop-handle-react crop-handle-${handle}`}
                          data-handle={handle}
                          onMouseDown={(event) => startCropResize(handle, event)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {isCropSurfaceLoading && (
                  <div className="preview-loading-overlay" aria-live="polite" aria-label="Updating preview">
                    <div className="spinner spinner-sm" />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="preview-error-state">
              <div>{previewError || 'No preview available'}</div>
              <div className="preview-error-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={retrySelectedPreview}>
                  Retry Preview
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revealSelectedSource()}>
                  Open Source Folder
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemoveFile(selectedFile.sourcePath)} disabled={isProcessing}>
                  Remove Source
                </button>
              </div>
            </div>
          )}

          {isPreviewHoldBadgeVisible && (
            <div className="preview-shortcut-badge">
              Hold B for Before · Hold N for After
            </div>
          )}

          {originalSource && (
            <div className="preview-pan-hint">Hold Space, then drag to pan</div>
          )}

          {isPreviewResetVisible && (
            <button
              type="button"
              className="btn btn-secondary btn-sm preview-zoom-reset"
              onClick={() => setPreviewTransform(DEFAULT_PREVIEW_TRANSFORM)}
              aria-label="Reset preview zoom to 100%"
            >
              100%
            </button>
          )}

          {currentTab === 'size' && c.enabled && (
            <div className="crop-mini-toolbar">
              <button
                type="button"
                className={`btn btn-sm ${c.enabled ? 'btn-secondary' : 'btn-primary'}`}
                disabled={!canEditTab}
                onClick={() => updateCrop((crop) => ({ ...crop, enabled: !crop.enabled }))}
              >
                {c.enabled ? 'Crop On' : 'Enable Crop'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!canEditTab}
                onClick={() => updateCrop(() => normalizeCrop({
                  ...c,
                  enabled: true,
                  x: Math.max(0, (100 - c.width) / 2),
                  y: Math.max(0, (100 - c.height) / 2),
                }))}
              >
                Center
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!canEditTab}
                onClick={() => updateCrop(() => ({ ...RECIPE_NEUTRAL_CROP }))}
              >
                Reset
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!canEditTab}
                onClick={() => applyRatio('1:1')}
              >
                1:1
              </button>
            </div>
          )}
        </div>

        <div className="preview-info-bar">
          {preview && (
            <>
              <div className="preview-info-item">
                <span className="preview-info-label">Size:</span>
                <span className="preview-info-value">
                  {formatSize(preview.originalSize)} → {formatSize(preview.outputSize)}
                </span>
              </div>
              <div className="preview-info-item">
                <span className="preview-info-label">Savings:</span>
                <span className={`preview-info-value ${savings >= 0 ? 'savings' : 'increase'}`}>
                  {savingsDeltaText}
                </span>
        </div>
              <div className="preview-info-item">
                <span className="preview-info-label">Dimensions:</span>
                <span className="preview-info-value">
                  {preview.originalWidth}×{preview.originalHeight} → {preview.outputWidth}×{preview.outputHeight}
                </span>
              </div>
            </>
          )}

        </div>

        {shouldShowJobDetails && (isProcessing || batchResult) && (
          <div className={`workbench-job-panel ${shouldShowJobDetails ? 'expanded' : 'compact'} ${resultReceiptTone}`}>
            {isProcessing ? (
              <>
                <div className="job-panel-header">
                  <div>
                    <div className="section-label">{isStoppingBatch ? 'Stopping Batch' : 'Processing'}</div>
                    <div className="job-panel-title">
                      {completedJobCount} of {jobFiles.length} processed
                    </div>
                    <div className="text-xs text-secondary">
                      Processing up to 4 files at once.
                      {' '}
                      {activeSourcePathSet.size > 0
                        ? `Active: ${jobRows.filter((row) => row.status === 'active').map((row) => `${row.file.fileName}${row.file.extension}`).join(', ')}`
                        : isStoppingBatch
                          ? 'Finishing in-flight files; pending files will be marked cancelled.'
                          : 'Waiting for the next file.'}
                    </div>
                  </div>
                  <div className="job-panel-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setJobDetailsOpen((open) => !open)}
                      aria-expanded={shouldShowJobDetails}
                    >
                      {shouldShowJobDetails ? 'Hide Queue' : 'View Queue'}
                    </button>
                    <button type="button" className="btn btn-danger btn-sm" onClick={onCancelBatch} disabled={isStoppingBatch}>
                      {isStoppingBatch ? 'Stopping...' : 'Cancel'}
                    </button>
                  </div>
                </div>
                <div className="batch-progress-bar compact">
                  <div className="batch-progress-fill" style={{ width: `${jobPercent}%` }} />
                </div>
                {shouldShowJobDetails && (
                  <>
                    <div className="job-table" role="table" aria-label="Batch processing jobs">
                      <div className="job-table-head" role="row">
                        <span>Source</span>
                        <span>Status</span>
                        <span>Details</span>
                        <span>Actions</span>
                      </div>
                      {jobRows.map((row) => (
                        <div key={row.file.sourcePath} className="job-table-row" role="row">
                          <button
                            type="button"
                            className="job-source-cell"
                            onClick={() => setSelectedIndex(files.findIndex((file) => file.sourcePath === row.file.sourcePath))}
                          >
                            <strong>{row.file.fileName}{row.file.extension}</strong>
                            <span>{formatSize(row.file.fileSize)} · {formatDimensions(row.file)}</span>
                          </button>
                          <span className={`job-status-pill status-${row.status}`}>{JOB_STATUS_LABELS[row.status]}</span>
                          <span className="job-detail-cell">
                            {row.result
                              ? row.result.success
                                ? `${formatSize(row.result.outputSize)} output`
                                : row.result.error || JOB_STATUS_LABELS[row.status]
                              : 'Waiting'}
                          </span>
                          <span className="job-row-actions">
                            <RowActionsMenu
                              label={`Actions for ${row.file.fileName}${row.file.extension}`}
                              actions={[
                                {
                                  label: 'Select source',
                                  onClick: () => setSelectedIndex(files.findIndex((file) => file.sourcePath === row.file.sourcePath)),
                                },
                                {
                                  label: 'Reveal source folder',
                                  onClick: () => void openSourceFolder(row.file.sourcePath),
                                },
                              ]}
                            />
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : batchResult ? (
              <>
                <div className="job-panel-header">
                  <div className="job-panel-results-copy">
                    <div className="job-panel-results-title-row">
                      <div className="section-label">Results</div>
                      <button
                        type="button"
                        className="btn btn-ghost job-panel-results-close"
                        aria-label="Close results"
                        data-tooltip="Close results"
                        onClick={dismissResults}
                      >
                        <svg className="preset-button-icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m6 6 12 12" />
                          <path d="m18 6-12 12" />
                        </svg>
                      </button>
                    </div>
                    <div className="job-panel-title">
                      {batchResult.successCount} processed
                      {batchResult.failureCount > 0 ? `, ${batchResult.failureCount} failed` : ''}
                      {batchResult.cancelledCount > 0 ? `, ${batchResult.cancelledCount} cancelled` : ''}
                    </div>
                    <div className="text-xs text-secondary">
                      {formatSize(batchResult.totalOriginalBytes)}
                      {' to '}
                      {formatSize(batchResult.totalOutputBytes)}
                      {' · '}
                      {batchResult.totalSavedBytes >= 0 ? 'Saved' : 'Increased by'} {formatSize(Math.abs(batchResult.totalSavedBytes))}
                      {recoverableResults.length === 0 ? ' · Full log collapsed' : ' · Recovery needed'}
                    </div>
                  </div>
                </div>
                <div className="job-panel-actions job-panel-result-actions">
                    {outputFolder && (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleOpenOutputFolder()}>
                        Open Output
                      </button>
                    )}
                    {recoverableResults.length > 0 && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={onRetryFailed} disabled={isRetryingFailures}>
                        {isRetryingFailures ? 'Retrying...' : `Retry Recoverable - Previous Settings (${recoverableResults.length})`}
                      </button>
                    )}
                    {recoverableResults.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => onRetrySources(recoverableResults.map((result) => result.sourcePath), false)}
                        disabled={isRetryingFailures}
                      >
                        Retry Recoverable - Current Recipe
                      </button>
                    )}
                    {batchResult.failureCount > 0 && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={onExportErrorLog}>
                        Export Error Log
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setResultDetailsOpen((open) => !open)}
                      aria-expanded={shouldShowJobDetails}
                    >
                      {shouldShowJobDetails ? 'Hide Log' : recoverableResults.length > 0 ? 'Show Recovery' : 'View Log'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={requestClearFiles}>
                      New Batch
                    </button>
                </div>
                {shouldShowJobDetails && (
                  <>
                    <div className="job-table" role="table" aria-label="Batch results">
                      <div className="job-table-head" role="row">
                        <span>Source</span>
                        <span>Status</span>
                        <span>Output or Error</span>
                        <span>Actions</span>
                      </div>
                      {jobRows.map((row) => (
                        <div key={row.file.sourcePath} className="job-table-row" role="row">
                          <button
                            type="button"
                            className="job-source-cell"
                            onClick={() => setSelectedIndex(files.findIndex((file) => file.sourcePath === row.file.sourcePath))}
                          >
                            <strong>{row.file.fileName}{row.file.extension}</strong>
                            <span>{formatSize(row.file.fileSize)} · {formatDimensions(row.file)}</span>
                          </button>
                          <span className={`job-status-pill status-${row.status}`}>{JOB_STATUS_LABELS[row.status]}</span>
                          <span className="job-detail-cell">
                            {row.result?.success
                              ? getResultDetail(row.result)
                              : row.result?.error || JOB_STATUS_LABELS[row.status]}
                          </span>
                          <span className="job-row-actions">
                            {row.result && !row.result.success && (
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyResultError(row.result as ProcessedFileResult)}>
                                Copy Error
                              </button>
                            )}
                            {row.result && isRetryableResult(row.result) && (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => onRetrySources([row.file.sourcePath], true)}
                                disabled={isRetryingFailures}
                              >
                                Retry Previous
                              </button>
                            )}
                            <RowActionsMenu
                              label={`Actions for ${row.file.fileName}${row.file.extension}`}
                              actions={[
                                {
                                  label: 'Select source',
                                  onClick: () => setSelectedIndex(files.findIndex((file) => file.sourcePath === row.file.sourcePath)),
                                },
                                {
                                  label: 'Reveal source folder',
                                  onClick: () => void openSourceFolder(row.file.sourcePath),
                                },
                                ...(row.result ? [{
                                  label: 'Reveal output folder',
                                  onClick: () => {
                                    void openResultOutput(row.result as ProcessedFileResult);
                                  },
                                }] : []),
                                {
                                  label: 'Remove source',
                                  danger: true,
                                  onClick: () => onRemoveFile(row.file.sourcePath),
                                },
                              ]}
                            />
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>

      <div className="preview-inspector-rail">
        <div className="preview-inspector-header">
          <div className="inspector-title-row">
            <div>
              <div className="section-label">
                Recipe Inspector
                {isRecipeDirty && <span className="dirty-badge">Modified</span>}
              </div>
            </div>
          </div>

          {isPresetEditing && (
            <div className="preset-edit-banner">
              <div className="preset-edit-banner-copy">
                <strong>Editing {presetDraftName.trim() || activePreset.name} preset</strong>
                <span>
                  {presetEditMode === 'user'
                    ? 'Changes update this saved preset.'
                    : presetEditMode === 'new'
                      ? 'Save creates a new preset.'
                      : 'Save creates a user-owned copy.'}
                </span>
              </div>
              <label className="preset-edit-name">
                <span>Name</span>
                <input
                  type="text"
                  value={presetDraftName}
                  disabled={isProcessing}
                  onChange={(event) => updatePresetDraftName(event.target.value)}
                />
              </label>
              <div className="preset-edit-actions">
                <button
                  ref={presetSaveButtonRef}
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={isProcessing || presetDraftName.trim().length === 0}
                  aria-describedby={presetSaveNudgeVisible ? 'preset-save-nudge' : undefined}
                  onClick={requestPresetSave}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={isProcessing}
                  onClick={cancelPresetEdit}
                >
                  Cancel
                </button>
              </div>
              {presetSaveError && <div className="preset-edit-error">{presetSaveError}</div>}
            </div>
          )}

          {!isPresetEditing && (
            <div className="recipe-picker">
              <label id="recipe-preset-label">Preset</label>
              <div className="preset-menu">
                <button
                  type="button"
                  className="preset-menu-trigger"
                  disabled={isProcessing}
                  aria-haspopup="listbox"
                  aria-expanded={presetMenuOpen}
                  aria-labelledby="recipe-preset-label"
                  onClick={() => setPresetMenuOpen((open) => !open)}
                >
                  <span>{activePreset.name}</span>
                  <span className="preset-menu-caret" aria-hidden="true" />
                </button>
                <PresetPickerModal
                  open={presetMenuOpen}
                  presets={recipePresetOptions}
                  activePresetId={activePreset.id}
                  disabled={isProcessing}
                  onSelect={(preset) => selectPreset(preset.id)}
                  onCreate={beginNewCustomPreset}
                  onEdit={(preset) => {
                    const mode = preset.id.startsWith('user-') ? 'user' : 'copy';
                    beginPresetEdit(preset, mode);
                  }}
                  onDelete={requestPresetDelete}
                  onClose={() => setPresetMenuOpen(false)}
                />
              </div>
              <div className="recipe-picker-description">{activePreset.description}</div>
            </div>
          )}

          <div className="inspector-segment">
            <button
              type="button"
              className={inspectorMode === 'adjust' ? 'active' : ''}
              onClick={() => setInspectorMode('adjust')}
              disabled={isProcessing}
            >
              Edit
            </button>
            <button
              type="button"
              className={inspectorMode === 'review' ? 'active' : ''}
              onClick={requestFileSummary}
            >
              File Summary
            </button>
          </div>

        </div>

        {inspectorMode === 'review' ? (
          <div className="preview-review-content">
            <div className="review-block">
              <div className="section-label">Selected Sample</div>
              <div className="review-file-name">{selectedFile.fileName}{selectedFile.extension}</div>
              <div className="text-xs text-secondary">{formatSize(selectedFile.fileSize)} original</div>
            </div>

            <div className="review-block">
              <div className="section-label">Batch Recipe</div>
              <div className="review-summary-list">
                <div><span>Preset</span><strong>{activePreset.name}</strong></div>
                <div><span>Format</span><strong>{resolvedSelectedPreset.output.format}</strong></div>
                <div><span>Resize</span><strong>{summarizeResize(resolvedSelectedPreset.resize)}</strong></div>
                <div><span>Remove Background</span><strong>{isBackgroundRemovalEnabled(resolvedSelectedPreset) ? 'On' : 'Off'}</strong></div>
                <div><span>Export</span><strong>{summarizeDestination(resolvedSelectedPreset)}</strong></div>
              </div>
            </div>

            <div className="review-block">
              <div className="section-label">Preview Result</div>
              {loading && (
                  <div className="review-loading-row">
                    <div className="spinner spinner-sm" />
                  <span className="text-sm text-secondary">Preparing sample</span>
                  </div>
                )}
              {!loading && preview && (
                <div className="review-summary-list">
                  <div><span>Output</span><strong>{formatSize(preview.outputSize)}</strong></div>
                  <div><span>Savings</span><strong className={`savings-summary-value ${savings >= 0 ? 'savings' : 'increase'}`}>
                    {savingsDeltaText}
                  </strong></div>
                  <div><span>Dimensions</span><strong>{preview.originalWidth}x{preview.originalHeight} to {preview.outputWidth}x{preview.outputHeight}</strong></div>
                </div>
              )}
              {!loading && !preview && (
                <div className="review-recovery">
                  <div className="text-sm text-secondary">{previewError || 'No generated preview for this sample.'}</div>
                  <div className="preview-error-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={retrySelectedPreview}>
                      Retry Preview
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revealSelectedSource()}>
                      Open Source Folder
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemoveFile(selectedFile.sourcePath)} disabled={isProcessing}>
                      Remove Source
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="review-actions">
              {inspectorBatchJob}
            </div>
          </div>
        ) : (
          <div className="preview-adjust-layout">
            <div className="settings-tabs settings-tabs-vertical">
              {TAB_LIST.map((tab) => (
                <button
                  type="button"
                  key={tab.id}
                  className={[
                    'settings-tab',
                    currentTab === tab.id ? 'active' : '',
                    usedRecipeSections[tab.id] ? 'used' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => selectSettingsTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="preview-adjust-panel">
              <div className="preview-adjust-content">
          <div className="preview-adjust-title-row">
            <div className="preview-adjust-title">{currentTabLabel}</div>
            <button
              className="btn btn-secondary btn-sm"
              disabled={!canEditTab}
              onClick={resetCurrentSection}
            >
              Reset
            </button>
          </div>
          {visibleCurrentSectionValidationIssues.length > 0 && (
            <div className="inline-validation-list">
              {visibleCurrentSectionValidationIssues.map((issue) => (
                <div key={`${issue.section}-${issue.field}`}>{issue.message}</div>
              ))}
            </div>
          )}

          {currentTab === 'compression' && (
            <>
              <div className="section-label">Format & Quality</div>

              <div className="setting-row">
                <span className="setting-label">Format</span>
                <div className="setting-control">
                  <SettingSelect
                    ariaLabel="Format"
                    disabled={!canEditTab}
                    value={o.format}
                    options={OUTPUT_FORMAT_OPTIONS}
                    onChange={(format) => updateOutput((out) => ({ ...out, format }))}
                  />
                </div>
              </div>

              {(o.format === 'jpeg' || (o.format === 'keep-original' && selectedOutputFormat === 'jpeg')) && (
                <div className="setting-row">
                  <span className="setting-label">JPEG Quality</span>
                  <div className="setting-control">
                    <SliderNumberInput
                      ariaLabel="JPEG quality"
                      disabled={!canEditTab}
                      min={1}
                      max={100}
                      value={o.jpegQuality}
                      onChange={(jpegQuality) => updateOutput((out) => ({ ...out, jpegQuality }), 'output.jpegQuality')}
                      onCommit={endRecipeHistoryCoalesce}
                    />
                  </div>
                </div>
              )}

              {(o.format === 'png' || (o.format === 'keep-original' && selectedOutputFormat === 'png')) && (
                <>
                  <div className="setting-row">
                    <span className="setting-label">PNG Effort</span>
                    <div className="setting-control">
                      <SliderNumberInput
                        ariaLabel="PNG effort"
                        disabled={!canEditTab}
                        min={0}
                        max={9}
                        value={o.pngCompressionLevel}
                        onChange={(pngCompressionLevel) => updateOutput((out) => ({ ...out, pngCompressionLevel }), 'output.pngCompressionLevel')}
                        onCommit={endRecipeHistoryCoalesce}
                      />
                    </div>
                  </div>
                  <div className="control-help setting-help">Higher effort can make PNG files smaller. It is not visual quality.</div>
                </>
              )}

              {(o.format === 'webp' || (o.format === 'keep-original' && selectedOutputFormat === 'webp')) && (
                <div className="setting-row">
                  <span className="setting-label">WebP Quality</span>
                  <div className="setting-control">
                    <SliderNumberInput
                      ariaLabel="WebP quality"
                      disabled={!canEditTab}
                      min={1}
                      max={100}
                      value={o.webpQuality}
                      onChange={(webpQuality) => updateOutput((out) => ({ ...out, webpQuality }), 'output.webpQuality')}
                      onCommit={endRecipeHistoryCoalesce}
                    />
                  </div>
                </div>
              )}

              {(o.format === 'avif' || (o.format === 'keep-original' && selectedOutputFormat === 'avif')) && (
                <div className="setting-row">
                  <span className="setting-label">AVIF Quality</span>
                  <div className="setting-control">
                    <SliderNumberInput
                      ariaLabel="AVIF quality"
                      disabled={!canEditTab}
                      min={1}
                      max={100}
                      value={o.avifQuality}
                      onChange={(avifQuality) => updateOutput((out) => ({ ...out, avifQuality }), 'output.avifQuality')}
                      onCommit={endRecipeHistoryCoalesce}
                    />
                  </div>
                </div>
              )}

              {(o.format === 'tiff' || (o.format === 'keep-original' && selectedOutputFormat === 'tiff')) && (
                <div className="setting-row">
                  <span className="setting-label">TIFF Quality</span>
                  <div className="setting-control">
                    <SliderNumberInput
                      ariaLabel="TIFF quality"
                      disabled={!canEditTab}
                      min={1}
                      max={100}
                      value={o.jpegQuality}
                      onChange={(jpegQuality) => updateOutput((out) => ({ ...out, jpegQuality }), 'output.jpegQuality')}
                      onCommit={endRecipeHistoryCoalesce}
                    />
                  </div>
                </div>
              )}

              {(o.format === 'webp' || o.format === 'avif' || (
                o.format === 'keep-original' && ['webp', 'avif'].includes(selectedOutputFormat)
              )) && (
                <div
                  className="setting-row"
                  data-tooltip="Impact: keeps exact pixels with no compression artifacts. Usually larger than lossy WebP/AVIF at the same quality. Turn it off when smaller files matter more."
                  data-tooltip-placement="left"
                  data-tooltip-width="340"
                >
                  <span className="setting-label">Lossless</span>
                  <div className="setting-control">
                    <button
                      type="button"
                      aria-label="Toggle lossless mode"
                      aria-pressed={o.lossless}
                      disabled={!canEditTab}
                      className={`toggle ${o.lossless ? 'on' : ''}`}
                      onClick={() => canEditTab && updateOutput((out) => ({ ...out, lossless: !out.lossless }))}
                    />
                  </div>
                </div>
              )}

              <div className="compression-estimate" aria-live="polite">
                <span>Expected savings</span>
                <div className="compression-estimate-values">
                  <span className="compression-estimate-size">{compressionEstimateSizeText}</span>
                  {preview && isPreviewCurrent && (
                    <span className={`compression-estimate-delta ${savings >= 0 ? 'savings' : 'increase'}`}>
                      {savingsDeltaText}
                    </span>
                  )}
                </div>
              </div>
            </>
          )}

          {currentTab === 'size' && (
            <>
              <div className="section-label">Resize</div>

              <div className="setting-row">
                <span className="setting-label">Mode</span>
                <div className="setting-control">
                  <SettingSelect
                    ariaLabel="Resize mode"
                    disabled={!canEditTab}
                    value={r.mode}
                    options={RESIZE_MODE_OPTIONS}
                    onChange={(mode) => updateResize((rs) => ({ ...rs, mode }))}
                  />
                </div>
              </div>
              {r.mode === 'exact' && (
                <div className="control-warning">Stretch ignores aspect ratio and can distort the image.</div>
              )}

              {(r.mode === 'width' || r.mode === 'height' || r.mode === 'fit-box' || r.mode === 'exact') && (
                <div className="setting-row setting-row-unlabeled">
                  <div className="setting-control compact-field-row compact-field-row-inline">
                    {(r.mode === 'width' || r.mode === 'fit-box' || r.mode === 'exact') && (
                      <label className="compact-field">
                        <span className="compact-field-label">Width</span>
                        <span className="number-unit-field" data-unit="px">
                          <input
                            disabled={!canEditTab}
                            type="number"
                            min={1}
                            value={r.width || ''}
                            onChange={(e) => updateResizeDimension('width', Number(e.target.value) || undefined)}
                          />
                        </span>
                      </label>
                    )}
                    {(r.mode === 'height' || r.mode === 'fit-box' || r.mode === 'exact') && (
                      <label className="compact-field">
                        <span className="compact-field-label">Height</span>
                        <span className="number-unit-field" data-unit="px">
                          <input
                            disabled={!canEditTab}
                            type="number"
                            min={1}
                            value={r.height || ''}
                            onChange={(e) => updateResizeDimension('height', Number(e.target.value) || undefined)}
                          />
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              )}

              {r.mode === 'percent' && (
                <div className="setting-row">
                  <span className="setting-label">Percent</span>
                  <div className="setting-control">
                    <input disabled={!canEditTab} type="number" min={1} max={400} value={r.percent || ''}
                      onChange={(e) => updateResize((rs) => ({ ...rs, percent: Number(e.target.value) || undefined }))}
                    />
                    <span className="text-sm text-tertiary">%</span>
                  </div>
                </div>
              )}

              {r.mode !== 'none' && (
                <div
                  className="setting-row"
                  data-tooltip="Keeps smaller source images from being enlarged to the target size."
                  data-tooltip-placement="left"
                >
                  <span className="setting-label">No Upscale</span>
                  <div className="setting-control">
                    <button
                      type="button"
                      aria-label="Toggle no upscale. Prevents enlarging images beyond their original pixel dimensions."
                      aria-pressed={r.noUpscale}
                      disabled={!canEditTab}
                      className={`toggle ${r.noUpscale ? 'on' : ''}`}
                      onClick={() => canEditTab && updateResize((rs) => ({ ...rs, noUpscale: !rs.noUpscale }))}
                    />
                  </div>
                </div>
              )}

              {r.mode === 'width' && (
                <div className="setting-subsection responsive-variants-section">
                  <div className="setting-subsection-header">
                    <span className="setting-subsection-title">Responsive variants</span>
                  </div>
                  <div className="responsive-variant-controls">
                    <div className="responsive-chip-list">
                      {responsiveWidths.length === 0 && (
                        <span className="responsive-empty-state">No variants added.</span>
                      )}
                      {responsiveWidths.map((width) => (
                        <button
                          key={width}
                          type="button"
                          className="responsive-chip"
                          disabled={!canEditTab}
                          onClick={() => removeResponsiveWidth(width)}
                          aria-label={`Remove ${width} pixel variant`}
                          data-tooltip={`Click to remove ${width}px variant`}
                        >
                          <span className="responsive-chip-width">{width}</span>
                          <span className="responsive-chip-unit">px</span>
                          <span className="responsive-chip-remove">
                            <TrashIcon />
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="responsive-add-row">
                      <input
                        disabled={!canEditTab}
                        type="text"
                        value={responsiveWidthDraft}
                        onChange={(e) => {
                          setResponsiveWidthDraft(e.target.value);
                          setResponsiveWidthError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addResponsiveWidthDraft();
                          }
                        }}
                        placeholder="320, 640, 1200"
                      />
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!canEditTab} onClick={addResponsiveWidthDraft}>
                        Add
                      </button>
                    </div>
                    {responsiveWidthError && (
                      <div className="field-error">{responsiveWidthError}</div>
                    )}
                    <div className="control-help">Each width creates another output. Naming can use {'{width}'} and {'{height}'} tokens.</div>
                  </div>
                </div>
              )}
            </>
          )}

          {currentTab === 'size' && (
            <>
              <div className="section-label">Crop</div>

              <div
                className="setting-row"
                data-tooltip="Enables crop settings and applies them to exported files."
                data-tooltip-placement="left"
              >
                <span className="setting-label">Enable Crop</span>
                <div className="setting-control">
                  <button
                    type="button"
                    aria-label="Toggle crop"
                    aria-pressed={c.enabled}
                    disabled={!canEditTab}
                    className={`toggle ${c.enabled ? 'on' : ''}`}
                    onClick={() => canEditTab && updateCrop((crop) => ({ ...crop, enabled: !crop.enabled }))}
                  />
                </div>
              </div>

              {c.enabled && (
                <>
                  <div className="setting-row">
                    <span className="setting-label">Position</span>
                    <div className="setting-control">
                      <button
                        type="button"
                        className={`ratio-chip ${c.positionMode === 'xy' ? 'active' : ''}`}
                        disabled={!canEditTab}
                        onClick={() => updateCrop((crop) => ({ ...crop, positionMode: 'xy' as CropPositionMode }))}
                      >
                        XY
                      </button>
                      <button
                        type="button"
                        className={`ratio-chip ${c.positionMode === 'anchor' ? 'active' : ''}`}
                        disabled={!canEditTab}
                        onClick={() => updateCrop((crop) => applyAnchorPosition({
                          ...crop,
                          positionMode: 'anchor' as CropPositionMode,
                        }))}
                      >
                        Anchor
                      </button>
                    </div>
                  </div>

                  {c.positionMode === 'anchor' && (
                    <>
                      <div className="setting-row">
                        <span className="setting-label">Anchor</span>
                        <div className="setting-control">
                          <SettingSelect
                            ariaLabel="Crop anchor"
                            disabled={!canEditTab}
                            value={c.aspectAnchor}
                            options={CROP_ANCHOR_OPTIONS}
                            onChange={(anchor) => {
                              updateCrop((crop) => {
                                const next = { ...crop, aspectAnchor: anchor, positionMode: 'anchor' as CropPositionMode };
                                return applyAnchorPosition(next);
                              });
                            }}
                          />
                        </div>
                      </div>
                      <div
                        className="setting-row"
                        data-tooltip="Keeps anchored crops inside visible image bounds when rotation creates transparent edges."
                        data-tooltip-placement="left"
                      >
                        <span className="setting-label">Inside Image</span>
                        <div className="setting-control">
                          <button
                            type="button"
                            aria-label="Keep anchored crop fully inside the image"
                            aria-pressed={Boolean(c.anchorInsideImage)}
                            disabled={!canEditTab}
                            className={`toggle ${c.anchorInsideImage ? 'on' : ''}`}
                            onClick={() => canEditTab && updateCrop((crop) => ({
                              ...crop,
                              positionMode: 'anchor' as CropPositionMode,
                              anchorInsideImage: !crop.anchorInsideImage,
                            }))}
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <div className="setting-row" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
                    <span className="setting-label" style={{ width: 'auto' }}>Aspect Ratio</span>
                    <div className="setting-control" style={{ flexWrap: 'wrap' }}>
                      {RATIO_PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset.label}
                          className={`ratio-chip ${c.aspectRatio === preset.value || (!c.aspectRatio && !preset.value) ? 'active' : ''}`}
                          disabled={!canEditTab}
                          onClick={() => applyRatio(preset.value)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {c.positionMode === 'xy' && (
                    <div className="setting-row setting-row-unlabeled">
                      <div className="setting-control compact-field-row compact-field-row-inline">
                        <label className="compact-field">
                          <span className="compact-field-label">X</span>
                          <input disabled={!canEditTab} type="number" step="0.1" min={0} max={100} value={Number(c.x.toFixed(2))}
                            onChange={(e) => updateCrop(() => normalizeCrop({ ...c, x: Number(e.target.value) || 0 }))}
                          />
                        </label>
                        <label className="compact-field">
                          <span className="compact-field-label">Y</span>
                          <input disabled={!canEditTab} type="number" step="0.1" min={0} max={100} value={Number(c.y.toFixed(2))}
                            onChange={(e) => updateCrop(() => normalizeCrop({ ...c, y: Number(e.target.value) || 0 }))}
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  <div className="setting-row setting-row-unlabeled">
                    <div className="setting-control compact-field-row compact-field-row-inline">
                      <label className="compact-field">
                        <span className="compact-field-label">Width</span>
                        <input disabled={!canEditTab} type="number" step="0.1" min={1} max={100} value={Number(c.width.toFixed(2))}
                          onChange={(e) => updateCrop(() => {
                            const next = normalizeCrop({ ...c, width: Number(e.target.value) || 1 });
                            return next.positionMode === 'anchor' ? applyAnchorPosition(next) : next;
                          })}
                        />
                      </label>
                      <label className="compact-field">
                        <span className="compact-field-label">Height</span>
                        <input disabled={!canEditTab} type="number" step="0.1" min={1} max={100} value={Number(c.height.toFixed(2))}
                          onChange={(e) => updateCrop(() => {
                            const next = normalizeCrop({ ...c, height: Number(e.target.value) || 1 });
                            return next.positionMode === 'anchor' ? applyAnchorPosition(next) : next;
                          })}
                        />
                      </label>
                    </div>
                  </div>
                </>
              )}

            </>
          )}

          {currentTab === 'transform' && (
            <>
              <div className="section-label">Transform</div>
              <div className="control-help">
                Rotate and flip are applied to the visible image before crop and resize.
              </div>

              <div className="setting-row">
                <span className="setting-label">Rotation</span>
                <div className="setting-control">
                  <SliderNumberInput
                    ariaLabel="Rotation"
                    disabled={!canEditTab}
                    min={-180}
                    max={180}
                    step={0.1}
                    decimals={1}
                    unit="deg"
                    value={t.rotation}
                    onChange={(rotation) => updateTransform((tr) => ({ ...tr, rotation }), 'transform.rotation')}
                    onCommit={endRecipeHistoryCoalesce}
                  />
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Quick rotate</span>
                <div className="setting-control">
                  <button className="btn btn-ghost btn-sm" disabled={!canEditTab} onClick={() => rotateBy(-90)}>Left 90</button>
                  <button className="btn btn-ghost btn-sm" disabled={!canEditTab} onClick={() => rotateBy(90)}>Right 90</button>
                  <button className="btn btn-ghost btn-sm" disabled={!canEditTab} onClick={() => updateTransform((tr) => ({ ...tr, rotation: 0 }))}>Reset</button>
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Flip</span>
                <div className="setting-control">
                  <button
                    type="button"
                    aria-label="Apply horizontal flip"
                    aria-pressed={t.flipH}
                    disabled={!canEditTab}
                    className={`btn btn-ghost btn-sm ${t.flipH ? 'active' : ''}`}
                    onClick={applyHorizontalFlip}
                  >
                    Horizontal
                  </button>
                  <button
                    type="button"
                    aria-label="Apply vertical flip"
                    aria-pressed={t.flipV}
                    disabled={!canEditTab}
                    className={`btn btn-ghost btn-sm ${t.flipV ? 'active' : ''}`}
                    onClick={applyVerticalFlip}
                  >
                    Vertical
                  </button>
                </div>
              </div>
            </>
          )}

          {currentTab === 'metadata' && (
            <>
              <div className="section-label">Metadata & Privacy</div>
              <div className="control-help metadata-mode-help">{getMetadataModeCopy(editingPreset.metadata.mode)}</div>

              <div className="setting-row metadata-control-block">
                <span className="setting-label">Privacy mode</span>
                <div className="setting-control">
                  <SettingSelect
                    ariaLabel="Privacy mode"
                    disabled={!canEditTab}
                    value={editingPreset.metadata.mode}
                    options={METADATA_MODE_OPTIONS}
                    onChange={(mode) => updateMetadata((meta) => ({ ...meta, mode }))}
                  />
                </div>
              </div>

              <div className="setting-row metadata-control-block">
                <span className="setting-label">AI cleanup</span>
                <div className="setting-control">
                  <SettingSelect
                    ariaLabel="Synthetic image cleanup"
                    disabled={!canEditTab}
                    value={syntheticImageMode}
                    options={SYNTHETIC_IMAGE_MODE_OPTIONS}
                    onChange={(syntheticMode) => updateMetadata((meta) => ({ ...meta, syntheticMode }))}
                  />
                </div>
              </div>
              {syntheticImageProcessingEnabled && (
                <div className="control-help setting-help metadata-setting-help">
                  Re-encodes PNG/JPEG, removes alpha, and crops known AI padding or detected Gemini watermarks.
                </div>
              )}

              <div className="setting-row metadata-control-block">
                <span className="setting-label">Add metadata</span>
                <div className="setting-control">
                  <SettingSelect
                    ariaLabel="Rewrite metadata"
                    disabled={!canEditTab}
                    value={metadataRewriteMode}
                    options={METADATA_REWRITE_MODE_OPTIONS}
                    onChange={(rewriteMode) => updateMetadata((meta) => ({ ...meta, rewriteMode }))}
                  />
                </div>
              </div>
              {creatorRewriteEnabled && (
                <div className="setting-row metadata-control-block">
                  <span className="setting-label">Creator</span>
                  <div className="setting-control">
                    <input
                      disabled={!canEditTab}
                      type="text"
                      className={creatorNameMissing ? 'input-invalid' : undefined}
                      aria-invalid={creatorNameMissing || undefined}
                      data-tooltip={creatorNameMissing ? 'Creator name is required before processing.' : undefined}
                      data-tooltip-placement={creatorNameMissing ? 'left' : undefined}
                      value={metadataSettings.creatorName || ''}
                      placeholder="Creator name"
                      onChange={(event) => updateMetadata((meta) => ({ ...meta, creatorName: event.target.value }), 'metadata.creatorName')}
                    />
                  </div>
                </div>
              )}
              {metadataRewriteEnabled && (
                <div className="control-help setting-help metadata-setting-help">
                  {metadataRewriteHelpCopy}
                  {metadataRewritePrivacyNote}
                </div>
              )}

              <div
                className="setting-row"
                data-tooltip="Converts outputs to sRGB for consistent color in browsers and other apps."
                data-tooltip-placement="left"
              >
                <span className="setting-label">Convert to sRGB</span>
                <div className="setting-control">
                  <button
                    type="button"
                    aria-label="Toggle convert to sRGB"
                    aria-pressed={editingPreset.metadata.convertToSrgb}
                    disabled={!canEditTab}
                    className={`toggle ${editingPreset.metadata.convertToSrgb ? 'on' : ''}`}
                    onClick={() => canEditTab && updateMetadata((meta) => ({ ...meta, convertToSrgb: !meta.convertToSrgb }))}
                  />
                </div>
              </div>
            </>
          )}

          {currentTab === 'naming' && (
            <>
              <div className="section-label">File Naming</div>
              <div className="naming-preview">
                <span>Selected output name</span>
                <strong>{namingExample}</strong>
              </div>
              <div
                className="setting-row"
                data-tooltip={strictPrivacyForcesAiTermStripping
                  ? [
                    'Required by Strict Privacy.',
                    'Example filename:',
                    'ChatGPT Image Jul 6 2026.png -> Image Jul 6 2026.png',
                    'midjourney-product-ai.png -> product.png',
                  ].join('\n')
                  : [
                    'Example filename:',
                    'ChatGPT Image Jul 6 2026.png -> Image Jul 6 2026.png',
                    'midjourney-product-ai.png -> product.png',
                    'Removes source terms like chatgpt, ai, generated, midjourney, dall-e.',
                  ].join('\n')}
                data-tooltip-placement="left"
                data-tooltip-width="360"
              >
                <span className="setting-label">Strip AI terms</span>
                <div className="setting-control">
                  <button
                    type="button"
                    aria-label="Toggle strip AI source terms"
                    aria-pressed={aiTermStrippingEnabled}
                    disabled={!canEditTab || strictPrivacyForcesAiTermStripping}
                    className={`toggle ${aiTermStrippingEnabled ? 'on' : ''}`}
                    onClick={() => canEditTab && !strictPrivacyForcesAiTermStripping && updateNaming((n) => ({
                      ...n,
                      sanitizeAiTerms: n.sanitizeAiTerms === false,
                    }))}
                  />
                </div>
              </div>
              <div
                className="setting-row"
                data-tooltip={[
                  'Example source: ChatGPT Product Hero.jpg',
                  'Keep source name on + Strip AI on -> Product Hero.webp',
                  'Keep source name on + Strip AI off -> ChatGPT Product Hero.webp',
                  'Keep source name off -> use find, template, or sequential numbering',
                ].join('\n')}
                data-tooltip-placement="left"
                data-tooltip-width="360"
              >
                <span className="setting-label">Keep source name</span>
                <div className="setting-control">
                  <button
                    type="button"
                    aria-label="Toggle keep original name"
                    aria-pressed={editingPreset.naming.keepOriginal}
                    disabled={!canEditTab}
                    className={`toggle ${editingPreset.naming.keepOriginal ? 'on' : ''}`}
                    onClick={() => canEditTab && updateNaming((n) => ({ ...n, keepOriginal: !n.keepOriginal }))}
                  />
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Affix</span>
                <div className="setting-control">
                  <input
                    disabled={!canEditTab}
                    type="text"
                    value={editingPreset.naming.prefix}
                    onChange={(e) => updateNaming((n) => ({ ...n, prefix: e.target.value }), 'naming.prefix')}
                    placeholder="optional"
                  />
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Suffix</span>
                <div className="setting-control">
                  <input
                    disabled={!canEditTab}
                    type="text"
                    value={editingPreset.naming.suffix}
                    onChange={(e) => updateNaming((n) => ({ ...n, suffix: e.target.value }), 'naming.suffix')}
                    placeholder="optional"
                  />
                </div>
              </div>

              {!editingPreset.naming.keepOriginal && (
                <>
                  <div className="setting-row">
                    <span className="setting-label">Find</span>
                    <div className="setting-control">
                      <input
                        disabled={!canEditTab}
                        type="text"
                        value={editingPreset.naming.findText}
                        onChange={(e) => updateNaming((n) => ({ ...n, findText: e.target.value }), 'naming.findText')}
                        placeholder="text to find"
                        style={{ width: 120 }}
                      />
                      <span className="text-sm text-tertiary">→</span>
                      <input
                        disabled={!canEditTab}
                        type="text"
                        value={editingPreset.naming.replaceText}
                        onChange={(e) => updateNaming((n) => ({ ...n, replaceText: e.target.value }), 'naming.replaceText')}
                        placeholder="replace with"
                        style={{ width: 120 }}
                      />
                    </div>
                  </div>

                  <div className="setting-row">
                    <span className="setting-label">Template</span>
                    <div className="setting-control">
                      <input
                        disabled={!canEditTab}
                        type="text"
                        value={editingPreset.naming.template}
                        onChange={(e) => updateNaming((n) => ({ ...n, template: e.target.value }), 'naming.template')}
                        placeholder="{name}-{seq}-{format}"
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-tertiary" style={{ marginTop: -6, marginBottom: 8 }}>
                    Tokens: {'{name}'}, {'{seq}'}, {'{index}'}, {'{format}'}, {'{ext}'}, {'{width}'}, {'{height}'}
                  </div>

                  <div
                    className="setting-row"
                    data-tooltip="Adds incrementing numbers to output filenames, starting from the value you set."
                    data-tooltip-placement="left"
                    data-tooltip-width="300"
                  >
                    <span className="setting-label">Sequential</span>
                    <div className="setting-control">
                      <button
                        type="button"
                        aria-label="Toggle sequential naming"
                        aria-pressed={editingPreset.naming.sequential}
                        disabled={!canEditTab}
                        className={`toggle ${editingPreset.naming.sequential ? 'on' : ''}`}
                        onClick={() => canEditTab && updateNaming((n) => ({ ...n, sequential: !n.sequential }))}
                      />
                      {editingPreset.naming.sequential && (
                        <>
                          <span className="text-sm text-tertiary">Start at</span>
                          <input
                            disabled={!canEditTab}
                            type="number"
                            min={0}
                            value={editingPreset.naming.sequentialStart}
                            onChange={(e) => updateNaming((n) => ({ ...n, sequentialStart: Number(e.target.value) || 0 }))}
                          />
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {currentTab === 'backgroundRemoval' && (
            <>
              <div className="section-label">Remove Background</div>

              <div
                className="setting-row"
                data-tooltip="Runs background removal during export after the other recipe edits. It is not shown in live preview; use PNG or WebP to keep transparency."
                data-tooltip-placement="left"
                data-tooltip-width="340"
              >
                <div className="setting-label background-model-setting-label">
                  <span>Remove background</span>
                  <BackgroundRemovalModelInfoButton />
                </div>
                <div className="setting-control">
                  <button
                    type="button"
                    aria-label="Toggle background removal on export"
                    aria-pressed={backgroundRemovalSettings.enabled}
                    disabled={!canEditTab}
                    className={`toggle ${backgroundRemovalSettings.enabled ? 'on' : ''}`}
                    onClick={() => canEditTab && updateBackgroundRemoval((settings) => ({
                      ...settings,
                      enabled: !settings.enabled,
                    }))}
                  />
                </div>
              </div>
            </>
          )}

          {currentTab === 'export' && (
            <>
              <div className="section-label">Filename</div>
              <div className="export-filename-builder">
                <div className="export-filename-row export-filename-edits-row">
                  <label className="export-filename-field">
                    <span className="export-filename-label-row">
                      <span className="filename-placement-badge">A</span>
                      <span>Affix</span>
                    </span>
                    <input
                      disabled={!canEditTab}
                      type="text"
                      value={editingPreset.naming.prefix}
                      onChange={(e) => updateNaming((n) => ({ ...n, prefix: e.target.value }), 'naming.prefix')}
                      placeholder="optional"
                    />
                  </label>
                  <label className="export-filename-field">
                    <span className="export-filename-label-row">
                      <span className="filename-placement-badge">S</span>
                      <span>Suffix</span>
                    </span>
                    <input
                      disabled={!canEditTab}
                      type="text"
                      value={editingPreset.naming.suffix}
                      onChange={(e) => updateNaming((n) => ({ ...n, suffix: e.target.value }), 'naming.suffix')}
                      placeholder="optional"
                    />
                  </label>
                </div>
                <div className="export-filename-row export-filename-output-row">
                  <span className="filename-placement-badge" aria-label="Affix appears before filename">A</span>
                  <label className="export-filename-field export-filename-stem">
                    <span>Filename</span>
                    <input
                      readOnly
                      type="text"
                      value={exportFilenameStem}
                      aria-label="Fixed filename"
                    />
                  </label>
                  <span className="filename-placement-badge" aria-label="Suffix appears before file ending">S</span>
                  <label className="export-filename-field export-filename-ending">
                    <span>File ending</span>
                    <input
                      readOnly
                      type="text"
                      value={exportFileEnding}
                      aria-label="Fixed file ending"
                    />
                  </label>
                </div>
              </div>

              <div className="section-label">Export Destination</div>

              <div className="setting-row">
                <span className="setting-label">Destination</span>
                <div className="setting-control">
                  <SettingSelect
                    ariaLabel="Export destination"
                    disabled={!canEditTab}
                    value={editingPreset.export.destination}
                    options={EXPORT_DESTINATION_OPTIONS}
                    onChange={(destination) => updateExport((ex) => ({ ...ex, destination }))}
                  />
                </div>
              </div>

              {editingPreset.export.destination === 'sibling' && (
                <div className="setting-row">
                  <span className="setting-label">Folder Name</span>
                  <div className="setting-control">
                    <input
                      disabled={!canEditTab}
                      type="text"
                      value={editingPreset.export.siblingFolderName}
                      onChange={(e) => updateExport((ex) => ({ ...ex, siblingFolderName: e.target.value }), 'export.siblingFolderName')}
                    />
                  </div>
                </div>
              )}

              {editingPreset.export.destination === 'custom' && (
                <div className="setting-row">
                  <span className="setting-label">Folder</span>
                  <div className="setting-control">
                    <span className="text-sm text-secondary" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {editingPreset.export.customPath || 'Not selected'}
                    </span>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={!canEditTab}
                      onClick={async () => {
                        try {
                          const folder = await api.chooseFolder();
                          if (folder) {
                            updateExport((ex) => ({ ...ex, destination: 'custom', customPath: folder }));
                          }
                        } catch (err) {
                          const message = err instanceof Error ? err.message : String(err);
                          onError(`Could not choose export folder: ${message}`);
                        }
                      }}
                    >
                      Browse
                    </button>
                  </div>
                </div>
              )}

              <div
                className="setting-row"
                data-tooltip="Replaces files with matching output paths instead of creating numbered copies."
                data-tooltip-placement="left"
                data-tooltip-width="300"
              >
                <span className="setting-label">Overwrite</span>
                <div className="setting-control">
                  <button
                    type="button"
                    aria-label="Toggle overwrite outputs"
                    aria-pressed={editingPreset.export.overwrite}
                    disabled={!canEditTab}
                    className={`toggle ${editingPreset.export.overwrite ? 'on' : ''}`}
                    onClick={() => canEditTab && updateExport((ex) => ({ ...ex, overwrite: !ex.overwrite }))}
                  />
                </div>
              </div>

              <div
                className="setting-row"
                data-tooltip="Opens the export folder in Finder after the batch finishes."
                data-tooltip-placement="left"
              >
                <span className="setting-label">Open when done</span>
                <div className="setting-control">
                  <button
                    type="button"
                    aria-label="Toggle open folder when done"
                    aria-pressed={editingPreset.export.openFolderWhenDone}
                    disabled={!canEditTab}
                    className={`toggle ${editingPreset.export.openFolderWhenDone ? 'on' : ''}`}
                    onClick={() => canEditTab && updateExport((ex) => ({ ...ex, openFolderWhenDone: !ex.openFolderWhenDone }))}
                  />
                </div>
              </div>
            </>
          )}
              </div>
            </div>
            <div className="preview-adjust-footer">
              {inspectorBatchJob}
            </div>
          </div>
        )}
      </div>

      <ModalDialog
        open={clearConfirmOpen}
        title="Start New Batch?"
        description="This clears the source list, current results, and unsaved recipe context from the workspace."
        confirmLabel="Start New Batch"
        confirmVariant="danger"
        onConfirm={confirmClearFiles}
        onCancel={() => setClearConfirmOpen(false)}
      />

      <ModalDialog
        open={Boolean(presetDeleteTarget)}
        title="Delete preset?"
        description={presetDeleteTarget
          ? `Delete "${presetDeleteTarget.name}"? This cannot be undone.`
          : undefined}
        error={presetDeleteError}
        confirmLabel="Delete Preset"
        confirmVariant="danger"
        autoFocusConfirm
        onConfirm={confirmPresetDelete}
        onCancel={() => {
          setPresetDeleteTarget(null);
          setPresetDeleteError(null);
        }}
      />

      <ModalDialog
        open={summaryGuardOpen}
        title="Save preset changes?"
        description="You are editing a preset. Save your changes before viewing the file summary, discard the edits, or cancel and keep editing."
        confirmLabel="Save Changes"
        secondaryLabel="Discard Changes"
        secondaryVariant="danger"
        onConfirm={() => confirmSaveAndShowSummary()}
        onSecondary={discardEditsAndShowSummary}
        onCancel={() => setSummaryGuardOpen(false)}
      />
    </div>
    {presetSaveNudgeVisible && presetSaveNudgePosition && createPortal(
      <div
        ref={presetSaveNudgeRef}
        id="preset-save-nudge"
        className="preset-save-nudge-popup"
        role="alert"
        style={{
          left: presetSaveNudgePosition.left,
          top: presetSaveNudgePosition.top,
          '--preset-save-nudge-width': `${PRESET_SAVE_NUDGE_WIDTH}px`,
        } as React.CSSProperties}
      >
        Are you sure you're done with your edits? You can always come back and make more edits later.
        Click Save again to create it as-is.
      </div>,
      document.body,
    )}
    </>
  );
}
