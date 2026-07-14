import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import PQueue from 'p-queue';
import type { DbChunk, DbFile, DbWork } from '../types/db.js';
import configAuth from './configAuth.js';
import { readDbFile, writeDbFile } from './db.js';
import githubUtils from './github.js';
import logger from './logger.js';

const dbUploadQueue = new PQueue({ concurrency: 1 });

interface TagCacheEntry {
  releaseId: number;
  assetCount: number;
}

const tagAssetCountCache = new Map<string, TagCacheEntry>();

function incrementTagCache(tag: string): void {
  const entry = tagAssetCountCache.get(tag);
  if (entry !== undefined) {
    entry.assetCount++;
  }
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

async function getOrCreateUploadTag(client: Octokit, owner: string, repo: string): Promise<string> {
  let index = 0;
  while (true) {
    const tag = `rel${String(index).padStart(5, '0')}`;
    let release: any = null;

    try {
      release = await githubUtils.getReleaseInfo(client, owner, repo, tag);
    } catch (e) {
      // Release not found or other API error
    }

    if (release === null || release === undefined) {
      logger.info(`GitHub Release with tag ${tag} not found. Creating new release...`);
      await githubUtils.createNewRelease(client, owner, repo, tag, 'Untitled', 'nothing to explain', true);
      return tag;
    }

    const cached = tagAssetCountCache.get(tag);
    let assetCount: number;

    if (cached !== undefined && cached.releaseId === release.id) {
      assetCount = cached.assetCount;
      logger.trace(`GitHub Release ${tag} current assets count (cached): ${assetCount}`);

      if (assetCount >= 996 && assetCount < 1000) {
        assetCount = await countReleaseAssets(client, owner, repo, release.id);
        tagAssetCountCache.set(tag, { releaseId: release.id, assetCount });
        logger.trace(`GitHub Release ${tag} current assets count (re-fetched): ${assetCount}`);
      }
    } else {
      assetCount = await countReleaseAssets(client, owner, repo, release.id);
      tagAssetCountCache.set(tag, { releaseId: release.id, assetCount });
      logger.trace(`GitHub Release ${tag} current assets count: ${assetCount}`);
    }

    if (assetCount < 1000) {
      return tag;
    }

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
): Promise<string> {
  const assetName = `chunk-${chunkUuid}.bin`;
  const url = await githubUtils.uploadAsset(client, owner, repo, tag, assetName, filePath);
  incrementTagCache(tag);
  return url;
}

async function saveMetadata(outputDbDir: string, works: DbWork[], files: DbFile[], chunks: DbChunk[]): Promise<void> {
  if (!fs.existsSync(outputDbDir)) {
    fs.mkdirSync(outputDbDir, { recursive: true });
  }

  const worksPath = path.join(outputDbDir, 'works.msgpack.zst');
  const filesPath = path.join(outputDbDir, 'files.msgpack.zst');
  const chunksPath = path.join(outputDbDir, 'chunks.msgpack.zst');

  const updatedFiles: { name: string; path: string }[] = [];

  if (works.length > 0) {
    logger.trace(`Appending ${works.length} entries to ${worksPath}`);
    const currentWorks = readDbFile<DbWork>(worksPath);
    currentWorks.push(...works);
    writeDbFile(worksPath, currentWorks);
    updatedFiles.push({ name: 'works.msgpack.zst', path: worksPath });
  }

  if (files.length > 0) {
    logger.trace(`Appending ${files.length} entries to ${filesPath}`);
    const currentFiles = readDbFile<DbFile>(filesPath);
    currentFiles.push(...files);
    writeDbFile(filesPath, currentFiles);
    updatedFiles.push({ name: 'files.msgpack.zst', path: filesPath });
  }

  if (chunks.length > 0) {
    logger.trace(`Appending ${chunks.length} entries to ${chunksPath}`);
    const currentChunks = readDbFile<DbChunk>(chunksPath);
    currentChunks.push(...chunks);
    writeDbFile(chunksPath, currentChunks);
    updatedFiles.push({ name: 'chunks.msgpack.zst', path: chunksPath });
  }

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
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      }
    });
  }
}

async function cleanupPendingAssets(
  client: Octokit,
  owner: string,
  repo: string,
  validChunkUuids: Set<string>,
): Promise<void> {
  logger.info('Starting cleanup of pending/incomplete chunk assets on GitHub...');

  const releases: any[] = [];
  let page = 1;
  while (true) {
    const response = await client.rest.repos.listReleases({
      owner,
      repo,
      per_page: 100,
      page,
    });
    releases.push(...response.data);
    if (response.data.length < 100) {
      break;
    }
    page++;
  }

  const relReleases = releases.filter((r) => r.tag_name && r.tag_name.startsWith('rel'));
  const deleteQueue = new PQueue({ concurrency: 5 });
  let deletedCount = 0;

  for (const release of relReleases) {
    let assetPage = 1;
    while (true) {
      const assetsResponse = await client.rest.repos.listReleaseAssets({
        owner,
        repo,
        release_id: release.id,
        per_page: 100,
        page: assetPage,
      });

      const assets = assetsResponse.data;
      if (assets.length === 0) {
        break;
      }

      for (const asset of assets) {
        const match = asset.name.match(/^chunk-([a-f0-9\-]+)\.bin$/i);
        if (match !== null) {
          const uuid = match[1];
          if (uuid !== undefined && !validChunkUuids.has(uuid)) {
            deleteQueue.add(async () => {
              try {
                logger.info(
                  `Deleting incomplete chunk asset "${asset.name}" (ID: ${asset.id}) from release ${release.tag_name}...`,
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

      if (assets.length < 100) {
        break;
      }
      assetPage++;
    }
  }

  await deleteQueue.onIdle();
  logger.info(`Cleanup finished. Deleted ${deletedCount} incomplete chunk assets.`);
}

export default {
  getOrCreateUploadTag,
  uploadChunkFile,
  saveMetadata,
  cleanupPendingAssets,
};
