import { AppPreset } from '../shared/types';
import { DEFAULT_BACKGROUND_REMOVAL_SETTINGS } from '../shared/background-removal-settings';

const defaultOutput: AppPreset['output'] = {
  format: 'keep-original',
  jpegQuality: 82,
  pngCompressionLevel: 6,
  webpQuality: 80,
  avifQuality: 65,
  lossless: false,
};

const neutralOutput: AppPreset['output'] = {
  format: 'keep-original',
  jpegQuality: 100,
  pngCompressionLevel: 0,
  webpQuality: 100,
  avifQuality: 100,
  lossless: false,
};

const defaultResize: AppPreset['resize'] = {
  mode: 'none' as const,
  noUpscale: true,
  responsiveWidths: [],
};

const defaultCrop: AppPreset['crop'] = {
  enabled: false,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  aspectRatio: null,
  aspectAnchor: 'top-left' as const,
  positionMode: 'xy' as const,
  anchorInsideImage: false,
};

const defaultTransform: AppPreset['transform'] = {
  rotation: 0,
  flipH: false,
  flipV: false,
};

const defaultMetadata: AppPreset['metadata'] = {
  mode: 'strip-all' as const,
  convertToSrgb: true,
  syntheticMode: 'off',
  rewriteMode: 'off',
  creatorName: '',
};

const neutralMetadata: AppPreset['metadata'] = {
  mode: 'keep-all' as const,
  convertToSrgb: false,
  syntheticMode: 'off',
  rewriteMode: 'off',
  creatorName: '',
};

const defaultNaming: AppPreset['naming'] = {
  keepOriginal: true,
  sanitizeAiTerms: true,
  prefix: '',
  suffix: '',
  findText: '',
  replaceText: '',
  sequential: false,
  sequentialStart: 1,
  template: '',
};

const neutralNaming: AppPreset['naming'] = {
  ...defaultNaming,
  sanitizeAiTerms: false,
};

const defaultExport: AppPreset['export'] = {
  destination: 'sibling' as const,
  customPath: '',
  siblingFolderName: 'optimized',
  overwrite: false,
  openFolderWhenDone: true,
};

const defaultBackgroundRemoval: AppPreset['backgroundRemoval'] = {
  ...DEFAULT_BACKGROUND_REMOVAL_SETTINGS,
};

export const defaultPresets: AppPreset[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'No image edits. Copies sources unless you turn on settings.',
    output: { ...neutralOutput },
    resize: { ...defaultResize },
    crop: { ...defaultCrop },
    transform: { ...defaultTransform },
    metadata: { ...neutralMetadata },
    naming: { ...neutralNaming },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'web-upload',
    name: 'Web Upload',
    description: 'Balanced quality and size for websites',
    output: { ...defaultOutput, format: 'webp', webpQuality: 82 },
    resize: { ...defaultResize, mode: 'fit-box', width: 1920, height: 1920 },
    crop: { ...defaultCrop },
    transform: { ...defaultTransform },
    metadata: { ...defaultMetadata },
    naming: { ...defaultNaming },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'blog-hero',
    name: 'Blog Hero Image',
    description: 'Wide format for blog headers',
    output: { ...defaultOutput, format: 'webp', webpQuality: 85 },
    resize: { ...defaultResize, mode: 'width', width: 1600 },
    crop: { ...defaultCrop },
    transform: { ...defaultTransform },
    metadata: { ...defaultMetadata },
    naming: { ...defaultNaming },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'social-portrait',
    name: 'Social Portrait',
    description: 'Portrait format for Instagram / stories',
    output: { ...defaultOutput, format: 'jpeg', jpegQuality: 85 },
    resize: { ...defaultResize, mode: 'fit-box', width: 1080, height: 1350 },
    crop: { ...defaultCrop, enabled: true, aspectRatio: '4:5' },
    transform: { ...defaultTransform },
    metadata: { ...defaultMetadata },
    naming: { ...defaultNaming },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'twitter-og',
    name: 'X / Twitter OG Card',
    description: 'Large link-preview card at 1200 x 628',
    output: { ...defaultOutput, format: 'jpeg', jpegQuality: 85 },
    resize: { ...defaultResize, mode: 'exact', width: 1200, height: 628 },
    crop: { ...defaultCrop, enabled: true, aspectRatio: '300:157' },
    transform: { ...defaultTransform },
    metadata: { ...defaultMetadata },
    naming: { ...defaultNaming, suffix: '-twitter-card' },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'windows-icon',
    name: 'Windows ICO',
    description: 'Multi-size Windows icon from 16 x 16 through 256 x 256',
    output: { ...defaultOutput, format: 'ico', pngCompressionLevel: 9, lossless: true },
    resize: { ...defaultResize },
    crop: { ...defaultCrop },
    transform: { ...defaultTransform },
    metadata: { ...defaultMetadata },
    naming: { ...defaultNaming, suffix: '-icon' },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'transparent-asset',
    name: 'Transparent Asset',
    description: 'Preserve transparency for logos and icons',
    output: { ...defaultOutput, format: 'png', pngCompressionLevel: 9 },
    resize: { ...defaultResize },
    crop: { ...defaultCrop },
    transform: { ...defaultTransform },
    metadata: { mode: 'keep-icc', convertToSrgb: true },
    naming: { ...defaultNaming },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'high-quality-archive',
    name: 'High-Quality Archive',
    description: 'Maximum quality, minimal compression',
    output: { ...defaultOutput, format: 'png', pngCompressionLevel: 3, lossless: true },
    resize: { ...defaultResize },
    crop: { ...defaultCrop },
    transform: { ...defaultTransform },
    metadata: { mode: 'keep-all', convertToSrgb: false },
    naming: { ...defaultNaming },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'thumbnail',
    name: 'Thumbnail Generation',
    description: 'Small square thumbnails',
    output: { ...defaultOutput, format: 'jpeg', jpegQuality: 78 },
    resize: { ...defaultResize, mode: 'fit-box', width: 300, height: 300 },
    crop: { ...defaultCrop, enabled: true, aspectRatio: '1:1' },
    transform: { ...defaultTransform },
    metadata: { ...defaultMetadata },
    naming: { ...defaultNaming, suffix: '-thumb' },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'tinypng-like',
    name: 'TinyPNG-like',
    description: 'Aggressive PNG optimization',
    output: { ...defaultOutput, format: 'png', pngCompressionLevel: 9 },
    resize: { ...defaultResize },
    crop: { ...defaultCrop },
    transform: { ...defaultTransform },
    metadata: { ...defaultMetadata },
    naming: { ...defaultNaming },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
  {
    id: 'squoosh-aggressive',
    name: 'Squoosh-like Aggressive',
    description: 'Smallest file size possible',
    output: { ...defaultOutput, format: 'avif', avifQuality: 40 },
    resize: { ...defaultResize, mode: 'fit-box', width: 1920, height: 1920 },
    crop: { ...defaultCrop },
    transform: { ...defaultTransform },
    metadata: { ...defaultMetadata },
    naming: { ...defaultNaming },
    export: { ...defaultExport },
    backgroundRemoval: { ...defaultBackgroundRemoval },
  },
];
