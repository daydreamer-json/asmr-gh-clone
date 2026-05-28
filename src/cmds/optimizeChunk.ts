import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { Octokit } from '@octokit/rest';
import ky from 'ky';
import PQueue from 'p-queue';
import * as uuid from 'uuid';
import type { DbChunk, DbFile, DbFileChunk, DbWork } from '../types/db.js';
import argvUtils from '../utils/argv.js';
import appConfig from '../utils/config.js';
import configAuth from '../utils/configAuth.js';
import { readDbFile, writeDbFile } from '../utils/db.js';
import githubUtils from '../utils/github.js';
import logger from '../utils/logger.js';
import math from '../utils/math.js';
import uploadUtils from '../utils/upload.js';

const CHUNK_SIZE_LIMIT = 2 * 1024 * 1024 * 1024 - 1024 * 1024; // 1.999 GiB (2,146,435,072 bytes)
const OPTIMIZE_THRESHOLD = 1.8 * 1024 * 1024 * 1024; // 1.8 GiB
const BATCH_SIZE_LIMIT = 6 * 1024 * 1024 * 1024; // 6 GiB
const FORMAT_SIZE_OPTS = {
  decimals: 2,
  decimalPadding: true,
  useBinaryUnit: true,
  useBitUnit: false,
  unitVisible: true,
  unit: null,
};

async function downloadAssetFromUrl(url: string, destPath: string): Promise<void> {
  const response = await ky.get(url, {
    retry: {
      limit: 3,
    },
    timeout: 60000,
  });

  if (!response.body) {
    throw new Error(`Response body is empty for ${url}`);
  }

  const fileStream = fs.createWriteStream(destPath);
  const nodeReadable = Readable.fromWeb(response.body as any);

  nodeReadable.pipe(fileStream);

  await finished(fileStream);
}

async function uploadDbFile(
  client: Octokit,
  owner: string,
  repo: string,
  fileName: string,
  filePath: string,
): Promise<string> {
  const tag = 'db';
  const release = await githubUtils.getReleaseInfo(client, owner, repo, tag);
  if (release === null || release === undefined) {
    throw new Error(`GitHub release with tag "${tag}" not found.`);
  }

  const existingAsset = release.assets.find((a: any) => a.name === fileName);
  if (existingAsset !== undefined) {
    logger.info(`Deleting existing DB asset "${fileName}" (ID: ${existingAsset.id})...`);
    try {
      await client.rest.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: existingAsset.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e: any) {
      logger.warn(`Failed to delete existing DB asset "${fileName}": ${e.message || e}`);
    }
  }

  logger.info(`Uploading updated DB asset "${fileName}"...`);
  return await githubUtils.uploadAsset(client, owner, repo, tag, fileName, filePath);
}

