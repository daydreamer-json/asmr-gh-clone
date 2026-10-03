import fs from 'node:fs';
import path from 'node:path';
import PQueue from 'p-queue';
import type { DbWork } from '../types/db.js';
import api from '../utils/api';
import argvUtils from '../utils/argv.js';
import config from '../utils/config.js';
import { readDbFile, writeDbFile } from '../utils/db.js';
import logger from '../utils/logger';
import stringUtils from '../utils/string';

export function isMissingDlsiteInfo(info: unknown): boolean {
  if (info === null || info === undefined) return true;
  if (Array.isArray(info)) return true;
  if (typeof info === 'object') return Object.keys(info).length === 0;
  return true;
}

export function resolveDlsiteProductId(work: DbWork): string {
  return work.workInfo.source_id || stringUtils.rjIdNumToStr(work.id);
}

export default async () => {
  const argv = argvUtils.getArgv();
  const outputDbDir: string = argv['output-db-dir'];
  const dryRun: boolean = argv['dry-run'];

  const dbFilePath = path.join(outputDbDir, 'works.msgpack.zst');
  if (!fs.existsSync(dbFilePath)) {
    throw new Error(`DB file not found: ${dbFilePath}`);
  }
  const works = readDbFile<DbWork>(dbFilePath);

  const targets = works.filter((w) => isMissingDlsiteInfo(w.dlsiteInfo));
  const nullCount = targets.filter((w) => w.dlsiteInfo === null).length;
  logger.info(
    `Total works in DB: ${works.length}, entries with missing dlsiteInfo: ${targets.length} (null: ${nullCount}, []/{}: ${targets.length - nullCount})`,
  );

  if (targets.length === 0) {
    logger.info('Nothing to fix');
    return;
  }

  const dsClient = new api.DlsiteClient();
  const queue = new PQueue({
    concurrency: config.threadCount.networkMetadata,
    ...(config.rateLimit.metadata.interval > 0
      ? {
          interval: config.rateLimit.metadata.interval,
          intervalCap: config.rateLimit.metadata.intervalCap,
        }
      : {}),
  });

  let fixedCount = 0;
  let nullifiedCount = 0;
  const failedIds: number[] = [];

  const tasks = targets.map((work) =>
    queue.add(async () => {
      try {
        const rsp = await dsClient.work.info(resolveDlsiteProductId(work));
        if (rsp === null || typeof rsp !== 'object' || Array.isArray(rsp) || Object.keys(rsp).length === 0) {
          throw new Error('Empty DLsite response');
        }
        work.dlsiteInfo = rsp as Record<string, unknown>;
        fixedCount++;
        logger.trace(`Fetched dlsiteInfo for ${work.id}`);
      } catch (error) {
        work.dlsiteInfo = null;
        nullifiedCount++;
        failedIds.push(work.id);
        logger.warn(
          `Failed to fetch DLsite metadata for ${work.id}, set to null. It might have been deleted or API down. Error: ${error}`,
        );
      }
    }),
  );

  await Promise.all(tasks);

  logger.info(
    `Result: fixed ${fixedCount}, set to null ${nullifiedCount}` +
      (failedIds.length > 0 ? `, failed ids: [${failedIds.join(', ')}]` : ''),
  );

  if (dryRun) {
    logger.info('Dry run, DB not updated');
    return;
  }

  writeDbFile(dbFilePath, works);
  logger.info(`Updated DB written to ${dbFilePath}`);
};
