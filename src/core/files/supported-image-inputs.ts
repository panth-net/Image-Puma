import sharp from 'sharp';

const EXTRA_ATTEMPTED_INPUT_EXTENSIONS = [
  '.heic',
  '.heif',
  '.heics',
  '.heifs',
  '.hif',
];

export const NATIVE_MACOS_FALLBACK_INPUT_EXTENSIONS = new Set([
  '.bmp',
  '.dib',
  '.heic',
  '.heif',
  '.heics',
  '.heifs',
  '.hif',
  '.icns',
  '.ico',
  '.jp2',
  '.j2k',
  '.jpf',
  '.jpm',
  '.jpx',
  '.jxl',
  '.psd',
  '.sgi',
  '.tga',
]);

const INTERNAL_SHARP_INPUT_EXTENSIONS = new Set([
  '.v',
  '.vips',
]);

function getSharpInputExtensions(): string[] {
  const extensions = new Set<string>();

  for (const format of Object.values(sharp.format)) {
    if (!format.input.file) continue;
    for (const suffix of format.input.fileSuffix || []) {
      if (!suffix.includes('.')) continue;
      extensions.add(suffix.toLowerCase());
    }
  }

  return Array.from(extensions);
}

export const SUPPORTED_IMAGE_INPUT_EXTENSIONS = new Set([
  ...getSharpInputExtensions(),
  ...EXTRA_ATTEMPTED_INPUT_EXTENSIONS,
  ...(process.platform === 'darwin' ? Array.from(NATIVE_MACOS_FALLBACK_INPUT_EXTENSIONS) : []),
].filter((extension) => !INTERNAL_SHARP_INPUT_EXTENSIONS.has(extension)));

export const IMAGE_DIALOG_EXTENSIONS = Array.from(SUPPORTED_IMAGE_INPUT_EXTENSIONS)
  .filter((extension) => !extension.includes('.gz'))
  .map((extension) => extension.replace(/^\./, ''))
  .sort();
