import type sharp from 'sharp';

export type IconOutputFormat = 'ico' | 'icns';

export const WEB_ICO_SIZES = [16, 32, 48] as const;
export const APP_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;
export const ICNS_PNG_SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;

const ICNS_TYPES: ReadonlyArray<{ type: string; size: number }> = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'icp6', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
  { type: 'ic11', size: 32 },
  { type: 'ic12', size: 64 },
  { type: 'ic13', size: 256 },
  { type: 'ic14', size: 512 },
];

export function isIconOutputFormat(format: string): format is IconOutputFormat {
  return format === 'ico' || format === 'icns';
}

export function getIconOutputSize(format: IconOutputFormat): number {
  return format === 'ico' ? 256 : 1024;
}

export function createIco(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const headerSize = 6;
  const entrySize = 16;
  const directory = Buffer.alloc(headerSize + (images.length * entrySize));
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);

  let imageOffset = directory.length;
  images.forEach(({ size, png }, index) => {
    const offset = headerSize + (index * entrySize);
    directory.writeUInt8(size >= 256 ? 0 : size, offset);
    directory.writeUInt8(size >= 256 ? 0 : size, offset + 1);
    directory.writeUInt8(0, offset + 2);
    directory.writeUInt8(0, offset + 3);
    directory.writeUInt16LE(1, offset + 4);
    const pngColorType = png[25];
    directory.writeUInt16LE(pngColorType === 6 ? 32 : 24, offset + 6);
    directory.writeUInt32LE(png.length, offset + 8);
    directory.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += png.length;
  });

  return Buffer.concat([directory, ...images.map(({ png }) => png)]);
}

export function createIcns(pngBySize: ReadonlyMap<number, Buffer>): Buffer {
  const chunks = ICNS_TYPES.map(({ type, size }) => {
    const png = pngBySize.get(size);
    if (!png) throw new Error(`Missing ${size}x${size} PNG required for ICNS output.`);
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

export interface RenderedIconContainer {
  data: Buffer;
  previewPng: Buffer;
  width: number;
  height: number;
}

export async function renderIconContainer(
  pipeline: sharp.Sharp,
  format: IconOutputFormat,
  compressionLevel = 9,
): Promise<RenderedIconContainer> {
  const sizes = format === 'ico' ? APP_ICO_SIZES : ICNS_PNG_SIZES;
  const rendered = await Promise.all(sizes.map(async (size) => ({
    size,
    png: await pipeline
      .clone()
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .ensureAlpha()
      .png({ compressionLevel, adaptiveFiltering: true })
      .toBuffer(),
  })));
  const pngBySize = new Map<number, Buffer>(rendered.map(({ size, png }) => [size, png]));
  const largestSize = getIconOutputSize(format);
  const previewPng = pngBySize.get(largestSize);
  if (!previewPng) throw new Error(`Missing ${largestSize}x${largestSize} icon preview.`);

  return {
    data: format === 'ico' ? createIco(rendered) : createIcns(pngBySize),
    previewPng,
    width: largestSize,
    height: largestSize,
  };
}
