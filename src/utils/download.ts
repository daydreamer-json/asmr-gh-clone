import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import checkDiskSpace from 'check-disk-space';
import ky from 'ky';
import ora from 'ora';
import PQueue from 'p-queue';
import * as uuid from 'uuid';
import type { RspWorkInfoSanitized } from '../types/api/audioProvider.js';
import type { FilesystemEntryTransformed } from '../types/api/audioProviderFiles.js';
import type { DbFile, DbFileChunk, DbWork } from '../types/db.js';
import argvUtils from './argv.js';
import appConfig from './config.js';
import { readDbFile } from './db.js';
import logger from './logger.js';
import math from './math.js';
import rateMeterModule from './rateMeter.js';
import uploadUtils from './upload.js';

const { RateMeter } = rateMeterModule;

export interface ProgressReporter {
  text: string;
  succeed(text?: string): any;
  fail(text?: string): any;
}

class LogProgressReporter implements ProgressReporter {
  private _text: string = '';
  private lastLogTime: number = 0;
  private readonly logIntervalMs: number = 2000;

  constructor(initialText: string) {
    this._text = initialText;
    this.log(initialText);
  }

  get text(): string {
    return this._text;
  }

  set text(value: string) {
    this._text = value;
    const now = Date.now();
    if (now - this.lastLogTime >= this.logIntervalMs) {
      this.log(value);
    }
  }

  private log(message: string) {
    logger.info(message);
    this.lastLogTime = Date.now();
  }

  succeed(text?: string): any {
    if (text !== undefined) {
      this._text = text;
    }
    logger.info(`[SUCCESS] ${this._text}`);
    return this;
  }

  fail(text?: string): any {
    if (text !== undefined) {
      this._text = text;
    }
    logger.error(`[FAIL] ${this._text}`);
    return this;
  }
}

function createProgressReporter(initialText: string): ProgressReporter {
  const argv = argvUtils.getArgv();
  const noSpinner = argv['spinner'] === false;

  if (noSpinner) {
    return new LogProgressReporter(initialText);
  } else {
    return ora({ text: initialText, spinner: 'material' }).start();
  }
}

export interface DownloadResult {
  uuid: string;
  hash: string;
  size: number;
  filePath: string;
}

interface FileTask {
  workId: number;
  file: FilesystemEntryTransformed;
  destPath: string;
  downloadPromise?: Promise<DownloadResult>;
}

interface ChunkInfo {
  uuid: string;
  filePath: string;
  writeStream: fs.WriteStream;
  bytesWritten: number;
}

interface FileStatus {
  uuid: string;
  hash: string;
  path: string[];
  chunks: DbFileChunk[];
  associatedWorkId: number;
  isNew: boolean;
}

export interface WorkMetadata {
  id: number;
  workInfo: RspWorkInfoSanitized;
  dlsiteInfo: Record<string, unknown> | null;
  coverImage: { main: boolean; thumb: boolean; icon: boolean };
  files: FilesystemEntryTransformed[];
}

interface WorkStatus {
  id: number;
  metadata: WorkMetadata;
  pendingFiles: Set<string>;
}

const FORMAT_SIZE_OPTS = {
  decimals: 2,
  decimalPadding: true,
  useBinaryUnit: true,
  useBitUnit: false,
  unitVisible: true,
  unit: null,
};

