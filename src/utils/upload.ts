import fs from 'node:fs';
import { Octokit } from '@octokit/rest';
import PQueue from 'p-queue';
import type { DbChunk, DbFile, DbWork } from '../types/db.js';
import configAuth from './configAuth.js';
import dbClient from './dbClient.js';
import githubUtils from './github.js';
import logger from './logger.js';
import {
  MAX_ASSETS_PER_RELEASE,
  REFRESH_BOUNDARY_MIN,
  formatReleaseTag,
  loadReleaseCache,
  parseReleaseTagIndex,
  saveReleaseCache,
} from './releaseCache.js';

const dbUploadQueue = new PQueue({ concurrency: 1 });

interface TagCacheEntry {
  releaseId: number;
  assetCount: number;
  sealed: boolean;
}

const tagAssetCountCache = new Map<string, TagCacheEntry>();
let tagCacheLoadedDir: string | null = null;

function ensureTagCacheLoaded(outputDbDir?: string): void {
  if (outputDbDir === undefined || outputDbDir === '') return;
  if (tagCacheLoadedDir === outputDbDir) return;
  const diskCache = loadReleaseCache(outputDbDir);
  for (const [tag, entry] of Object.entries(diskCache)) {
    const existing = tagAssetCountCache.get(tag);
    if (existing === undefined || existing.releaseId !== entry.releaseId) {
      tagAssetCountCache.set(tag, {
        releaseId: entry.releaseId,
        assetCount: entry.assetCount,
        sealed: entry.sealed,
      });
    }
  }
  tagCacheLoadedDir = outputDbDir;
}

function flushTagCache(outputDbDir?: string): void {
  if (outputDbDir === undefined || outputDbDir === '') return;
  const diskCache = loadReleaseCache(outputDbDir);
  for (const [tag, entry] of tagAssetCountCache.entries()) {
    diskCache[tag] = {
      releaseId: entry.releaseId,
      assetCount: entry.assetCount,
      sealed: entry.sealed,
      checkedAt: new Date().toISOString(),
    };
  }
  try {
    saveReleaseCache(outputDbDir, diskCache);
  } catch (e) {
    logger.warn(`Failed to persist release cache: ${e}`);
  }
}

function incrementTagCache(tag: string, outputDbDir?: string): void {
  const entry = tagAssetCountCache.get(tag);
  if (entry !== undefined) {
    entry.assetCount++;
    if (entry.assetCount >= MAX_ASSETS_PER_RELEASE) {
      entry.sealed = true;
    }
    if (outputDbDir !== undefined && outputDbDir !== '') {
      ensureTagCacheLoaded(outputDbDir);
      flushTagCache(outputDbDir);
    }
  }
}

function isNotFoundError(e: any): boolean {
  return e !== null && typeof e === 'object' && (e as any).status === 404;
}

