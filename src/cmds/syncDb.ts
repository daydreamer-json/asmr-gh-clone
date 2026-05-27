import fs from 'node:fs';
import path from 'node:path';
import ky from 'ky';
import * as MsgPack from 'msgpackr';
import type { DbChunk, DbFile, DbWork } from '../types/db.js';
import argvUtils from '../utils/argv.js';
import configAuth from '../utils/configAuth.js';
import { readDbFile, writeDbFile } from '../utils/db.js';
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
    chunks: path.join(outputDbDir, 'chunks.msgpack.zst'),
    files: path.join(outputDbDir, 'files.msgpack.zst'),
    works: path.join(outputDbDir, 'works.msgpack.zst'),
  };

  {
    logger.info('Checking database update ...');
    for (const name of Object.keys(dbFilePath) as Array<keyof typeof dbFilePath>) {
      const url = `https://github.com/${configAuth.github.owner.main}/${configAuth.github.repo.main}/releases/download/db/${name}.msgpack.zst`;
      try {
        const remoteBuffer = await ky.get(url).arrayBuffer();
        const remoteData = MsgPack.unpack(Bun.zstdDecompressSync(new Uint8Array(remoteBuffer))) as any[];

        const localData = readDbFile(dbFilePath[name]);

        logger.trace(`DB: ${name}, Local: ${localData.length}, Remote: ${remoteData.length}`);

        if (localData.length < remoteData.length) {
          logger.debug(`DB: ${name}, update detected`);
          await Bun.write(dbFilePath[name], new Uint8Array(remoteBuffer));
        }
      } catch (err) {
        logger.error(`Failed to sync database "${name}" from remote: ${err}`);
      }
    }
  }

  const db = {
    chunks: readDbFile<DbChunk>(dbFilePath.chunks),
    files: readDbFile<DbFile>(dbFilePath.files),
    works: readDbFile<DbWork>(dbFilePath.works),
  };

  logger.info(
    'Archived total size: ' +
      math.formatFileSize(math.arrayTotal(db.files.flatMap((e) => e.chunks.map((f) => f.size))), FORMAT_SIZE_OPTS),
  );
};
