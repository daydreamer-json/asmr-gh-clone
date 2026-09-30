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
import { loadMetadataCache, saveMetadataCache } from '../utils/metadataCache.js';
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
    await download.shutdownDb();
    return;
  }

  const metadataArray: WorkMetadata[] = [];
  logger.debug('Fetching metadata ...');

  const refreshMetadata: boolean = argv['refresh-metadata'] === true;
  const metadataCacheEntries = loadMetadataCache(outputDbDir);

  const cachedMetadata = new Map<number, WorkMetadata>();
  const idsToFetch: number[] = [];
  let metadataCacheHits = 0;
  let metadataCacheSkipped = 0;
  for (const id of idsToProcess) {
    if (!refreshMetadata) {
      const entry = metadataCacheEntries[String(id)];
      if (entry?.status === 'ok') {
        cachedMetadata.set(id, entry.metadata);
        metadataCacheHits++;
        continue;
      }
      if (entry?.status === 'skipped') {
        metadataCacheSkipped++;
        continue;
      }
    }
    idsToFetch.push(id);
  }
  logger.debug(
    `Metadata cache: ${metadataCacheHits} hit(s), ${metadataCacheSkipped} skipped, ${idsToFetch.length} to fetch ...`,
  );

  const queue = new PQueue({
    concurrency: config.threadCount.networkMetadata,
    ...(config.rateLimit.metadata.interval > 0
      ? {
          interval: config.rateLimit.metadata.interval,
          intervalCap: config.rateLimit.metadata.intervalCap,
        }
      : {}),
  });
  const fetchOneMetadata = async (id: number): Promise<WorkMetadata | undefined> => {
    // logger.trace('Fetching metadata: ' + id);
    const workInfo = await apClient.work.info(id);
    let dlsiteInfo: Record<string, unknown> | null = null;
    try {
      const rsp = await dsClient.work.info(stringUtils.rjIdNumToStr(id));
      if (Array.isArray(rsp) && rsp.length === 0) {
        throw new Error('Response is []');
      } else {
        dlsiteInfo = rsp as Record<string, unknown>;
      }
    } catch (error) {
      logger.warn(`Failed to fetch DLsite metadata for ${id}. It might have been deleted or API down. Error: ${error}`);
    }
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

    let apFileEntry;
    try {
      apFileEntry = await apClient.work.fileEntry(id);
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn(`Skipping work ${id}: fileEntry returned 404.`);
        return undefined;
      }
      throw error;
    }

    const rsp = { id, workInfo, dlsiteInfo, coverImage, files: apFileEntry.transformed };
    logger.trace(
      `Fetched: ${rsp.workInfo.release}, ${rsp.workInfo.create_date}, ${id}, ${math.formatFileSize(math.arrayTotal(rsp.files.map((e) => e.size)), { ...FORMAT_SIZE_OPTS, unit: 'M' })}`,
    );
    return rsp;
  };
  const fetchedById = new Map<number, WorkMetadata>();
  const metadataTasks = idsToFetch.map((id) =>
    queue.add(async () => {
      const result = await fetchOneMetadata(id);
      if (result === undefined) {
        metadataCacheEntries[String(id)] = {
          status: 'skipped',
          reason: 'fileEntry404',
          fetchedAt: new Date().toISOString(),
        };
      } else {
        fetchedById.set(id, result);
        metadataCacheEntries[String(id)] = {
          status: 'ok',
          fetchedAt: new Date().toISOString(),
          metadata: result,
        };
      }
      saveMetadataCache(outputDbDir, metadataCacheEntries);
    }),
  );

  await Promise.all(metadataTasks);

  for (const id of idsToProcess) {
    const metadata = cachedMetadata.get(id) ?? fetchedById.get(id);
    if (metadata !== undefined) {
      metadataArray.push(metadata);
    }
  }

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
