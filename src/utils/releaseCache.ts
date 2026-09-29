import fs from 'node:fs';
import path from 'node:path';

export interface ReleaseCacheEntry {
  releaseId: number;
  assetCount: number;
  sealed: boolean;
  checkedAt: string;
}

export const RELEASE_CACHE_FILENAME = 'release_cache.json';
export const MAX_ASSETS_PER_RELEASE = 1000;
export const REFRESH_BOUNDARY_MIN = 996;

export function formatReleaseTag(index: number): string {
  return `rel${String(index).padStart(5, '0')}`;
}

export function parseReleaseTagIndex(tag: string): number | null {
  const match = tag.match(/^rel(\d{5})$/);
  if (match === null || match[1] === undefined) return null;
  const index = Number.parseInt(match[1], 10);
  return Number.isNaN(index) ? null : index;
}

export function getReleaseCachePath(outputDbDir: string): string {
  return path.join(outputDbDir, RELEASE_CACHE_FILENAME);
}

export function loadReleaseCache(outputDbDir: string): Record<string, ReleaseCacheEntry> {
  const cachePath = getReleaseCachePath(outputDbDir);
  if (!fs.existsSync(cachePath)) return {};
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, ReleaseCacheEntry> = {};
    for (const [tag, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (parseReleaseTagIndex(tag) === null) continue;
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e['releaseId'] !== 'number' || typeof e['assetCount'] !== 'number') continue;
      result[tag] = {
        releaseId: e['releaseId'] as number,
        assetCount: e['assetCount'] as number,
        sealed: e['sealed'] === true,
        checkedAt: typeof e['checkedAt'] === 'string' ? (e['checkedAt'] as string) : new Date(0).toISOString(),
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function saveReleaseCache(outputDbDir: string, cache: Record<string, ReleaseCacheEntry>): void {
  if (!fs.existsSync(outputDbDir)) {
    fs.mkdirSync(outputDbDir, { recursive: true });
  }
  const cachePath = getReleaseCachePath(outputDbDir);
  const sorted: Record<string, ReleaseCacheEntry> = {};
  for (const tag of Object.keys(cache).sort()) {
    const entry = cache[tag];
    if (entry !== undefined) sorted[tag] = entry;
  }
  fs.writeFileSync(cachePath, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
}
