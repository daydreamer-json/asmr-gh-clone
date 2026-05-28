import { Octokit } from '@octokit/rest';
import checkDiskSpace from 'check-disk-space';
import PQueue from 'p-queue';
import { rimraf } from 'rimraf';
import api from '../utils/api';
import argvUtils from '../utils/argv.js';
import config from '../utils/config.js';
import configAuth from '../utils/configAuth.js';
import type { WorkMetadata } from '../utils/download.js';
import download from '../utils/download.js';
import logger from '../utils/logger';
import math from '../utils/math';
import stringUtils from '../utils/string';

const FORMAT_SIZE_OPTS = {
  decimals: 2,
  decimalPadding: true,
  useBinaryUnit: true,
  useBitUnit: false,
  unitVisible: true,
  unit: null,
};

export default async () => {
  const argv = argvUtils.getArgv();
  const outputDir: string = argv['output-dir'];
  const outputDbDir: string = argv['output-db-dir'];

  const octoClient = new Octokit({ auth: configAuth.github.pat.main });
  const apClient = await api.AudioProviderClient.createClient('original');
  const dsClient = new api.DlsiteClient();
  const inputFilePath = 'config/input.json';
  let ids: number[] = [];
  if (await Bun.file(inputFilePath).exists()) {
    try {
      const parsed = await Bun.file(inputFilePath).json();
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'number')) {
        ids = parsed as number[];
      } else {
        logger.error('Invalid format in config/input.json. Expected an array of numbers.');
      }
    } catch (error) {
      logger.error(`Failed to read or parse config/input.json: ${error}`);
    }
  } else {
    logger.warn('config/input.json does not exist. Using empty ids.');
  }

  const registeredIds = await download.getRegisteredWorkIds(outputDbDir);
  const idsToProcess = ids.filter((id) => !registeredIds.has(id));

  if (idsToProcess.length === 0) {
    logger.info('All target works are already registered in the DB');
    return;
  }

  const metadataArray: WorkMetadata[] = [];
  logger.debug('Fetching metadata ...');

  const queue = new PQueue({
    concurrency: config.threadCount.networkMetadata,
    ...(config.rateLimit.metadata.interval > 0
      ? {
          interval: config.rateLimit.metadata.interval,
          intervalCap: config.rateLimit.metadata.intervalCap,
        }
      : {}),
  });
  const metadataTasks = idsToProcess.map((id) =>
    queue.add(async () => {
      // logger.trace('Fetching metadata: ' + id);
      const workInfo = await apClient.work.info(id);
      const dlsiteInfo = (await dsClient.work.info(stringUtils.rjIdNumToStr(id))) as Record<string, unknown>;
      const [main, thumb, icon] = await Promise.all([
        apClient.work.media.coverImage(id, 'main'),
        apClient.work.media.coverImage(id, 'thumb'),
        apClient.work.media.coverImage(id, 'icon'),
      ]);
      const coverImage = {
        main: main !== null,
        thumb: thumb !== null,
        icon: icon !== null,
      };
      const apFileEntry = await apClient.work.fileEntry(id);
      const rsp = { id, workInfo, dlsiteInfo, coverImage, files: apFileEntry.transformed };
      logger.trace(
        `Fetched: ${rsp.workInfo.release}, ${rsp.workInfo.create_date}, ${math.formatFileSize(math.arrayTotal(rsp.files.map((e) => e.size)), { ...FORMAT_SIZE_OPTS, unit: 'M' })}, ${id}`,
      );
      return rsp;
    }),
  );

  const fetchedMetadata = await Promise.all(metadataTasks);
  metadataArray.push(...fetchedMetadata.filter((m): m is NonNullable<typeof m> => m !== undefined));

  const maxFileSize = math.arrayMax(metadataArray.flatMap((e) => e.files.map((f) => f.size)));
  const diskUsage = await (async () => {
    const raw = await checkDiskSpace(outputDir);
    return {
      used: raw.size - raw.free,
      usedP: ((raw.size - raw.free) / raw.size) * 100,
      free: raw.free,
      freeP: (raw.free / raw.size) * 100,
      total: raw.size,
    };
  })();

  logger.debug(
    'Disk space: ' +
      math.formatFileSize(diskUsage.used, FORMAT_SIZE_OPTS) +
      ' / ' +
      math.formatFileSize(diskUsage.total, FORMAT_SIZE_OPTS) +
      ` (${math.rounder('ceil', diskUsage.usedP, 2).padded} %) used, ` +
      `${math.formatFileSize(diskUsage.free, FORMAT_SIZE_OPTS)} free`,
  );

  const safetyBuffer = 2 * 1024 * 1024 * 1024 - 1024 * 1024;
  if (diskUsage.free < maxFileSize * config.threadCount.networkDownload + safetyBuffer) {
    throw new Error(
      `Insufficient disk space on ${outputDir}. Req: ${maxFileSize * config.threadCount.networkDownload + safetyBuffer} bytes, Free: ${diskUsage.free} bytes`,
    );
  }

  logger.debug('Starting download and upload process...');
  await rimraf(outputDir);
  await download.processWorks(
    octoClient,
    configAuth.github.owner.main,
    configAuth.github.repo.main,
    metadataArray,
    outputDir,
    outputDbDir,
  );
};
