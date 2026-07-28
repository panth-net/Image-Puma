import { execFile } from 'child_process';
import * as fs from 'fs/promises';
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
        return decodeWithMacosImageIo(filePath, decodeError, options.processingLimits);
      }
    }

    return {
      path: filePath,
      metadata,
      usedNativeFallback: false,
      dispose: async () => undefined,
    };
  } catch (metadataError) {
    return decodeWithMacosImageIo(filePath, metadataError, options.processingLimits);
  }
}
