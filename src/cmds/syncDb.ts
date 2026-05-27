import path from 'node:path';
import ky from 'ky';
import type { DbChunk, DbFile, DbWork } from '../types/db.js';
import argvUtils from '../utils/argv.js';
import configAuth from '../utils/configAuth.js';
import logger from '../utils/logger';
import math from '../utils/math.js';

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
  const outputDbDir: string = argv['output-db-dir'];
  const dbFilePath = {
    chunks: path.join(outputDbDir, 'chunks.jsonl'),
    files: path.join(outputDbDir, 'files.jsonl'),
    works: path.join(outputDbDir, 'works.jsonl'),
  };

  {
    logger.info('Checking database update ...');
    for (const name of Object.keys(dbFilePath) as Array<keyof typeof dbFilePath>) {
      const remote = await ky
        .get(
          `https://github.com/${configAuth.github.owner.main}/${configAuth.github.repo.main}/releases/download/db/${name}.jsonl`,
        )
        .text();
      const local = await Bun.file(dbFilePath[name]).text();
      logger.trace(
        `DB: ${name}, Local: ${local.trim().split('\n').length}, Remote: ${remote.trim().split('\n').length}`,
      );
      if (local.trim().split('\n').length < remote.trim().split('\n').length) {
        logger.debug(`DB: ${name}, update detected`);
        await Bun.write(dbFilePath[name], remote);
      }
    }
  }

  const db = {
    chunks: (await Bun.file(dbFilePath.chunks).text())
      .trim()
      .split('\n')
      .map((e) => JSON.parse(e) as DbChunk),
    files: (await Bun.file(dbFilePath.files).text())
      .trim()
      .split('\n')
      .map((e) => JSON.parse(e) as DbFile),
    works: (await Bun.file(dbFilePath.works).text())
      .trim()
      .split('\n')
      .map((e) => JSON.parse(e) as DbWork),
  };

  logger.info(
    'Archived total size: ' +
      math.formatFileSize(math.arrayTotal(db.files.flatMap((e) => e.chunks.map((f) => f.size))), FORMAT_SIZE_OPTS),
  );
};