export async function downloadFiles(files: FilesystemEntryTransformed[]): Promise<DownloadResult[]> {
  const argv = argvUtils.getArgv();
  const outputDir: string = argv['output-dir'];

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const totalSize = math.arrayTotal(files.map((e) => e.size));
  const diskSpace = await checkDiskSpace(outputDir);
  if (diskSpace.free < totalSize) {
    throw new Error(`Insufficient disk space on ${outputDir}. Req: ${totalSize} bytes, Free: ${diskSpace.free} bytes`);
  }

  const queue = new PQueue({ concurrency: appConfig.threadCount.networkDownload });
  const spinner = createProgressReporter('Starting download...');

  let completedCount = 0;
  let downloadedBytes = 0;
  const totalCount = files.length;
  const downloadMeter = new RateMeter(1000, true);

  const updateProgress = () => {
    const percent = totalSize > 0 ? ((downloadedBytes / totalSize) * 100).toFixed(1) : '0.0';
    const downloadedStr = math.formatFileSize(downloadedBytes, { ...FORMAT_SIZE_OPTS, unit: 'M' });
    const totalStr = math.formatFileSize(totalSize, { ...FORMAT_SIZE_OPTS, unit: 'M' });

    const speedBytesPerSec = downloadMeter.getRate();
    const speedStr = `${math.formatFileSize(speedBytesPerSec, { ...FORMAT_SIZE_OPTS, unit: 'M' })}/s`;

    spinner.text = `Downloading: ${completedCount}/${totalCount} files (${percent}%) - ${downloadedStr} / ${totalStr} - ${speedStr}`;
  };

  updateProgress();

  const results: DownloadResult[] = new Array(files.length);

  const downloadTasks = files.map((file, index) => {
    return queue.add(async () => {
      const destPath = path.join(outputDir, `${file.uuid}.bin`);

      const response = await ky.get(file.mediaDownloadUrl, {
        headers: {
          'User-Agent': appConfig.network.userAgent.chromeWindows,
          Referer: appConfig.network.api.audioProvider.referer,
        },
        timeout: appConfig.network.timeout,
        retry: { limit: appConfig.network.retryCount },
      });

      if (!response.body) {
        throw new Error(`Failed to get response body for file: ${file.uuid}`);
      }

      const reader = response.body.getReader();
      const writer = fs.createWriteStream(destPath);
      const hash = crypto.createHash('sha256');

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          hash.update(value);
          writer.write(value);
          downloadedBytes += value.length;
          downloadMeter.increment(value.length);
          updateProgress();
        }
      } finally {
        writer.end();
        await new Promise<void>((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      }

      const sha256Hex = hash.digest('hex');
      completedCount += 1;
      updateProgress();

      results[index] = {
        uuid: file.uuid,
        hash: sha256Hex,
        size: file.size,
        filePath: destPath,
      };
    });
  });

  try {
    await Promise.all(downloadTasks);
    spinner.succeed(`Successfully downloaded ${totalCount} files.`);
  } catch (error) {
    spinner.fail('Download failed.');
    throw error;
  }

  return results;
}

export async function getRegisteredWorkIds(outputDbDir: string): Promise<Set<number>> {
  const registeredIds = new Set<number>();
  const worksPath = path.join(outputDbDir, 'works.msgpack.zst');
  if (!fs.existsSync(worksPath)) {
    return registeredIds;
  }

  const works = readDbFile<DbWork>(worksPath);
  for (const work of works) {
    if (work && typeof work.id === 'number') {
      registeredIds.add(work.id);
    }
  }

  return registeredIds;
}

export async function getRegisteredFiles(outputDbDir: string): Promise<Map<string, DbFile>> {
  const registeredFiles = new Map<string, DbFile>();
  const filesPath = path.join(outputDbDir, 'files.msgpack.zst');
  if (!fs.existsSync(filesPath)) return registeredFiles;

  const files = readDbFile<DbFile>(filesPath);
  for (const file of files) {
    if (file && typeof file.hash === 'string') {
      registeredFiles.set(file.hash, file);
    }
  }
  return registeredFiles;
}

