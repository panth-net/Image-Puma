export function resolveLocalFileProtocolPath(
  requestUrl: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const parsed = new URL(requestUrl);
  let filePath = decodeURIComponent(parsed.pathname);

  if (parsed.hostname) {
    const hostname = decodeURIComponent(parsed.hostname);
    const rootSegment = platform === 'darwin' && hostname === 'users'
      ? 'Users'
      : hostname;
    filePath = `/${rootSegment}${filePath}`;
  }

  if (platform === 'win32' && /^\/[A-Za-z]:\//.test(filePath)) {
    return filePath.slice(1);
  }

  return filePath;
}