async function deleteAssets(octokit: Octokit, owner: string, repo: string, assetIds: number[]): Promise<void> {
  const queue = new PQueue({ concurrency: 5 });
  for (const id of assetIds) {
    queue.add(async () => {
      let retries = 3;
      while (retries > 0) {
        try {
          logger.info(`Deleting old asset ID: ${id}...`);
          await octokit.rest.repos.deleteReleaseAsset({
            owner,
            repo,
            asset_id: id,
          });
          break;
        } catch (error: any) {
          retries--;
          logger.error(`Failed to delete asset ${id} (retries left: ${retries}): ${error.message || error}`);
          if (retries === 0) {
            logger.warn(`Skipping deletion of asset ${id} after max retries.`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
    });
  }
  await queue.onIdle();
}

export default async () => {
  const argv = argvUtils.getArgv();
  const outputDbDir: string = argv['output-db-dir'];
  const outputDir: string = argv['output-dir'];
  const dryRun: boolean = argv['dry-run'] === true;

  const worksPath = path.join(outputDbDir, 'works.msgpack.zst');
  const filesPath = path.join(outputDbDir, 'files.msgpack.zst');
  const chunksPath = path.join(outputDbDir, 'chunks.msgpack.zst');

  if (!fs.existsSync(worksPath) || !fs.existsSync(filesPath) || !fs.existsSync(chunksPath)) {
    logger.error('Database files not found. Run syncDb or archive command first.');
    return;
  }

  logger.info('Loading databases...');
  const worksDb = readDbFile<DbWork>(worksPath);
  const filesDb = readDbFile<DbFile>(filesPath);
  const chunksDb = readDbFile<DbChunk>(chunksPath);

  logger.info(`Loaded ${worksDb.length} works, ${filesDb.length} files, ${chunksDb.length} chunks.`);

  // 1. 各チャンクの実装容量を計算 (filesDb から)
  const chunkSizes = new Map<string, number>();
  for (const file of filesDb) {
    for (const chunk of file.chunks) {
      chunkSizes.set(chunk.uuid, (chunkSizes.get(chunk.uuid) || 0) + chunk.size);
    }
  }

  // 2. 最適化対象チャンクの選定
  const targetChunkUuids = new Set<string>();
  const chunksToOptimize: { uuid: string; url: string; size: number }[] = [];

  for (const chunk of chunksDb) {
    const size = chunkSizes.get(chunk.uuid) || 0;
    if (size > 0 && size < OPTIMIZE_THRESHOLD) {
      targetChunkUuids.add(chunk.uuid);
      chunksToOptimize.push({ uuid: chunk.uuid, url: chunk.url, size });
    }
  }

  if (chunksToOptimize.length <= 1) {
    logger.info('No chunk needs optimization (or only 1 chunk found, nothing to merge).');
    return;
  }

  const totalOptimizeSize = chunksToOptimize.reduce((acc, curr) => acc + curr.size, 0);
  const expectedNewChunksCount = Math.ceil(totalOptimizeSize / CHUNK_SIZE_LIMIT);
  const estimatedAssetsReduced = chunksToOptimize.length - expectedNewChunksCount;

  logger.info(
    `Found ${chunksToOptimize.length} chunks to optimize (Total size: ${math.formatFileSize(totalOptimizeSize, FORMAT_SIZE_OPTS)}).`,
  );
  logger.info(
    `Estimated target structure: about ${expectedNewChunksCount} chunks (Reduction of ${estimatedAssetsReduced} assets).`,
  );

  if (dryRun) {
    logger.info('[DRY RUN] Simulating chunk optimization details:');
    for (const chunk of chunksToOptimize) {
      logger.info(`  - chunk-${chunk.uuid}.bin (${math.formatFileSize(chunk.size, FORMAT_SIZE_OPTS)})`);
    }
    logger.info('[DRY RUN] Completed simulation. No changes were made.');
    return;
  }

  // 3. バッチ分け
  const batches: { uuid: string; url: string; size: number }[][] = [];
  let currentBatch: { uuid: string; url: string; size: number }[] = [];
  let currentBatchSize = 0;

  for (const chunk of chunksToOptimize) {
    if (currentBatchSize + chunk.size > BATCH_SIZE_LIMIT && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchSize = 0;
    }
    currentBatch.push(chunk);
    currentBatchSize += chunk.size;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  logger.info(`Splitting optimization process into ${batches.length} batches.`);

  const octokit = new Octokit({ auth: configAuth.github.pat.main });
  const owner = configAuth.github.owner.main;
  const repo = configAuth.github.repo.main;

  const tempDir = path.join(outputDir, `optimize_tmp_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const uploadedNewChunks: DbChunk[] = [];
  const fileNewChunksMap = new Map<string, DbFileChunk[]>(); // hash -> new DbFileChunk[]

  try {
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!;
      logger.info(`[Batch ${batchIdx + 1}/${batches.length}] Starting...`);

      // A. ダウンロード
      const downloadQueue = new PQueue({ concurrency: appConfig.threadCount.networkDownload });
      for (const chunk of batch) {
        const destPath = path.join(tempDir, `chunk-${chunk.uuid}.bin`);
        downloadQueue.add(async () => {
          logger.info(`Downloading chunk-${chunk.uuid}.bin ...`);
          await downloadAssetFromUrl(chunk.url, destPath);
        });
      }
      await downloadQueue.onIdle();
      logger.info(`[Batch ${batchIdx + 1}/${batches.length}] Finished downloading all chunk files.`);

      // B. ファイルデータの一時復元
      const batchChunkUuids = new Set(batch.map((c) => c.uuid));
      const filesInBatch = filesDb.filter((file) => file.chunks.some((chk) => batchChunkUuids.has(chk.uuid)));

      logger.info(`[Batch ${batchIdx + 1}/${batches.length}] Reconstituting ${filesInBatch.length} files...`);

      for (const file of filesInBatch) {
        const tempFilePath = path.join(tempDir, `file_${file.hash}.bin`);
        const destWriteStream = fs.createWriteStream(tempFilePath);

        const segmentsToOptimize = file.chunks.filter((chk) => batchChunkUuids.has(chk.uuid));

        for (const chunkSegment of segmentsToOptimize) {
          const chunkFilePath = path.join(tempDir, `chunk-${chunkSegment.uuid}.bin`);
          const readStream = fs.createReadStream(chunkFilePath, {
            start: chunkSegment.offset,
            end: chunkSegment.offset + chunkSegment.size - 1,
          });

          await new Promise<void>((resolve, reject) => {
            readStream.pipe(destWriteStream, { end: false });
            readStream.on('end', resolve);
            readStream.on('error', reject);
          });
        }
        destWriteStream.end();
        await new Promise<void>((resolve, reject) => {
          destWriteStream.on('finish', resolve);
          destWriteStream.on('error', reject);
        });
      }

      // 復元が終わったので、不要になった古いダウンロードファイルを削除してディスク容量を空ける
      for (const chunk of batch) {
        const filePath = path.join(tempDir, `chunk-${chunk.uuid}.bin`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      // C. 新しいチャンクへのパッキング
      logger.info(`[Batch ${batchIdx + 1}/${batches.length}] Packing into new chunks...`);
      let currentChunk: { uuid: string; filePath: string; writeStream: fs.WriteStream; bytesWritten: number } | null =
        null;
      const batchNewChunksList: { uuid: string; filePath: string }[] = [];

      for (const file of filesInBatch) {
        const tempFilePath = path.join(tempDir, `file_${file.hash}.bin`);
        const fileReadStream = fs.createReadStream(tempFilePath);
        const fileAssignments: DbFileChunk[] = [];

        for await (const chunk of fileReadStream) {
          let chunkOffset = 0;
          while (chunkOffset < chunk.length) {
            if (currentChunk === null) {
              const newUuid = uuid.v4();
              const chunkPath = path.join(tempDir, `new-chunk-${newUuid}.bin`);
              const writeStream = fs.createWriteStream(chunkPath);
              currentChunk = {
                uuid: newUuid,
                filePath: chunkPath,
                writeStream,
                bytesWritten: 0,
              };
            }

            const spaceLeft = CHUNK_SIZE_LIMIT - currentChunk.bytesWritten;
            const bytesToWrite = Math.min(chunk.length - chunkOffset, spaceLeft);
            const dataToWrite = chunk.subarray(chunkOffset, chunkOffset + bytesToWrite);

            const canWrite = currentChunk.writeStream.write(dataToWrite);
            if (!canWrite) {
              await new Promise<void>((resolve) => currentChunk!.writeStream.once('drain', resolve));
            }

            const chunkOffsetInFile = currentChunk.bytesWritten;
            const lastAssignment = fileAssignments[fileAssignments.length - 1];
            if (lastAssignment !== undefined && lastAssignment.uuid === currentChunk.uuid) {
              lastAssignment.size += bytesToWrite;
            } else {
              fileAssignments.push({
                uuid: currentChunk.uuid,
                offset: chunkOffsetInFile,
                size: bytesToWrite,
              });
            }

            currentChunk.bytesWritten += bytesToWrite;
            chunkOffset += bytesToWrite;

            if (currentChunk.bytesWritten >= CHUNK_SIZE_LIMIT) {
              currentChunk.writeStream.end();
              await new Promise<void>((resolve, reject) => {
                currentChunk!.writeStream.on('finish', resolve);
                currentChunk!.writeStream.on('error', reject);
              });
              batchNewChunksList.push({
                uuid: currentChunk.uuid,
                filePath: currentChunk.filePath,
              });
              currentChunk = null;
            }
          }
        }

        // ファイルの一時復元データを削除
        fs.unlinkSync(tempFilePath);
        fileNewChunksMap.set(file.hash, fileAssignments);
      }

      // 最後のチャンクを閉じる
      if (currentChunk !== null) {
        currentChunk.writeStream.end();
        await new Promise<void>((resolve, reject) => {
          currentChunk!.writeStream.on('finish', resolve);
          currentChunk!.writeStream.on('error', reject);
        });
        batchNewChunksList.push({
          uuid: currentChunk.uuid,
          filePath: currentChunk.filePath,
        });
        currentChunk = null;
      }

      // D. アップロード
      logger.info(`[Batch ${batchIdx + 1}/${batches.length}] Uploading ${batchNewChunksList.length} new chunks...`);
      const uploadTag = await uploadUtils.getOrCreateUploadTag(octokit, owner, repo);

      const uploadQueue = new PQueue({ concurrency: appConfig.threadCount.networkUpload });
      for (const newChunk of batchNewChunksList) {
        uploadQueue.add(async () => {
          logger.info(`Uploading new chunk-${newChunk.uuid}.bin ...`);
          const url = await uploadUtils.uploadChunkFile(
            octokit,
            owner,
            repo,
            uploadTag,
            newChunk.uuid,
            newChunk.filePath,
          );
          uploadedNewChunks.push({
            uuid: newChunk.uuid,
            url,
          });

          // アップロード完了後、ローカルの新しいチャンクファイルを削除
          try {
            fs.unlinkSync(newChunk.filePath);
          } catch (e) {
            logger.warn(`Failed to delete local chunk file ${newChunk.filePath}: ${e}`);
          }
        });
      }
      await uploadQueue.onIdle();
      logger.info(`[Batch ${batchIdx + 1}/${batches.length}] Completed batch processing.`);
    }

    // 4. DB の更新 (メモリ上)
    logger.info('Updating database structures in memory...');
    const hashToNewChunks = new Map<string, DbFileChunk[]>();

    for (const file of filesDb) {
      const originalChunks = file.chunks;
      const finalChunks: DbFileChunk[] = [];
      let insertedNew = false;

      for (const chk of originalChunks) {
        if (targetChunkUuids.has(chk.uuid)) {
          if (!insertedNew) {
            const newAss = fileNewChunksMap.get(file.hash) || [];
            finalChunks.push(...newAss);
            insertedNew = true;
          }
        } else {
          finalChunks.push(chk);
        }
      }
      file.chunks = finalChunks;
      hashToNewChunks.set(file.hash, finalChunks);
    }

    for (const work of worksDb) {
      for (const file of work.files) {
        const updatedChunks = hashToNewChunks.get(file.hash);
        if (updatedChunks !== undefined) {
          file.chunks = updatedChunks;
        }
      }
    }

    const updatedChunksDb = chunksDb.filter((chk) => !targetChunkUuids.has(chk.uuid));
    updatedChunksDb.push(...uploadedNewChunks);

    // 5. DB ファイルの保存とアップロード確定
    logger.info('Writing database files to disk...');
    writeDbFile(worksPath, worksDb);
    writeDbFile(filesPath, filesDb);
    writeDbFile(chunksPath, updatedChunksDb);

    logger.info('Uploading updated database files to GitHub...');
    await uploadDbFile(octokit, owner, repo, 'works.msgpack.zst', worksPath);
    await uploadDbFile(octokit, owner, repo, 'files.msgpack.zst', filesPath);
    await uploadDbFile(octokit, owner, repo, 'chunks.msgpack.zst', chunksPath);

    logger.info('Database transaction completed successfully.');

    // 6. 不要になった古いアセットの削除
    logger.info('Deleting old chunk assets from GitHub Releases...');
    const allReleases: any[] = [];
    let page = 1;
    while (true) {
      const response = await octokit.rest.repos.listReleases({
        owner,
        repo,
        per_page: 100,
        page,
      });
      allReleases.push(...response.data);
      if (response.data.length < 100) break;
      page++;
    }

    const relReleases = allReleases.filter(
      (r) => r.tag_name !== undefined && r.tag_name !== null && r.tag_name.startsWith('rel'),
    );
    const oldAssetIds: number[] = [];

    for (const rel of relReleases) {
      let assetPage = 1;
      while (true) {
        const assetsResponse = await octokit.rest.repos.listReleaseAssets({
          owner,
          repo,
          release_id: rel.id,
          per_page: 100,
          page: assetPage,
        });

        const assets = assetsResponse.data;
        if (assets.length === 0) break;

        for (const asset of assets) {
          const match = asset.name.match(/^chunk-([a-f0-9\-]+)\.bin$/i);
          if (match !== null) {
            const uuidVal = match[1];
            if (uuidVal !== undefined && targetChunkUuids.has(uuidVal)) {
              oldAssetIds.push(asset.id);
            }
          }
        }

        if (assets.length < 100) break;
        assetPage++;
      }
    }

    logger.info(`Found ${oldAssetIds.length} old assets to delete.`);
    await deleteAssets(octokit, owner, repo, oldAssetIds);

    logger.info('Chunk optimization finished successfully!');
  } finally {
    // 一時フォルダのクリーンアップ
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        logger.trace('Cleaned up temporary directory.');
      } catch (err) {
        logger.warn(`Failed to remove temporary directory ${tempDir}: ${err}`);
      }
    }
  }
};
