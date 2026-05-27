import fs from 'node:fs';
import * as MsgPack from 'msgpackr';

/**
 * Reads a zstd-compressed MessagePack database file.
 * Returns an empty array if the file does not exist.
 *
 * @param filePath - Absolute path to the database file.
 */
export function readDbFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const buffer = fs.readFileSync(filePath);
  const decompressed = Bun.zstdDecompressSync(buffer);
  return MsgPack.unpack(decompressed) as T[];
}

/**
 * Writes data as a zstd-compressed MessagePack database file.
 *
 * @param filePath - Absolute path to the database file.
 * @param data - The data array to write.
 */
export function writeDbFile<T>(filePath: string, data: T[]): void {
  const packed = MsgPack.pack(data);
  const compressed = Bun.zstdCompressSync(packed, { level: 16 });
  fs.writeFileSync(filePath, compressed);
}
