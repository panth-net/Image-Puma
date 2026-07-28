import { spawn } from 'child_process';
import * as path from 'path';
import { exiftoolPath } from 'exiftool-vendored';
import type { MetadataSettings } from '../shared/types';
import {
  isMetadataRewriteEnabled,
  metadataRewriteUsesCreator,
  metadataRewriteUsesTimestamp,
  normalizeMetadataSettings,
} from '../shared/metadata-settings';

export interface ExiftoolCommandResult {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface StripPrivacyMetadataResult {
  ok: boolean;
  imagePath: string;
  tagsRemoved: string[];
  stderr: string;
  warnings: string[];
}

export interface MetadataPolicyResult {
  warnings: string[];
}

export interface MetadataVerificationResult {
  ok: boolean;
  forbiddenTagKeys: string[];
}

export interface MetadataCleanupResult {
  ok: boolean;
  warnings: string[];
}

const PRIVACY_STRIP_ARGS: string[] = [
  '-gps:all=',
  '-Apple:ContentIdentifier=',
  '-Apple:PhotoIdentifier=',
  '-Apple:ImageCaptureRequestID=',
  '-Apple:AccelerationVector=',
  '-IFD0:HostComputer=',
  '-IFD0:Make=',
  '-IFD0:Model=',
  '-IFD0:ModifyDate=',
  '-IFD0:Software=',
  '-ExifIFD:CreateDate=',
  '-ExifIFD:DateTimeOriginal=',
  '-ExifIFD:LensModel=',
  '-ExifIFD:BodySerialNumber=',
  '-ExifIFD:CameraOwnerName=',
  '-ExifIFD:LensSerialNumber=',
  '-ExifIFD:OffsetTime=',
  '-ExifIFD:OffsetTimeOriginal=',
  '-ExifIFD:OffsetTimeDigitized=',
  '-ExifIFD:SubSecTime=',
  '-ExifIFD:SubSecTimeOriginal=',
  '-ExifIFD:SubSecTimeDigitized=',
  '-MakerNotes:all=',
  '-XMP-exif:GPSLatitude=',
  '-XMP-exif:GPSLongitude=',
  '-XMP-exif:GPSAltitude=',
  '-XMP-exif:GPSDateStamp=',
  '-XMP-exif:GPSTimeStamp=',
  '-XMP-aux:SerialNumber=',
  '-XMP-aux:OwnerName=',
  '-XMP-aux:LensSerialNumber=',
  '-XMP-xmp:CreateDate=',
  '-XMP-xmp:ModifyDate=',
  '-XMP-xmp:MetadataDate=',
];

const STRICT_FORBIDDEN_GROUP_PREFIXES = [
  'Apple:',
  'Canon:',
  'EXIF:',
  'ExifIFD:',
  'GPS:',
  'IFD',
  'IPTC:',
  'MakerNotes:',
  'Nikon:',
  'Olympus:',
  'Panasonic:',
  'Photoshop:',
  'Sony:',
  'XMP',
];

const PSEUDO_GROUP_PREFIXES = [
  'ExifTool:',
  'File:',
  'MacOS:',
  'System:',
];

const STRUCTURAL_GROUP_PREFIXES = [
  'Composite:',
  'HEVC:',
  'JFIF:',
  'Meta:',
  'PNG:',
  'QuickTime:',
  'RIFF:',
];

const PNG_TEXT_METADATA_TAGS = new Set([
  'Author',
  'Comment',
  'Copyright',
  'CreationTime',
  'Description',
  'Disclaimer',
  'Producer',
  'Software',
  'Source',
  'Title',
  'Warning',
]);

const IFD_STRUCTURAL_TAGS = new Set([
  'BitsPerSample',
  'ColorMap',
  'Compression',
  'ExtraSamples',
  'FillOrder',
  'ImageHeight',
  'ImageWidth',
  'JPEGTables',
  'NewSubfileType',
  'Orientation',
  'PhotometricInterpretation',
  'PlanarConfiguration',
  'PreviewImage',
  'PreviewImageLength',
  'PreviewImageStart',
  'Predictor',
  'ResolutionUnit',
  'RowsPerStrip',
  'SampleFormat',
  'SamplesPerPixel',
  'StripByteCounts',
  'StripOffsets',
  'SubfileType',
  'TileByteCounts',
  'TileLength',
  'TileOffsets',
  'TileWidth',
  'XResolution',
  'YCbCrPositioning',
  'YResolution',
]);

const EXIF_STRUCTURAL_TAGS = new Set([
  'ColorSpace',
  'ComponentsConfiguration',
  'ExifImageHeight',
  'ExifImageWidth',
  'ExifVersion',
  'FlashpixVersion',
]);

const CROSS_FORMAT_PRIVATE_PATTERNS = [
  /(^|:)GPS/i,
  /(^|:)C2PA/i,
  /(^|:)CBOR/i,
  /(^|:)JUMBF/i,
  /ContentCredential/i,
  /DigitalSourceType/i,
  /DigitalImageGUID/i,
  /SynthID/i,
  /ContentIdentifier/i,
  /PhotoIdentifier/i,
  /ImageCaptureRequestID/i,
  /SerialNumber/i,
  /OwnerName/i,
  /CameraOwnerName/i,
  /HostComputer/i,
  /MakerNote/i,
  /MakerNotes/i,
  /LensModel/i,
  /BodySerialNumber/i,
  /LensSerialNumber/i,
  /DateTimeOriginal/i,
  /CreateDate/i,
  /ModifyDate/i,
  /MetadataDate/i,
  /SubSecTime/i,
  /OffsetTime/i,
  /IFD0:Make$/i,
  /IFD0:Model$/i,
  /IFD0:Software$/i,
  /^Apple:/i,
];

const ROUND_SECONDS = new Set([0, 15, 30, 45]);
const ROUND_MINUTES = new Set([0, 15, 30, 45]);

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatExiftoolTimestamp(date: Date): string {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join(':') + ` ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function jitterTimestamp(baseDate = new Date()): Date {
  const jitterMinutes = Math.floor(Math.random() * 23) - 11;
  const jitterSeconds = Math.floor(Math.random() * 53) + 4;
  const jittered = new Date(baseDate.getTime() + (jitterMinutes * 60_000) + (jitterSeconds * 1_000));

  if (ROUND_MINUTES.has(jittered.getUTCMinutes())) {
    jittered.setUTCMinutes((jittered.getUTCMinutes() + 3) % 60);
  }
  if (ROUND_SECONDS.has(jittered.getUTCSeconds())) {
    jittered.setUTCSeconds((jittered.getUTCSeconds() + 7) % 60);
  }
  return jittered;
}

function isAllowedRewrittenTag(key: string, metadata: MetadataSettings): boolean {
  const normalizedMetadata = normalizeMetadataSettings(metadata);
  if (metadataRewriteUsesTimestamp(normalizedMetadata)) {
    if (key === 'XMP-xmp:CreateDate' || key === 'XMP-xmp:ModifyDate' || key === 'PNG:CreationTime') {
      return true;
    }
  }
  if (metadataRewriteUsesCreator(normalizedMetadata) && key === 'XMP-dc:Creator') {
    return true;
  }
  return false;
}

export async function runExiftoolCommand(args: string[]): Promise<ExiftoolCommandResult> {
  const binaryPath = await exiftoolPath();
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.once('error', (error: Error) => {
      reject(error);
    });

    child.once('close', (exitCode: number | null) => {
      const normalizedExitCode = typeof exitCode === 'number' ? exitCode : -1;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const result: ExiftoolCommandResult = {
        args,
        stdout,
        stderr,
        exitCode: normalizedExitCode,
      };

      if (normalizedExitCode === 0) {
        resolve(result);
        return;
      }

      const wrapped = new Error(`exiftool failed (exit ${normalizedExitCode})`) as Error & {
        result?: ExiftoolCommandResult;
      };
      wrapped.result = result;
      reject(wrapped);
    });
  });
}

function tagName(key: string): string {
  const index = key.indexOf(':');
  return index >= 0 ? key.slice(index + 1) : key;
}

function groupName(key: string): string {
  const index = key.indexOf(':');
  return index >= 0 ? key.slice(0, index) : '';
}

function hasPrefix(key: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function isIccTag(key: string): boolean {
  return key.startsWith('ICC-header:') || key.startsWith('ICC_Profile:');
}

function isStructuralTag(key: string): boolean {
  if (key.startsWith('Composite:GPS')) return false;
  if (key.startsWith('PNG:') && PNG_TEXT_METADATA_TAGS.has(tagName(key))) return false;
  return hasPrefix(key, STRUCTURAL_GROUP_PREFIXES);
}

function isRequiredImageStructureTag(key: string): boolean {
  const group = groupName(key);
  const tag = tagName(key);
  if (group.startsWith('IFD') && IFD_STRUCTURAL_TAGS.has(tag)) return true;
  if (group === 'ExifIFD' && EXIF_STRUCTURAL_TAGS.has(tag)) return true;
  return false;
}

function isStrictForbiddenTag(key: string, allowIcc: boolean): boolean {
  if (hasPrefix(key, PSEUDO_GROUP_PREFIXES)) return false;
  if (allowIcc && (isIccTag(key) || key === 'PNG:ProfileName')) return false;
  if (isRequiredImageStructureTag(key)) return false;
  if (isStructuralTag(key)) {
    return CROSS_FORMAT_PRIVATE_PATTERNS.some((pattern) => pattern.test(key));
  }
  if (isIccTag(key)) return !allowIcc;
  if (hasPrefix(key, STRICT_FORBIDDEN_GROUP_PREFIXES)) return true;
  return CROSS_FORMAT_PRIVATE_PATTERNS.some((pattern) => pattern.test(key));
}

function isSelectiveForbiddenTag(key: string): boolean {
  if (hasPrefix(key, PSEUDO_GROUP_PREFIXES)) return false;
  return CROSS_FORMAT_PRIVATE_PATTERNS.some((pattern) => pattern.test(key));
}

function getForbiddenTagKeys(
  tags: Record<string, unknown>,
  metadata: MetadataSettings,
): string[] {
  const keys = Object.keys(tags);
  if (metadata.mode === 'strip-all') {
    return keys
      .filter((key) => !isAllowedRewrittenTag(key, metadata))
      .filter((key) => isStrictForbiddenTag(key, false))
      .sort();
  }
  if (metadata.mode === 'strip-privacy-smart') {
    return keys
      .filter((key) => !isAllowedRewrittenTag(key, metadata))
      .filter((key) => isStrictForbiddenTag(key, true))
      .sort();
  }
  if (metadata.mode === 'strip-gps-only') {
    return keys
      .filter((key) => !isAllowedRewrittenTag(key, metadata))
      .filter(isSelectiveForbiddenTag)
      .sort();
  }
  return [];
}

async function applyMetadataRewrite(imagePath: string, metadata: MetadataSettings): Promise<MetadataPolicyResult> {
  const normalizedMetadata = normalizeMetadataSettings(metadata);
  const warnings: string[] = [];
  const rewriteArgs = ['-overwrite_original'];

  if (metadataRewriteUsesTimestamp(normalizedMetadata)) {
    const timestamp = formatExiftoolTimestamp(jitterTimestamp());
    rewriteArgs.push(`-XMP-xmp:CreateDate=${timestamp}`);
    rewriteArgs.push(`-XMP-xmp:ModifyDate=${timestamp}`);
    if (path.extname(imagePath).toLowerCase() === '.png') {
      rewriteArgs.push(`-PNG:CreationTime=${timestamp}+00:00`);
    }
  }

  if (metadataRewriteUsesCreator(normalizedMetadata)) {
    const creatorName = normalizedMetadata.creatorName?.trim() || '';
    if (creatorName.length > 0) {
      rewriteArgs.push(`-XMP-dc:Creator=${creatorName}`);
    } else {
      warnings.push('Creator rewrite skipped because no creator name was provided.');
    }
  }

  if (rewriteArgs.length <= 1) {
    return { warnings };
  }

  await runExiftoolCommand([...rewriteArgs, path.resolve(imagePath)]);
  const cleanup = await stripGeneratedMetadataArtifacts(imagePath);
  warnings.push(...cleanup.warnings);
  return { warnings };
}

export async function stripGeneratedMetadataArtifacts(imagePath: string): Promise<MetadataCleanupResult> {
  const cleanupArgs = ['-overwrite_original', '-XMP-x:XMPToolkit='];
  if (path.extname(imagePath).toLowerCase() === '.png') {
    cleanupArgs.push('-PNG-pHYs:all=');
  }
  cleanupArgs.push(path.resolve(imagePath));

  try {
    await runExiftoolCommand(cleanupArgs);
    return { ok: true, warnings: [] };
  } catch {
    return {
      ok: false,
      warnings: [`Optional metadata artifact cleanup failed for ${path.basename(imagePath)}.`],
    };
  }
}

export async function stripPrivacyMetadata(imagePath: string): Promise<StripPrivacyMetadataResult> {
  const absolutePath = path.resolve(imagePath);

  try {
    const result = await runExiftoolCommand([
      '-overwrite_original',
      ...PRIVACY_STRIP_ARGS,
      absolutePath,
    ]);
    const cleanup = await stripGeneratedMetadataArtifacts(absolutePath);

    return {
      ok: true,
      imagePath: absolutePath,
      tagsRemoved: PRIVACY_STRIP_ARGS.map((arg) => arg.replace(/^-/, '').replace(/=$/, '')),
      stderr: result.stderr,
      warnings: cleanup.warnings,
    };
  } catch (error) {
    throw new Error(`Could not strip private metadata from ${absolutePath}: ${toErrorMessage(error)}`);
  }
}

export async function verifyOutputMetadataPolicy(
  outputPath: string,
  metadata: MetadataSettings,
): Promise<MetadataVerificationResult> {
  const forbiddenTagKeys = getForbiddenTagKeys(await readExiftoolJson(outputPath), metadata);
  if (forbiddenTagKeys.length > 0) {
    throw new Error(
      `Metadata verification failed for ${path.basename(outputPath)}; forbidden tags remain: ${forbiddenTagKeys.join(', ')}`,
    );
  }
  return { ok: true, forbiddenTagKeys };
}

export async function applyOutputMetadataPolicy(
  outputPath: string,
  metadata: MetadataSettings,
): Promise<MetadataPolicyResult> {
  const warnings: string[] = [];
  const normalizedMetadata = normalizeMetadataSettings(metadata);
  if (metadata.mode === 'strip-gps-only') {
    const result = await stripPrivacyMetadata(outputPath);
    warnings.push(...result.warnings);
    if (isMetadataRewriteEnabled(normalizedMetadata)) {
      const rewrite = await applyMetadataRewrite(outputPath, normalizedMetadata);
      warnings.push(...rewrite.warnings);
    }
    await verifyOutputMetadataPolicy(outputPath, normalizedMetadata);
    return { warnings };
  }

  if (metadata.mode === 'strip-all' || metadata.mode === 'strip-privacy-smart') {
    const cleanup = await stripGeneratedMetadataArtifacts(outputPath);
    warnings.push(...cleanup.warnings);
    if (isMetadataRewriteEnabled(normalizedMetadata)) {
      const rewrite = await applyMetadataRewrite(outputPath, normalizedMetadata);
      warnings.push(...rewrite.warnings);
    }
    await verifyOutputMetadataPolicy(outputPath, normalizedMetadata);
    return { warnings };
  }

  if (isMetadataRewriteEnabled(normalizedMetadata)) {
    const rewrite = await applyMetadataRewrite(outputPath, normalizedMetadata);
    warnings.push(...rewrite.warnings);
  }

  return { warnings };
}

export async function readExiftoolJson(imagePath: string): Promise<Record<string, unknown>> {
  const result = await runExiftoolCommand([
    '-json',
    '-struct',
    '-G1',
    '-a',
    '-u',
    '-n',
    '-api',
    'RequestAll=3',
    path.resolve(imagePath),
  ]);
  const parsed = JSON.parse(result.stdout.trim()) as unknown;
  if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
    return parsed[0] as Record<string, unknown>;
  }
  if (parsed && typeof parsed === 'object') {
    return parsed as Record<string, unknown>;
  }
  return {};
}
