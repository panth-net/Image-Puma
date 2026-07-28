import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import type {
  FaviconBundleFile,
  FaviconBundleRequest,
  FaviconBundleResult,
} from '../shared/types';
import {
  APP_ICO_SIZES,
  createIcns,
  createIco,
  ICNS_PNG_SIZES,
  WEB_ICO_SIZES,
} from './icon-containers';

const PNG_SIZES = Array.from(new Set([
  ...APP_ICO_SIZES,
  ...ICNS_PNG_SIZES,
  180,
]));

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
}

function cleanFolderName(value: string | undefined): string {
  const cleaned = stripControlCharacters(value || 'favicon-package')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  return cleaned || 'favicon-package';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveCrop(
  width: number,
  height: number,
  crop: FaviconBundleRequest['crop'],
): { left: number; top: number; width: number; height: number } | null {
  if (!crop) return null;

  const requestedWidth = clamp(Number(crop.width) || 100, 1, 100);
  const requestedHeight = clamp(Number(crop.height) || 100, 1, 100);
  const sourceAspectRatio = width / height;
  const cropHeight = Math.min(requestedHeight, requestedWidth * sourceAspectRatio);
  const cropWidth = cropHeight / sourceAspectRatio;
  const x = clamp(Number(crop.x) || 0, 0, 100 - cropWidth);
  const y = clamp(Number(crop.y) || 0, 0, 100 - cropHeight);
  if (x === 0 && y === 0 && cropWidth === 100 && cropHeight === 100) return null;

  const left = clamp(Math.round((width * x) / 100), 0, width - 1);
  const top = clamp(Math.round((height * y) / 100), 0, height - 1);
  const right = clamp(Math.round((width * (x + cropWidth)) / 100), left + 1, width);
  const bottom = clamp(Math.round((height * (y + cropHeight)) / 100), top + 1, height);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

async function nextAvailableDirectory(parentDirectory: string, requestedName: string): Promise<string> {
  for (let index = 1; index < 10_000; index++) {
    const suffix = index === 1 ? '' : `-${index}`;
    const candidate = path.join(parentDirectory, `${requestedName}${suffix}`);
    try {
      await fs.mkdir(candidate);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not create an available output folder for ${requestedName}.`);
}

function outputFile(
  outputDirectory: string,
  fileName: string,
  purpose: string,
  size?: string,
): FaviconBundleFile {
  return { fileName, outputPath: path.join(outputDirectory, fileName), purpose, size };
}

export async function generateFaviconBundle(request: FaviconBundleRequest): Promise<FaviconBundleResult> {
  const sourcePath = path.resolve(request.sourcePath);
  const parentDirectory = path.resolve(request.outputDirectory);
  const parentStat = await fs.stat(parentDirectory);
  if (!parentStat.isDirectory()) throw new Error(`Output location is not a folder: ${parentDirectory}`);

  const metadata = await sharp(sourcePath, { failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('The selected source does not have readable image dimensions.');
  }

  const crop = resolveCrop(metadata.width, metadata.height, request.crop);
  const outputDirectory = await nextAvailableDirectory(parentDirectory, cleanFolderName(request.folderName));

  try {
    const rendered = await Promise.all(PNG_SIZES.map(async (size) => {
      let icon = sharp(sourcePath, { failOn: 'error' });
      if (crop) icon = icon.extract(crop);
      icon = icon
        .rotate()
        .resize(size, size, { fit: 'cover', position: 'centre' });
      icon = metadata.hasAlpha ? icon.ensureAlpha() : icon.removeAlpha();
      const png = await icon.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      return { size, png };
    }));
    const pngBySize = new Map<number, Buffer>(rendered.map(({ size, png }) => [size, png]));
    const at = (size: number): Buffer => {
      const png = pngBySize.get(size);
      if (!png) throw new Error(`Missing rendered ${size}x${size} icon.`);
      return png;
    };

    const files = [
      outputFile(outputDirectory, 'favicon.ico', 'Multi-size browser favicon', '16, 32, 48'),
      outputFile(outputDirectory, 'favicon-16x16.png', 'Browser tab PNG fallback', '16x16'),
      outputFile(outputDirectory, 'favicon-32x32.png', 'Browser tab and bookmark PNG', '32x32'),
      outputFile(outputDirectory, 'apple-touch-icon.png', 'Apple home screen icon', '180x180'),
      outputFile(outputDirectory, 'app-icon.ico', 'Windows and Electron app icon', '16–256'),
      outputFile(outputDirectory, 'app-icon.icns', 'macOS app icon', '16–1024'),
      outputFile(outputDirectory, 'app-icon.png', 'Linux and general app icon', '1024x1024'),
    ];

    await Promise.all([
      fs.writeFile(files[0].outputPath, createIco(WEB_ICO_SIZES.map((size) => ({ size, png: at(size) })))),
      fs.writeFile(files[1].outputPath, at(16)),
      fs.writeFile(files[2].outputPath, at(32)),
      fs.writeFile(files[3].outputPath, at(180)),
      fs.writeFile(files[4].outputPath, createIco(APP_ICO_SIZES.map((size) => ({ size, png: at(size) })))),
      fs.writeFile(files[5].outputPath, createIcns(pngBySize)),
      fs.writeFile(files[6].outputPath, at(1024)),
    ]);

    return { sourcePath, outputDirectory, files };
  } catch (error) {
    await fs.rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}
