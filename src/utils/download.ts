import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import checkDiskSpace from 'check-disk-space';
import ky from 'ky';
import ora from 'ora';
import PQueue from 'p-queue';
import type { FilesystemEntryTransformed } from '../types/api/audioProviderFiles.js';
import argvUtils from './argv.js';
import appConfig from './config.js';
import math from './math.js';

export interface DownloadResult {
  uuid: string;
  hash: string;
  size: number;
  filePath: string;
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

  // Create directory if not exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Check disk space
  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  const diskSpace = await checkDiskSpace(outputDir);
  if (diskSpace.free < totalSize) {
    throw new Error(
      `Insufficient disk space on ${outputDir}. Required: ${totalSize} bytes, Available: ${diskSpace.free} bytes.`,
    );
  }

  const queue = new PQueue({ concurrency: appConfig.threadCount.network });
  const spinner = ora('Starting download...').start();

  let completedCount = 0;
  let downloadedBytes = 0;
  const totalCount = files.length;

  const updateProgress = () => {
    const percent = totalSize > 0 ? ((downloadedBytes / totalSize) * 100).toFixed(1) : '0.0';
    const downloadedStr = math.formatFileSize(downloadedBytes, FORMAT_SIZE_OPTS);
    const totalStr = math.formatFileSize(totalSize, FORMAT_SIZE_OPTS);
    spinner.text = `Downloading: ${completedCount}/${totalCount} files (${percent}%) - ${downloadedStr} / ${totalStr}`;
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

export default {
  downloadFiles,
};
