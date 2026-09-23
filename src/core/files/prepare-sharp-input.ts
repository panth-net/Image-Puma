import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import sharp from 'sharp';
import { NATIVE_MACOS_FALLBACK_INPUT_EXTENSIONS } from './supported-image-inputs';
import type { ImageProcessingLimits } from '../processing/processing-limits';
import { applySharpTimeout, normalizeImageProcessingLimits } from '../processing/processing-limits';

const execFileAsync = promisify(execFile);

export interface PreparedSharpInput {
  path: string;
  metadata: sharp.Metadata;
  usedNativeFallback: boolean;
  dispose: () => Promise<void>;
}

interface DecodedHeifImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

type HeifDecoder = (options: { buffer: Buffer }) => Promise<DecodedHeifImage>;

export function nativeDecodeRunWarning(): string {
  return process.platform === 'darwin'
    ? 'Decoded with macOS ImageIO before compression.'
    : 'Decoded HEIC with the bundled HEIF decoder before compression.';
}

export function nativeDecodePlanWarning(): string {
  return process.platform === 'darwin'
    ? 'This source will be decoded with macOS ImageIO before compression.'
    : 'This source will be decoded with the bundled HEIF decoder before compression.';
}

function isNativeMacosFallbackCandidate(filePath: string): boolean {
  return process.platform === 'darwin'
    && NATIVE_MACOS_FALLBACK_INPUT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isHeifLikeInput(filePath: string, metadata?: sharp.Metadata): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.heic'
    || ext === '.heif'
    || ext === '.heics'
    || ext === '.heifs'
    || ext === '.hif'
    || metadata?.format === 'heif';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function decodeWithMacosImageIo(
  filePath: string,
  originalError: unknown,
  processingLimits?: ImageProcessingLimits,
): Promise<PreparedSharpInput> {
  if (!isNativeMacosFallbackCandidate(filePath)) {
    throw originalError;
  }
  const limits = normalizeImageProcessingLimits(processingLimits);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-native-image-'));
  const decodedPath = path.join(tempDir, 'source.png');

  try {
    await execFileAsync('/usr/bin/sips', [
      '-s',
      'format',
      'png',
      filePath,
      '--out',
      decodedPath,
    ], {
      maxBuffer: 1024 * 1024 * 4,
      timeout: 120000,
    });

    const metadata = await sharp(decodedPath, { limitInputPixels: limits.limitInputPixels }).metadata();
    return {
      path: decodedPath,
      metadata,
      usedNativeFallback: true,
      dispose: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (fallbackError) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new Error(`Could not decode source image. Sharp reported: ${errorMessage(originalError)}. macOS ImageIO reported: ${errorMessage(fallbackError)}`);
  }
}

async function assertPixelsDecode(
  filePath: string,
  processingLimits?: ImageProcessingLimits,
): Promise<void> {
  const limits = normalizeImageProcessingLimits(processingLimits);
  await applySharpTimeout(
    sharp(filePath, { limitInputPixels: limits.limitInputPixels })
      .rotate()
      .resize({ width: 1, height: 1, fit: 'inside' }),
    limits,
  )
    .toBuffer();
}

export async function prepareSharpInput(
  filePath: string,
  options: { probeDecode?: boolean; processingLimits?: ImageProcessingLimits } = {},
): Promise<PreparedSharpInput> {
  const probeDecode = options.probeDecode !== false;
  const limits = normalizeImageProcessingLimits(options.processingLimits);

  try {
    const metadata = await sharp(filePath, { limitInputPixels: limits.limitInputPixels }).metadata();
    if (probeDecode && isHeifLikeInput(filePath, metadata)) {
      try {
        await assertPixelsDecode(filePath, options.processingLimits);
      } catch (decodeError) {
        return decodeHeifFallback(filePath, decodeError, options.processingLimits);
      }
    }

    return {
      path: filePath,
      metadata,
      usedNativeFallback: false,
      dispose: async () => undefined,
    };
  } catch (metadataError) {
    return decodeHeifFallback(filePath, metadataError, options.processingLimits);
  }
}

function decodeHeifFallback(
  filePath: string,
  originalError: unknown,
  processingLimits?: ImageProcessingLimits,
): Promise<PreparedSharpInput> {
  if (isNativeMacosFallbackCandidate(filePath)) {
    return decodeWithMacosImageIo(filePath, originalError, processingLimits);
  }
  if (isHeifLikeInput(filePath)) {
    return decodeWithBundledHeif(filePath, originalError, processingLimits);
  }
  return Promise.reject(originalError);
}

function findImagePumaPackageJson(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (pkg.name === 'image-puma') return candidate;
      } catch {
        // Keep walking if a nearby package.json is unreadable.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadBundledHeifDecoder(): HeifDecoder {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packagedEntry = resourcesPath
    ? path.join(resourcesPath, 'heif-decoder', 'node_modules', 'heic-decode', 'index.js')
    : '';
  if (packagedEntry && existsSync(packagedEntry)) {
    return createRequire(packagedEntry)('heic-decode') as HeifDecoder;
  }

  const projectPackage = findImagePumaPackageJson(__dirname);
  if (!projectPackage) {
    throw new Error('Could not locate the bundled HEIF decoder.');
  }
  return createRequire(projectPackage)('heic-decode') as HeifDecoder;
}

async function decodeWithBundledHeif(
  filePath: string,
  originalError: unknown,
  processingLimits?: ImageProcessingLimits,
): Promise<PreparedSharpInput> {
  const limits = normalizeImageProcessingLimits(processingLimits);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-heif-'));
  const decodedPath = path.join(tempDir, 'source.png');

  try {
    const decodeHeif = loadBundledHeifDecoder();
    const decoded = await decodeHeif({ buffer: await fs.readFile(filePath) });
    const pixelCount = decoded.width * decoded.height * 4;
    if (!decoded.width || !decoded.height || decoded.data.byteLength < pixelCount) {
      throw new Error('HEIF decoder returned an incomplete image.');
    }
    const pixels = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, pixelCount);
    await sharp(pixels, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
      limitInputPixels: limits.limitInputPixels,
    }).png().toFile(decodedPath);

    const metadata = await sharp(decodedPath, { limitInputPixels: limits.limitInputPixels }).metadata();
    return {
      path: decodedPath,
      metadata,
      usedNativeFallback: true,
      dispose: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (fallbackError) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new Error(`Could not decode source image. Sharp reported: ${errorMessage(originalError)}. HEIF decoder reported: ${errorMessage(fallbackError)}`);
  }
}
