export function toLocalFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const pathname = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encodedPath = pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `local-file://${encodedPath}`;
}
