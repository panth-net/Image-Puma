import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { constants as fsConstants } from 'fs';
import { fileURLToPath } from 'url';
import type { InputFile } from '../core/shared/types';
import { ImagePumaMcpError } from './types';

export interface AllowedRoot {
  inputPath: string;
  realPath: string;
}

/**
 * MCP clients on Windows often send workspace roots as drive-letter paths
 * (`C:\Users\...`) instead of `file://` URLs. Convert either form to a
 * filesystem path. Returns null for empty values and non-file URIs.
 */
export function filesystemPathFromUri(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;

  if (/^file:/i.test(trimmed)) {
    return fileUrlToFilesystemPath(trimmed, platform);
  }

  if (isNativeFilesystemPath(trimmed, platform)) {
    return trimmed;
  }

  return null;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function recoverMangledWindowsEscapes(value: string): string {
  return value
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\f/g, '\\f')
    .replace(/\u0008/g, '\\b');
}

export function normalizeMcpFilesystemPath(filePath: string): string {
  let value = stripWrappingQuotes(filePath.trim());
  if (/[\t\n\r\f\u0008]/.test(value)) {
    value = recoverMangledWindowsEscapes(value);
  }
  return filesystemPathFromUri(value) ?? value;
}

function isNativeFilesystemPath(value: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return path.win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  }
  return path.posix.isAbsolute(value);
}

function fileUrlToFilesystemPath(uri: string, platform: NodeJS.Platform): string | null {
  const normalizedUri = uri.replace(/\\/g, '/');

  if (platform === process.platform) {
    try {
      return fileURLToPath(normalizedUri);
    } catch {
      // Hosts emit non-WHATWG Windows file URLs; parse those below.
    }
  }

  try {
    const url = new URL(normalizedUri);
    if (url.protocol.toLowerCase() !== 'file:') return null;

    let pathname = decodeURIComponent(url.pathname);
    const hostname = decodeURIComponent(url.hostname || '');

    if (platform === 'win32') {
      if (hostname && hostname.toLowerCase() !== 'localhost') {
        return `\\\\${hostname}${pathname.replace(/\//g, '\\')}`;
      }
      if (/^\/[A-Za-z]:/.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return pathname.replace(/\//g, '\\');
    }

    if (hostname && hostname.toLowerCase() !== 'localhost') {
      return `/${hostname}${pathname}`;
    }
    return pathname;
  } catch {
    return null;
  }
}

function normalizeForContainment(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (process.platform !== 'win32') return resolved;
  return resolved.replace(/^\\\\\?\\/i, '').toLowerCase();
}

function isFilesystemRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  return path.parse(resolved).root === resolved;
}

/**
 * Folders Image Puma can use without a `roots/list` round-trip. Cursor on
 * Windows sends drive-letter workspace roots that fail the MCP `file://`
 * schema, so the server never asks the client for roots.
 */
export function listDefaultAllowedDirCandidates(
  home = os.homedir(),
  cwd = process.cwd(),
): string[] {
  const dirs: string[] = [];
  if (cwd && !isFilesystemRoot(cwd)) dirs.push(cwd);
  for (const name of ['Pictures', 'Downloads', 'Documents', 'Desktop']) {
    dirs.push(path.join(home, name));
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const dir of dirs) {
    const key = normalizeForContainment(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path.resolve(dir));
  }
  return unique;
}

export async function resolveAllowedRoots(
  roots: string[],
  options: { skipMissing?: boolean } = {},
): Promise<AllowedRoot[]> {
  const resolved: AllowedRoot[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const inputPath = path.resolve(normalizeMcpFilesystemPath(root));
    let realPath: string;
    try {
      const stat = await fs.stat(inputPath);
      if (!stat.isDirectory()) {
        throw new ImagePumaMcpError('PATH_NOT_ALLOWED', `Allowed root is not a directory: ${inputPath}`);
      }
      realPath = await fs.realpath(inputPath);
      await fs.access(realPath, fsConstants.R_OK);
    } catch (error) {
      if (options.skipMissing) continue;
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

export async function resolveConfiguredAndDefaultAllowedRoots(configured: string[]): Promise<AllowedRoot[]> {
  const explicit = await resolveAllowedRoots(configured);
  const extra = await resolveAllowedRoots(listDefaultAllowedDirCandidates(), { skipMissing: true });
  const roots = [...explicit];
  const seen = new Set(explicit.map((root) => root.realPath));
  for (const root of extra) {
    if (seen.has(root.realPath)) continue;
    seen.add(root.realPath);
    roots.push(root);
  }
  return roots;
}

function hasPathPrefix(realPath: string, rootRealPath: string): boolean {
  const relative = path.relative(normalizeForContainment(rootRealPath), normalizeForContainment(realPath));
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
  const absolutePath = path.resolve(normalizeMcpFilesystemPath(filePath));
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
  const absolutePath = path.resolve(normalizeMcpFilesystemPath(dirPath));
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
  const absolutePath = path.resolve(normalizeMcpFilesystemPath(outputPath));
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
