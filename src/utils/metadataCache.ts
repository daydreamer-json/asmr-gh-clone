import fs from 'node:fs';
import path from 'node:path';
import type { WorkMetadata } from './download.js';

export interface MetadataCacheOkEntry {
  status: 'ok';
  fetchedAt: string;
  metadata: WorkMetadata;
}

export interface MetadataCacheSkippedEntry {
  status: 'skipped';
  reason: 'fileEntry404';
  fetchedAt: string;
}

export type MetadataCacheEntry = MetadataCacheOkEntry | MetadataCacheSkippedEntry;

export const METADATA_CACHE_FILENAME = 'archiving_metadata_cache.json';
const METADATA_CACHE_VERSION = 1;

export function getMetadataCachePath(outputDbDir: string): string {
  return path.join(outputDbDir, METADATA_CACHE_FILENAME);
}

function isValidIdKey(key: string): boolean {
  return /^\d+$/.test(key);
}

export function loadMetadataCache(outputDbDir: string): Record<string, MetadataCacheEntry> {
  const cachePath = getMetadataCachePath(outputDbDir);
  if (!fs.existsSync(cachePath)) return {};
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const root = parsed as Record<string, unknown>;
    if (root['version'] !== METADATA_CACHE_VERSION) return {};
    const rawEntries = root['entries'];
    if (rawEntries === null || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) return {};
    const result: Record<string, MetadataCacheEntry> = {};
    for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (!isValidIdKey(key)) continue;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const e = value as Record<string, unknown>;
      if (e['status'] === 'ok') {
        const metadata = e['metadata'] as Record<string, unknown> | undefined;
        if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
        if ((metadata as { id?: unknown }).id !== Number(key)) continue;
        result[key] = {
          status: 'ok',
          fetchedAt: typeof e['fetchedAt'] === 'string' ? (e['fetchedAt'] as string) : new Date(0).toISOString(),
          metadata: metadata as unknown as WorkMetadata,
        };
      } else if (e['status'] === 'skipped') {
        result[key] = {
          status: 'skipped',
          reason: 'fileEntry404',
          fetchedAt: typeof e['fetchedAt'] === 'string' ? (e['fetchedAt'] as string) : new Date(0).toISOString(),
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveMetadataCache(outputDbDir: string, entries: Record<string, MetadataCacheEntry>): void {
  if (!fs.existsSync(outputDbDir)) {
    fs.mkdirSync(outputDbDir, { recursive: true });
  }
  const cachePath = getMetadataCachePath(outputDbDir);
  const sortedEntries: Record<string, MetadataCacheEntry> = {};
  for (const key of Object.keys(entries).sort((a, b) => Number(a) - Number(b))) {
    const entry = entries[key];
    if (entry !== undefined) sortedEntries[key] = entry;
  }
  const payload = JSON.stringify({ version: METADATA_CACHE_VERSION, entries: sortedEntries });
  const tmpPath = `${cachePath}.tmp`;
  fs.writeFileSync(tmpPath, payload, 'utf-8');
  fs.renameSync(tmpPath, cachePath);
}
