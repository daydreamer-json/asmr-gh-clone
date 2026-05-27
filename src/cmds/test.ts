import fs from 'node:fs';
import path from 'node:path';
import argvUtils from '../utils/argv.js';
import { readDbFile } from '../utils/db.js';
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

  logger.info('Running database verification test...');

  for (const name of Object.keys(dbFilePath) as Array<keyof typeof dbFilePath>) {
    const filePath = dbFilePath[name];
    if (!fs.existsSync(filePath)) {
      logger.warn(`DB file ${name} does not exist at ${filePath}`);
      continue;
    }

    const compressedSize = fs.statSync(filePath).size;
    try {
      const data = readDbFile(filePath);
      logger.info(
        `DB: ${name.padEnd(6, ' ')} | Count: ${String(data.length).padStart(6, ' ')} | Compressed Size: ${math.formatFileSize(compressedSize, FORMAT_SIZE_OPTS)}`,
      );
    } catch (error) {
      logger.error(`Verification failed for ${name}: ${error}`);
    }
  }
};