export async function processWorks(
  octoClient: Octokit,
  owner: string,
  repo: string,
  metadataArray: WorkMetadata[],
  outputDir: string,
  outputDbDir: string,
): Promise<void> {
  const CHUNK_SIZE_LIMIT = 2 * 1024 * 1024 * 1024 - 1024 * 1024; // 1.999 GiB

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Track active works and files for sequential committing
  const activeWorks = new Map<number, WorkStatus>();
  const activeFiles = new Map<string, FileStatus>();
  const uploadedChunks = new Set<string>();

  // Create a flat list of all file download tasks, and initialize work status trackers
  const tasks: FileTask[] = [];
  const registeredFiles = await getRegisteredFiles(outputDbDir);

  // Collect all valid chunk UUIDs from the registered files
  const validChunkUuids = new Set<string>();
  for (const file of registeredFiles.values()) {
    if (file.chunks) {
      for (const chunk of file.chunks) {
        if (chunk.uuid) {
          validChunkUuids.add(chunk.uuid);
        }
      }
    }
  }

  // Cleanup pending/incomplete chunk assets on GitHub before doing any download
  await uploadUtils.cleanupPendingAssets(octoClient, owner, repo, validChunkUuids);

  for (const item of metadataArray) {
    const pendingFileUuids = new Set<string>();
    for (const file of item.files) {
      const existingFile = registeredFiles.get(file.hash);
      if (existingFile) {
        logger.trace(`File ${file.hash} already exists in database. Skipping download.`);
        // Mark existing chunks as "uploaded" for this session
        for (const chk of existingFile.chunks) {
          uploadedChunks.add(chk.uuid);
        }
        activeFiles.set(file.uuid, {
          uuid: file.uuid,
          hash: file.hash,
          path: file.path,
          chunks: existingFile.chunks,
          associatedWorkId: item.id,
          isNew: false,
        });
      } else {
        tasks.push({
          workId: item.id,
          file,
          destPath: path.join(outputDir, `${file.uuid}.bin`),
        });
      }
      pendingFileUuids.add(file.uuid);
    }
    activeWorks.set(item.id, {
      id: item.id,
      metadata: item,
      pendingFiles: pendingFileUuids,
    });
  }

  const queue = new PQueue({ concurrency: appConfig.threadCount.networkDownload });
  const uploadQueue = new PQueue({ concurrency: appConfig.threadCount.networkUpload });
  const metaQueue = new PQueue({ concurrency: 1 });
  const uploadErrors: Error[] = [];
  let uploadCompletedCount = 0;
  let uploadTotalCount = 0;

  const spinner = createProgressReporter('Starting processing...');

  let completedCount = 0;
  let downloadedBytes = 0;
  const totalCount = tasks.length;
  const totalSize = math.arrayTotal(tasks.map((t) => t.file.size));
  const downloadMeter = new RateMeter(1000, true);

  const updateProgress = () => {
    const percent = totalSize > 0 ? ((downloadedBytes / totalSize) * 100).toFixed(1) : '0.0';
    const downloadedStr = math.formatFileSize(downloadedBytes, FORMAT_SIZE_OPTS);
    const totalStr = math.formatFileSize(totalSize, FORMAT_SIZE_OPTS);
    const speedBytesPerSec = downloadMeter.getRate();
    const speedStr = `${math.formatFileSize(speedBytesPerSec, FORMAT_SIZE_OPTS)}/s`;

    const activeUploads = uploadQueue.pending;
    const queuedUploads = uploadQueue.size;

    spinner.text = `DL: ${completedCount}/${totalCount} files (${percent}%) - ${downloadedStr} / ${totalStr} - ${speedStr} │ UP: ${activeUploads} active, ${queuedUploads} queued (${uploadCompletedCount}/${uploadTotalCount} chunks done)`;
  };

  updateProgress();

  const downloadSingleFile = async (
    file: FilesystemEntryTransformed,
    destPath: string,
    onProgress: (bytes: number) => void,
  ): Promise<DownloadResult> => {
    const response = await ky.get(file.mediaDownloadUrl, {
      headers: {
        'User-Agent': appConfig.network.userAgent.chromeWindows,
        Referer: appConfig.network.api.audioProvider.referer,
      },
      timeout: appConfig.network.timeout,
      retry: { limit: appConfig.network.retryCount },
    });

    if (!response.body) {
      throw new Error(`Failed to get response body for file: ${file.uuid}`);
    }

    const reader = response.body.getReader();
    const writer = fs.createWriteStream(destPath);
    const hash = crypto.createHash('sha256');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        writer.write(value);
        onProgress(value.length);
        downloadMeter.increment(value.length);
      }
    } finally {
      writer.end();
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    }

    const sha256Hex = hash.digest('hex');
    return {
      uuid: file.uuid,
      hash: sha256Hex,
      size: file.size,
      filePath: destPath,
    };
  };

  const WINDOW_SIZE = Math.max(Math.floor(appConfig.threadCount.networkDownload * 1.5), 8);
  const startDownloadTask = (index: number) => {
    if (index >= tasks.length) return;
    const task = tasks[index];
    if (!task || task.downloadPromise !== undefined) return;

    task.downloadPromise = queue.add(async () => {
      const res = await downloadSingleFile(task.file, task.destPath, (bytes) => {
        downloadedBytes += bytes;
        updateProgress();
      });
      completedCount += 1;
      updateProgress();
      return res;
    });
  };

  // Start downloading the initial window of files
  for (let i = 0; i < Math.min(WINDOW_SIZE, tasks.length); i++) {
    startDownloadTask(i);
  }

  const chunksUploaded: { uuid: string; url: string }[] = [];
  let currentChunk: ChunkInfo | null = null;
  let previousWorkId: number | null = null;

  // sequential lock for getOrCreateUploadTag to prevent API race conditions
  let tagLockPromise: Promise<string> = Promise.resolve('');
  const getOrCreateUploadTagLocked = async (): Promise<string> => {
    const currentLock = tagLockPromise;
    let resolveLock!: (tag: string) => void;
    tagLockPromise = new Promise((resolve) => {
      resolveLock = resolve;
    });
    try {
      await currentLock;
    } catch (e) {
      // ignore errors from previous tag resolution to not block future ones
    }
    try {
      const tag = await uploadUtils.getOrCreateUploadTag(octoClient, owner, repo);
      resolveLock(tag);
      return tag;
    } catch (error) {
      resolveLock('');
      throw error;
    }
  };

  const startNewChunk = (): ChunkInfo => {
    const chunkUuid = uuid.v4();
    const filePath = path.join(outputDir, `chunk-${chunkUuid}.bin`);
    const writeStream = fs.createWriteStream(filePath);
    return {
      uuid: chunkUuid,
      filePath,
      writeStream,
      bytesWritten: 0,
    };
  };

  const checkAndCommitCompletedWorks = async () => {
    const completedWorks: DbWork[] = [];
    const completedFiles: DbFile[] = [];

    for (const [workId, work] of activeWorks.entries()) {
      let workCompleted = true;
      const completedFilesForThisWork: FileStatus[] = [];

      for (const fileUuid of work.pendingFiles) {
        const file = activeFiles.get(fileUuid);
        if (file === undefined) {
          workCompleted = false;
          break;
        }

        const allChunksUploaded = file.chunks.every((chk) => uploadedChunks.has(chk.uuid));
        if (allChunksUploaded) {
          completedFilesForThisWork.push(file);
        } else {
          workCompleted = false;
          break;
        }
      }

      if (workCompleted && completedFilesForThisWork.length === work.pendingFiles.size) {
        logger.info(`Work ${work.id} is fully uploaded. Committing to database...`);
        completedWorks.push({
          id: work.id,
          workInfo: work.metadata.workInfo,
          dlsiteInfo: work.metadata.dlsiteInfo,
          coverImage: work.metadata.coverImage,
          files: completedFilesForThisWork.map((f) => ({
            path: f.path,
            hash: f.hash,
            chunks: f.chunks,
          })),
        });

        for (const f of completedFilesForThisWork) {
          if (f.isNew) {
            completedFiles.push({
              hash: f.hash,
              chunks: f.chunks,
            });
          }
          activeFiles.delete(f.uuid);
        }

        activeWorks.delete(workId);
      }
    }

    if (completedWorks.length > 0 || completedFiles.length > 0) {
      await uploadUtils.saveMetadata(outputDbDir, completedWorks, completedFiles, []);
    }
  };

  const closeChunk = async (chunk: ChunkInfo): Promise<void> => {
    chunk.writeStream.end();
    await new Promise<void>((resolve, reject) => {
      chunk.writeStream.on('finish', resolve);
      chunk.writeStream.on('error', reject);
    });
  };

  const pushUploadTask = (chunk: ChunkInfo): void => {
    uploadTotalCount++;
    updateProgress();

    uploadQueue.add(async () => {
      try {
        const tag = await getOrCreateUploadTagLocked();

        // spinner.text = `Uploading chunk ${chunk.uuid} to release ${tag}...`;
        const url = await uploadUtils.uploadChunkFile(octoClient, owner, repo, tag, chunk.uuid, chunk.filePath);
        chunksUploaded.push({ uuid: chunk.uuid, url });

        // serialize metadata updates and work commits in metaQueue
        await metaQueue.add(async () => {
          await uploadUtils.saveMetadata(outputDbDir, [], [], [{ uuid: chunk.uuid, url }]);

          try {
            if (fs.existsSync(chunk.filePath)) {
              fs.unlinkSync(chunk.filePath);
            }
          } catch (e) {
            logger.warn(`Failed to delete local chunk file ${chunk.filePath}: ${e}`);
          }

          uploadedChunks.add(chunk.uuid);
          await checkAndCommitCompletedWorks();
        });

        uploadCompletedCount++;
        updateProgress();
      } catch (error: any) {
        logger.error(`Upload failed for chunk ${chunk.uuid}: ${error.message || error}`);
        uploadErrors.push(error instanceof Error ? error : new Error(String(error)));

        try {
          if (fs.existsSync(chunk.filePath)) {
            fs.unlinkSync(chunk.filePath);
          }
        } catch {}

        updateProgress();
      }
    });
  };

  try {
    // Initial check for works that might already be complete due to skipped files
    await checkAndCommitCompletedWorks();

    for (let i = 0; i < tasks.length; i++) {
      // Start downloading the next file in the sliding window
      startDownloadTask(i + WINDOW_SIZE);

      const task = tasks[i];
      if (!task || task.downloadPromise === undefined) {
        throw new Error(`Download promise for task ${i} is undefined.`);
      }
      const downloadResult = await task.downloadPromise;

      // Fail early if any parallel upload failed
      if (uploadErrors.length > 0) {
        throw uploadErrors[0];
      }

      // Disk Backpressure: Wait if upload queue has too many pending items
      const maxUploadQueueSize = appConfig.threadCount.networkUpload * 2;
      while (uploadQueue.size + uploadQueue.pending >= maxUploadQueueSize) {
        if (uploadErrors.length > 0) {
          throw uploadErrors[0];
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Close current chunk and upload it if the work changes to avoid mixing works in a single chunk
      if (previousWorkId !== null && previousWorkId !== task.workId) {
        if (currentChunk !== null) {
          logger.info(`Work ID changed from ${previousWorkId} to ${task.workId}. Closing current chunk.`);
          await closeChunk(currentChunk);
          pushUploadTask(currentChunk);
          currentChunk = null;
        }
      }
      previousWorkId = task.workId;

      const fileAssignmentsForThis: { uuid: string; offset: number; size: number }[] = [];
      const fileReadStream = fs.createReadStream(downloadResult.filePath);

      for await (const chunk of fileReadStream) {
        let chunkOffset = 0;
        while (chunkOffset < chunk.length) {
          if (currentChunk === null) {
            currentChunk = startNewChunk();
          }

          const spaceLeft = CHUNK_SIZE_LIMIT - currentChunk.bytesWritten;
          const bytesToWrite = Math.min(chunk.length - chunkOffset, spaceLeft);

          const dataToWrite = chunk.subarray(chunkOffset, chunkOffset + bytesToWrite);

          const canWrite = currentChunk.writeStream.write(dataToWrite);
          if (!canWrite) {
            await new Promise<void>((resolve) => currentChunk!.writeStream.once('drain', resolve));
          }

          const chunkOffsetInFile = currentChunk.bytesWritten;

          const lastAssignment = fileAssignmentsForThis[fileAssignmentsForThis.length - 1];
          if (lastAssignment !== undefined && lastAssignment.uuid === currentChunk.uuid) {
            lastAssignment.size += bytesToWrite;
          } else {
            fileAssignmentsForThis.push({
              uuid: currentChunk.uuid,
              offset: chunkOffsetInFile,
              size: bytesToWrite,
            });
          }

          currentChunk.bytesWritten += bytesToWrite;
          chunkOffset += bytesToWrite;

          if (currentChunk.bytesWritten >= CHUNK_SIZE_LIMIT) {
            await closeChunk(currentChunk);
            pushUploadTask(currentChunk);
            currentChunk = null;
          }
        }
      }

      // Delete the downloaded file immediately once it is chunked
      fs.unlinkSync(downloadResult.filePath);

      // Register the file's chunk assignments
      activeFiles.set(downloadResult.uuid, {
        uuid: downloadResult.uuid,
        hash: downloadResult.hash,
        path: task.file.path,
        chunks: fileAssignmentsForThis,
        associatedWorkId: task.workId,
        isNew: true,
      });
    }

    // Flush any remaining chunk
    if (currentChunk !== null) {
      await closeChunk(currentChunk);
      pushUploadTask(currentChunk);
      currentChunk = null;
    }

    // Wait for all uploads to complete
    while (uploadQueue.size > 0 || uploadQueue.pending > 0) {
      if (uploadErrors.length > 0) {
        throw uploadErrors[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await uploadQueue.onIdle();
    await metaQueue.onIdle();

    if (uploadErrors.length > 0) {
      throw uploadErrors[0];
    }

    spinner.succeed(`Successfully processed and uploaded ${totalCount} files.`);
  } catch (error) {
    spinner.fail('Processing failed.');
    if (currentChunk !== null) {
      currentChunk.writeStream.end();
      try {
        fs.unlinkSync(currentChunk.filePath);
      } catch {}
    }
    for (const task of tasks) {
      try {
        if (fs.existsSync(task.destPath)) {
          fs.unlinkSync(task.destPath);
        }
      } catch {}
    }
    throw error;
  }
}

export default {
  downloadFiles,
  getRegisteredWorkIds,
  getRegisteredFiles,
  processWorks,
};
