import checkDiskSpace from 'check-disk-space';
import { rimraf } from 'rimraf';
import api from '../utils/api';
import argvUtils from '../utils/argv.js';
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
  const apClient = await api.AudioProviderClient.createClient('original');
  const dsClient = new api.DlsiteClient();
  // const id = 1026121;
  const id = 276666;

  const metadata = await (async () => {
    const apWorkInfoRsp = await apClient.work.info(id);
    const dsInfoRsp = await dsClient.work.info(stringUtils.rjIdNumToStr(id));
    const [main, thumb, icon] = await Promise.all([
      apClient.work.media.coverImage(id, 'main'),
      apClient.work.media.coverImage(id, 'thumb'),
      apClient.work.media.coverImage(id, 'icon'),
    ]);
    const apCoverRsp = { main, thumb, icon };
    const apFileEntryRsp = await apClient.work.fileEntry(id);
    return {
      workInfo: apWorkInfoRsp,
      dlsiteInfo: dsInfoRsp,
      coverImage: apCoverRsp,
      files: apFileEntryRsp.transformed,
    };
  })();

  logger.debug('Metadata test:');
  logger.debug(`${stringUtils.rjIdNumToStr(id)}: ${metadata.dlsiteInfo.work_name}`);
  logger.debug(`Release: ${metadata.workInfo.release}, Create date: ${metadata.workInfo.create_date}`);
  logger.debug(
    'File total size: ' + math.formatFileSize(math.arrayTotal(metadata.files.map((e) => e.size)), FORMAT_SIZE_OPTS),
  );
  const diskUsage = await (async () => {
    const raw = await checkDiskSpace(argvUtils.getArgv()['output-dir']);
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

  logger.debug('Starting download test...');
  await rimraf(argvUtils.getArgv()['output-dir']); //! for testing purpose! please delete in prod
  const results = await download.downloadFiles(metadata.files);
  logger.debug(`Downloaded files count: ${results.length}`);
  logger.debug('Results: ' + JSON.stringify(results, null, 2));
};