async function uploadOrReplaceAsset(
  client: Octokit,
  owner: string,
  repo: string,
  tag: string,
  targetFileName: string,
  filePath: string,
): Promise<string> {
  const release = await githubUtils.getReleaseInfo(client, owner, repo, tag);
  if (!release) {
    throw new Error(`GitHub release with tag "${tag}" not found.`);
  }

  const tempFileName = `temp-${targetFileName}`;

  const existingTempAsset = release.assets.find((a: any) => a.name === tempFileName);
  if (existingTempAsset !== undefined) {
    logger.info(
      `Deleting existing temp asset "${tempFileName}" (ID: ${existingTempAsset.id}) from release "${tag}"...`,
    );
    try {
      await client.rest.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: existingTempAsset.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e: any) {
      logger.warn(`Failed to delete existing temp asset "${tempFileName}": ${e.message || e}`);
    }
  }

  logger.info(`Uploading DB asset "${targetFileName}" as temp asset "${tempFileName}" to release "${tag}"...`);
  const tempUrl = await githubUtils.uploadAsset(client, owner, repo, tag, tempFileName, filePath);

  let updatedRelease: any = null;
  let uploadedTempAsset: any = undefined;
  for (let i = 0; i < 3; i++) {
    updatedRelease = await githubUtils.getReleaseInfo(client, owner, repo, tag);
    if (updatedRelease) {
      uploadedTempAsset = updatedRelease.assets.find((a: any) => a.name === tempFileName);
      if (uploadedTempAsset) {
        break;
      }
    }
    logger.warn(`Temp asset "${tempFileName}" not found in release assets list, retrying in 2 seconds...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!uploadedTempAsset || !updatedRelease) {
    throw new Error(`Uploaded temp asset "${tempFileName}" not found in release assets list after retries.`);
  }

  const existingAsset = updatedRelease.assets.find((a: any) => a.name === targetFileName);
  if (existingAsset !== undefined) {
    logger.info(`Deleting existing asset "${targetFileName}" (ID: ${existingAsset.id}) from release "${tag}"...`);
    try {
      await client.rest.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: existingAsset.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e: any) {
      logger.warn(`Failed to delete existing asset "${targetFileName}": ${e.message || e}`);
    }
  }

  logger.info(`Renaming temp asset "${tempFileName}" to "${targetFileName}"...`);
  await client.rest.repos.updateReleaseAsset({
    owner,
    repo,
    asset_id: uploadedTempAsset.id,
    name: targetFileName,
  });

  const finalUrl = tempUrl.replace(tempFileName, targetFileName);
  return finalUrl;
}

async function countReleaseAssets(client: Octokit, owner: string, repo: string, releaseId: number): Promise<number> {
  let assetCount = 0;
  let page = 1;
  while (true) {
    const assets = await client.rest.repos.listReleaseAssets({
      owner,
      repo,
      release_id: releaseId,
      per_page: 100,
      page,
    });
    assetCount += assets.data.length;
    if (assets.data.length < 100) {
      break;
    }
    page++;
  }
  return assetCount;
}

async function listRelTagNames(client: Octokit, owner: string, repo: string): Promise<string[]> {
  const tags: string[] = [];
  let page = 1;
  while (true) {
    const response = await client.rest.repos.listTags({
      owner,
      repo,
      per_page: 100,
      page,
    });
    for (const entry of response.data) {
      if (parseReleaseTagIndex(entry.name) !== null) {
        tags.push(entry.name);
      }
    }
    if (response.data.length < 100) {
      break;
    }
    page++;
  }
  tags.sort((a, b) => (parseReleaseTagIndex(a) ?? 0) - (parseReleaseTagIndex(b) ?? 0));
  return tags;
}

async function getReleaseIdByTag(client: Octokit, owner: string, repo: string, tag: string): Promise<number | null> {
  try {
    const release = await githubUtils.getReleaseInfo(client, owner, repo, tag);
    if (!release) return null;
    return release.id as number;
  } catch (e: any) {
    if (isNotFoundError(e)) return null;
    throw e;
  }
}

async function getOrCreateUploadTag(
  client: Octokit,
  owner: string,
  repo: string,
  outputDbDir?: string,
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  const forceRefresh = opts?.forceRefresh === true;
  if (outputDbDir !== undefined && outputDbDir !== '') {
    ensureTagCacheLoaded(outputDbDir);
  }

  let index = 0;
  while (true) {
    if (index > 100000) {
      throw new Error('Too many rel tags, aborting');
    }
    const tag = formatReleaseTag(index);

    const cached = tagAssetCountCache.get(tag);
    if (cached !== undefined && cached.sealed && !forceRefresh) {
      logger.trace(`GitHub Release ${tag} skipped (sealed cache)`);
      index++;
      continue;
    }

    let release: any = null;
    try {
      release = await githubUtils.getReleaseInfo(client, owner, repo, tag);
    } catch (e: any) {
      if (!isNotFoundError(e)) throw e;
    }

    if (release === null || release === undefined) {
      logger.info(`GitHub Release with tag ${tag} not found. Creating new release...`);
      const created = await githubUtils.createNewRelease(
        client,
        owner,
        repo,
        tag,
        'Untitled',
        'nothing to explain',
        true,
      );
      tagAssetCountCache.set(tag, { releaseId: created.id as number, assetCount: 0, sealed: false });
      flushTagCache(outputDbDir);
      return tag;
    }

    const releaseId = release.id as number;
    const cachedEntry = tagAssetCountCache.get(tag);
    let assetCount: number;

    if (
      cachedEntry !== undefined &&
      cachedEntry.releaseId === releaseId &&
      !forceRefresh &&
      !(cachedEntry.assetCount >= REFRESH_BOUNDARY_MIN && cachedEntry.assetCount < MAX_ASSETS_PER_RELEASE)
    ) {
      assetCount = cachedEntry.assetCount;
      logger.trace(`GitHub Release ${tag} current assets count (cached): ${assetCount}`);
    } else {
      assetCount = await countReleaseAssets(client, owner, repo, releaseId);
      tagAssetCountCache.set(tag, {
        releaseId,
        assetCount,
        sealed: assetCount >= MAX_ASSETS_PER_RELEASE,
      });
      flushTagCache(outputDbDir);
      logger.trace(`GitHub Release ${tag} current assets count: ${assetCount}`);
    }

    if (assetCount < MAX_ASSETS_PER_RELEASE) {
      return tag;
    }

    tagAssetCountCache.set(tag, { releaseId, assetCount, sealed: true });
    flushTagCache(outputDbDir);
    index++;
  }
}

async function uploadChunkFile(
  client: Octokit,
  owner: string,
  repo: string,
  tag: string,
  chunkUuid: string,
  filePath: string,
  outputDbDir?: string,
): Promise<string> {
  const assetName = `chunk-${chunkUuid}.bin`;
  const url = await githubUtils.uploadAsset(client, owner, repo, tag, assetName, filePath);
  incrementTagCache(tag, outputDbDir);
  return url;
}

async function saveMetadata(outputDbDir: string, works: DbWork[], files: DbFile[], chunks: DbChunk[]): Promise<void> {
  if (!fs.existsSync(outputDbDir)) {
    fs.mkdirSync(outputDbDir, { recursive: true });
  }

  const updatedFiles = await dbClient.append(outputDbDir, works, files, chunks);

  if (updatedFiles.length > 0) {
    await dbUploadQueue.add(async () => {
      const client = new Octokit({ auth: configAuth.github.pat.main });
      const owner = configAuth.github.owner.main;
      const repo = configAuth.github.repo.main;
      const tag = 'db';

      for (const file of updatedFiles) {
        let retries = 3;
        while (retries > 0) {
          try {
            await uploadOrReplaceAsset(client, owner, repo, tag, file.name, file.path);
            break;
          } catch (error: any) {
            retries--;
            logger.error(`Error uploading DB asset ${file.name} (Retries left: ${retries}): ${error.message || error}`);
            if (retries === 0) {
              logger.error(`Failed to upload DB asset ${file.name}. Local DB is up-to-date; will retry on next run.`);
            } else {
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
        }
      }
    });
  }
}

export interface CleanupOptions {
  outputDbDir?: string | undefined;
  includeSealed?: boolean | undefined;
  dryRun?: boolean | undefined;
  forceRefresh?: boolean | undefined;
}

export interface CleanupResult {
  scannedTags: number;
  skippedSealedTags: number;
  deletedCount: number;
}

async function scanTagsForOrphans(
  client: Octokit,
  owner: string,
  repo: string,
  validChunkUuids: Set<string>,
  tags: string[],
  opts?: CleanupOptions,
): Promise<CleanupResult> {
  const includeSealed = opts?.includeSealed === true;
  const dryRun = opts?.dryRun === true;
  const forceRefresh = opts?.forceRefresh === true;
  const outputDbDir = opts?.outputDbDir;

  if (outputDbDir !== undefined && outputDbDir !== '') {
    ensureTagCacheLoaded(outputDbDir);
  }

  const deleteQueue = new PQueue({ concurrency: 4 });
  let deletedCount = 0;
  let scannedTags = 0;
  let skippedSealedTags = 0;

  for (const tag of tags) {
    const cached = tagAssetCountCache.get(tag);
    if (cached !== undefined && cached.sealed && !includeSealed && !forceRefresh) {
      skippedSealedTags++;
      logger.trace(`Skipping sealed release ${tag} (cache)`);
      continue;
    }

    let releaseId: number | null = null;
    if (cached !== undefined && !forceRefresh) {
      releaseId = cached.releaseId;
    } else {
      releaseId = await getReleaseIdByTag(client, owner, repo, tag);
      if (releaseId === null) {
        continue;
      }
      if (cached === undefined || cached.releaseId !== releaseId) {
        tagAssetCountCache.set(tag, {
          releaseId,
          assetCount: cached?.assetCount ?? 0,
          sealed: cached?.sealed ?? false,
        });
      }
    }

    if (releaseId === null) continue;
    scannedTags++;
    const deletedBeforeTag = deletedCount;

    let assetPage = 1;
    let scannedTotal = 0;
    let deletedInTagDryRun = 0;
    while (true) {
      const assetsResponse = await client.rest.repos.listReleaseAssets({
        owner,
        repo,
        release_id: releaseId,
        per_page: 100,
        page: assetPage,
      });

      const assets = assetsResponse.data;
      if (assets.length === 0) {
        break;
      }
      scannedTotal += assets.length;

      for (const asset of assets) {
        const match = asset.name.match(/^chunk-([a-f0-9\-]+)\.bin$/i);
        if (match !== null) {
          const uuid = match[1];
          if (uuid !== undefined && !validChunkUuids.has(uuid)) {
            if (dryRun) {
              logger.info(
                `[dry-run] Would delete incomplete chunk asset "${asset.name}" (ID: ${asset.id}) from release ${tag}...`,
              );
              deletedCount++;
              deletedInTagDryRun++;
            } else {
              deleteQueue.add(async () => {
                try {
                  logger.info(
                    `Deleting incomplete chunk asset "${asset.name}" (ID: ${asset.id}) from release ${tag}...`,
                  );
                  await client.rest.repos.deleteReleaseAsset({
                    owner,
                    repo,
                    asset_id: asset.id,
                  });
                  deletedCount++;
                } catch (e: any) {
                  logger.error(`Failed to delete asset "${asset.name}" (ID: ${asset.id}): ${e.message || e}`);
                }
              });
            }
          }
        }
      }

      if (assets.length < 100) {
        break;
      }
      assetPage++;
    }

    if (!dryRun) {
      await deleteQueue.onIdle();
    }

    const deletedInTag = dryRun ? deletedInTagDryRun : deletedCount - deletedBeforeTag;
    const entry = tagAssetCountCache.get(tag);
    if (entry !== undefined && entry.releaseId === releaseId) {
      const remaining = scannedTotal - deletedInTag;
      entry.assetCount = dryRun ? scannedTotal : remaining;
      if (remaining >= MAX_ASSETS_PER_RELEASE) {
        entry.sealed = true;
      } else if (forceRefresh) {
        entry.sealed = false;
      }
    } else {
      tagAssetCountCache.set(tag, {
        releaseId,
        assetCount: scannedTotal,
        sealed: scannedTotal >= MAX_ASSETS_PER_RELEASE,
      });
    }
  }

  await deleteQueue.onIdle();
  flushTagCache(outputDbDir);

  return { scannedTags, skippedSealedTags, deletedCount };
}

async function cleanupPendingAssets(
  client: Octokit,
  owner: string,
  repo: string,
  validChunkUuids: Set<string>,
  opts?: CleanupOptions,
): Promise<CleanupResult> {
  logger.info('Starting cleanup of pending/incomplete chunk assets on GitHub...');
  const tags = await listRelTagNames(client, owner, repo);
  const result = await scanTagsForOrphans(client, owner, repo, validChunkUuids, tags, opts);
  logger.info(
    `Cleanup finished. Scanned ${result.scannedTags} tag(s), skipped ${result.skippedSealedTags} sealed tag(s). Deleted ${result.deletedCount} incomplete chunk assets.`,
  );
  return result;
}

async function cleanupRecentAssets(
  client: Octokit,
  owner: string,
  repo: string,
  validChunkUuids: Set<string>,
  outputDbDir: string | undefined,
  recentCount: number,
  opts?: Omit<CleanupOptions, 'outputDbDir'>,
): Promise<CleanupResult> {
  const count = Math.max(1, Math.floor(recentCount));
  logger.info(`Starting recent cleanup (last ${count} tag(s)) of pending/incomplete chunk assets...`);
  const allTags = await listRelTagNames(client, owner, repo);
  const tags = allTags.slice(-count);
  if (tags.length === 0) {
    logger.info('No rel tags found, skipping cleanup.');
    return { scannedTags: 0, skippedSealedTags: 0, deletedCount: 0 };
  }
  const result = await scanTagsForOrphans(client, owner, repo, validChunkUuids, tags, {
    ...opts,
    outputDbDir,
    includeSealed: false,
  });
  logger.info(
    `Recent cleanup finished. Scanned ${result.scannedTags} tag(s), skipped ${result.skippedSealedTags} sealed tag(s). Deleted ${result.deletedCount} incomplete chunk assets.`,
  );
  return result;
}

export default {
  getOrCreateUploadTag,
  uploadChunkFile,
  saveMetadata,
  cleanupPendingAssets,
  cleanupRecentAssets,
  listRelTagNames,
};
