import * as fs from 'fs/promises';
import * as path from 'path';
import { constants as fsConstants } from 'fs';
import type { InputFile } from '../core/shared/types';
import { ImagePumaMcpError } from './types';

export interface AllowedRoot {
  inputPath: string;
  realPath: string;
}

export async function resolveAllowedRoots(roots: string[]): Promise<AllowedRoot[]> {
  const resolved: AllowedRoot[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const inputPath = path.resolve(root);
    let realPath: string;
    try {
      const stat = await fs.stat(inputPath);
      if (!stat.isDirectory()) {
        throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Allowed root is not a directory: ${inputPath}`);
      }
      realPath = await fs.realpath(inputPath);
      await fs.access(realPath, fsConstants.R_OK);
    } catch (error) {
      if (error instanceof ImagePumaMcpError) throw error;
      throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Allowed root is missing or unreadable: ${inputPath}`);
    }

    if (!seen.has(realPath)) {
      seen.add(realPath);
      resolved.push({ inputPath, realPath });
    }
  }

  return resolved;
}

function hasPathPrefix(realPath: string, rootRealPath: string): boolean {
  const relative = path.relative(rootRealPath, realPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isPathInsideAllowedRoots(realPath: string, roots: AllowedRoot[]): boolean {
  return roots.some((root) => hasPathPrefix(realPath, root.realPath));
}

export function assertAllowedRootsConfigured(roots: AllowedRoot[]): void {
  if (roots.length === 0) {
    throw new ImagePumaMcpError(
      'PATH_NOT_ALLOWED',
      'No allowed directories are configured. Start the MCP server with --allow-dir <absolute-folder>.',
    );
  }
}

export async function realpathForExistingPath(filePath: string, roots: AllowedRoot[]): Promise<string> {
  assertAllowedRootsConfigured(roots);
  const absolutePath = path.resolve(filePath);
  const stat = await fs.lstat(absolutePath).catch((): null => null);
  if (!stat) {
    throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Path does not exist: ${absolutePath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Symbolic links are not accepted as explicit MCP inputs: ${absolutePath}`);
  }

  const realPath = await fs.realpath(absolutePath);
  if (!isPathInsideAllowedRoots(realPath, roots)) {
    throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Path is outside the configured allowed directories: ${absolutePath}`, {
      path: absolutePath,
    });
  }
  return realPath;
}

export async function canonicalizeExistingDirectory(dirPath: string, roots: AllowedRoot[]): Promise<string> {
  assertAllowedRootsConfigured(roots);
  const absolutePath = path.resolve(dirPath);
  const stat = await fs.stat(absolutePath).catch((): null => null);
  if (!stat?.isDirectory()) {
    throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Output directory is missing or not a directory: ${absolutePath}`);
  }
  await fs.access(absolutePath, fsConstants.W_OK).catch((): never => {
    throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Output directory is not writable: ${absolutePath}`);
  });

  const realPath = await fs.realpath(absolutePath);
  if (!isPathInsideAllowedRoots(realPath, roots)) {
    throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Output directory is outside the configured allowed directories: ${absolutePath}`, {
      path: absolutePath,
    });
  }
  return realPath;
}

async function realpathForNearestExistingAncestor(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath);
  const remainder: string[] = [];

  for (;;) {
    const stat = await fs.lstat(current).catch((): null => null);
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Output path crosses a symbolic link: ${current}`);
      }
      const realAncestor = await fs.realpath(current);
      return path.join(realAncestor, ...remainder.reverse());
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Could not resolve output path: ${targetPath}`);
    }
    remainder.push(path.basename(current));
    current = parent;
  }
}

export async function canonicalizeOutputPath(outputPath: string, roots: AllowedRoot[]): Promise<string> {
  assertAllowedRootsConfigured(roots);
  const absolutePath = path.resolve(outputPath);
  const existing = await fs.lstat(absolutePath).catch((): null => null);
  if (existing?.isSymbolicLink()) {
    throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Output path is a symbolic link: ${absolutePath}`);
  }

  const canonicalPath = await realpathForNearestExistingAncestor(absolutePath);
  if (!isPathInsideAllowedRoots(canonicalPath, roots)) {
    throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Output path is outside the configured allowed directories: ${absolutePath}`, {
      path: absolutePath,
    });
  }
  return canonicalPath;
}

export async function normalizeScannedFiles(files: InputFile[], roots: AllowedRoot[]): Promise<InputFile[]> {
  const seen = new Set<string>();
  const normalized: InputFile[] = [];

  for (const file of files) {
    const realPath = await fs.realpath(file.sourcePath);
    if (!isPathInsideAllowedRoots(realPath, roots)) {
      throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Scanned file is outside the configured allowed directories: ${file.sourcePath}`, {
        path: file.sourcePath,
      });
    }
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    normalized.push({
      ...file,
      sourcePath: realPath,
    });
  }

  return normalized;
}
