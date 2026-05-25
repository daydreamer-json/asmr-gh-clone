import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import PQueue from 'p-queue';
import configAuth from './configAuth.js';
import githubUtils from './github.js';
import logger from './logger.js';

const dbUploadQueue = new PQueue({ concurrency: 1 });

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

  const existingAsset = release.assets.find((a: any) => a.name === targetFileName);
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

  logger.info(`Uploading DB asset "${targetFileName}" to release "${tag}"...`);
  const response = await githubUtils.uploadAsset(client, owner, repo, tag, targetFileName, filePath);
  return response;
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

    // Count the total assets in this release
    let assetCount = 0;
    let page = 1;
    while (true) {
      const assets = await client.rest.repos.listReleaseAssets({
        owner,
        repo,
        release_id: release.id,
        per_page: 100,
        page,
      });
      assetCount += assets.data.length;
      if (assets.data.length < 100) {
        break;
      }
      page++;
    }

    logger.trace(`GitHub Release ${tag} current assets count: ${assetCount}`);

    if (assetCount < 1000) {
      return tag;
    }

    // If 1000 or more, try the next index
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
  return url;
}

async function saveMetadata(outputDbDir: string, works: any[], files: any[], chunks: any[]): Promise<void> {
  if (!fs.existsSync(outputDbDir)) {
    fs.mkdirSync(outputDbDir, { recursive: true });
  }

  const worksPath = path.join(outputDbDir, 'works.jsonl');
  const filesPath = path.join(outputDbDir, 'files.jsonl');
  const chunksPath = path.join(outputDbDir, 'chunks.jsonl');

  const updatedFiles: { name: string; path: string }[] = [];

  if (works.length > 0) {
    logger.trace(`Appending ${works.length} entries to ${worksPath}`);
    const content = works.map((w) => JSON.stringify(w)).join('\n') + '\n';
    fs.appendFileSync(worksPath, content, 'utf8');
    updatedFiles.push({ name: 'works.jsonl', path: worksPath });
  }

  if (files.length > 0) {
    logger.trace(`Appending ${files.length} entries to ${filesPath}`);
    const content = files.map((f) => JSON.stringify(f)).join('\n') + '\n';
    fs.appendFileSync(filesPath, content, 'utf8');
    updatedFiles.push({ name: 'files.jsonl', path: filesPath });
  }

  if (chunks.length > 0) {
    logger.trace(`Appending ${chunks.length} entries to ${chunksPath}`);
    const content = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
    fs.appendFileSync(chunksPath, content, 'utf8');
    updatedFiles.push({ name: 'chunks.jsonl', path: chunksPath });
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
