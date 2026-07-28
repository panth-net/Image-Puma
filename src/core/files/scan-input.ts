import * as path from 'path';
import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import type { Dirent } from 'fs';
import {
  InputFile,
  InputScanProgress,
  InputScanResult,
  SkippedInput,
  SkippedInputReason,
} from '../shared/types';
import { SUPPORTED_IMAGE_INPUT_EXTENSIONS } from './supported-image-inputs';
import { prepareSharpInput } from './prepare-sharp-input';

export interface ScanInputsOptions {
  scanId?: string;
  recursive?: boolean;
  shouldCancel?: () => boolean;
  onProgress?: (progress: InputScanProgress) => void;
}

interface ScanProgressState {
  checkedCount: number;
  acceptedCount: number;
  skippedCount: number;
  currentPath?: string;
}

export async function scanInputs(paths: string[], options: ScanInputsOptions = {}): Promise<InputScanResult> {
  const files: InputFile[] = [];
  const skipped: SkippedInput[] = [];
  const seenSourcePaths = new Set<string>();
  const progress: ScanProgressState = {
    checkedCount: 0,
    acceptedCount: 0,
    skippedCount: 0,
  };
  let totalSize = 0;
  let cancelled = false;

  emitProgress(options, progress);

  for (const p of paths) {
    if (isScanCancelled(options)) {
      cancelled = true;
      break;
    }

    progress.checkedCount++;
    progress.currentPath = p;
    emitProgress(options, progress);

    try {
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        await scanDirectory(p, p, files, skipped, seenSourcePaths, progress, options);
      } else if (stat.isFile()) {
        await addFile(p, path.dirname(p), files, skipped, seenSourcePaths, stat.size, progress, options);
      } else {
        addSkipped(skipped, p, 'not-file-or-directory', progress, options);
      }
    } catch {
      addSkipped(skipped, p, 'unreadable', progress, options);
    }

    if (isScanCancelled(options)) {
      cancelled = true;
      break;
    }
  }

  for (const f of files) totalSize += f.fileSize;

  emitProgress(options, progress, true, cancelled);

  return { files, skipped, totalSize, cancelled: cancelled || undefined };
}

async function scanDirectory(
  dir: string,
  baseDir: string,
  files: InputFile[],
  skipped: SkippedInput[],
  seenSourcePaths: Set<string>,
  progress: ScanProgressState,
  options: ScanInputsOptions,
): Promise<void> {
  if (isScanCancelled(options)) return;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    addSkipped(skipped, dir, 'unreadable', progress, options);
    return;
  }

  for (const entry of entries) {
    if (isScanCancelled(options)) return;

    const fullPath = path.join(dir, entry.name);
    progress.checkedCount++;
    progress.currentPath = fullPath;
    emitProgress(options, progress);

    if (entry.isDirectory()) {
      if (options.recursive === false) continue;
      await scanDirectory(fullPath, baseDir, files, skipped, seenSourcePaths, progress, options);
    } else if (entry.isSymbolicLink()) {
      addSkipped(skipped, fullPath, 'symlink', progress, options);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        await addFile(fullPath, baseDir, files, skipped, seenSourcePaths, stat.size, progress, options);
      } catch {
        addSkipped(skipped, fullPath, 'unreadable', progress, options);
      }
    }
  }

  if (entries.length === 0 && dir === baseDir) {
    addSkipped(skipped, dir, 'empty-folder', progress, options);
  }
}

async function addFile(
  filePath: string,
  baseDir: string,
  files: InputFile[],
  skipped: SkippedInput[],
  seenSourcePaths: Set<string>,
  fileSize: number,
  progress: ScanProgressState,
  options: ScanInputsOptions,
): Promise<boolean> {
  if (seenSourcePaths.has(filePath)) {
    addSkipped(skipped, filePath, 'duplicate', progress, options);
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (SUPPORTED_IMAGE_INPUT_EXTENSIONS.has(ext)) {
    try {
      await fs.access(filePath, fsConstants.R_OK);
    } catch {
      addSkipped(skipped, filePath, 'unreadable', progress, options);
      return false;
    }

    let dimensions: Pick<InputFile, 'width' | 'height' | 'format'> = {};
    let preparedInput: Awaited<ReturnType<typeof prepareSharpInput>> | null = null;
    try {
      preparedInput = await prepareSharpInput(filePath, { probeDecode: false });
      const metadata = preparedInput.metadata;
      dimensions = {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      };
    } catch {
      dimensions = {};
    } finally {
      await preparedInput?.dispose();
    }

    seenSourcePaths.add(filePath);
    files.push({
      sourcePath: filePath,
      relativePath: path.relative(baseDir, filePath),
      fileName: path.basename(filePath, ext),
      extension: ext,
      fileSize,
      ...dimensions,
    });
    progress.acceptedCount++;
    emitProgress(options, progress);
    return true;
  } else {
    addSkipped(skipped, filePath, 'unsupported-type', progress, options);
    return false;
  }
}

function addSkipped(
  skipped: SkippedInput[],
  pathValue: string,
  reason: SkippedInputReason,
  progress: ScanProgressState,
  options: ScanInputsOptions,
): void {
  const messageByReason: Record<SkippedInputReason, string> = {
    'unsupported-type': 'Unsupported file type',
    unreadable: 'Could not read this file or folder',
    duplicate: 'Already included in this import',
    symlink: 'Symbolic links are skipped',
    'not-file-or-directory': 'Not a file or folder',
    'empty-folder': 'Folder contained no files',
    cancelled: 'Import was cancelled',
  };

  skipped.push({
    path: pathValue,
    reason,
    message: messageByReason[reason],
  });
  progress.skippedCount++;
  emitProgress(options, progress);
}

function isScanCancelled(options: ScanInputsOptions): boolean {
  return Boolean(options.shouldCancel?.());
}

function emitProgress(
  options: ScanInputsOptions,
  progress: ScanProgressState,
  done = false,
  cancelled = false,
): void {
  if (!options.onProgress || !options.scanId) return;
  options.onProgress({
    scanId: options.scanId,
    checkedCount: progress.checkedCount,
    acceptedCount: progress.acceptedCount,
    skippedCount: progress.skippedCount,
    currentPath: progress.currentPath,
    done,
    cancelled,
  });
}
