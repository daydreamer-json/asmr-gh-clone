import { Octokit } from '@octokit/rest';
import checkDiskSpace from 'check-disk-space';
import { rimraf } from 'rimraf';
import api from '../utils/api';
import argvUtils from '../utils/argv.js';
import configAuth from '../utils/configAuth.js';
import download from '../utils/download.js';
import githubUtils from '../utils/github.js';
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
  const octoClient = new Octokit({ auth: configAuth.github.pat.main });
  const apClient = await api.AudioProviderClient.createClient('original');
  const dsClient = new api.DlsiteClient();
  // const id = 1026121;
  // const id = 276666;
  const ids = [276666, 1026121];

  const metadataArray = [];
  logger.debug('Fetching metadata ...');
  for (const id of ids) {
    logger.trace('Fetching metadata: ' + id);
    const workInfo = await apClient.work.info(id);
    const dlsiteInfo = await dsClient.work.info(stringUtils.rjIdNumToStr(id));
    const [main, thumb, icon] = await Promise.all([
      apClient.work.media.coverImage(id, 'main'),
      apClient.work.media.coverImage(id, 'thumb'),
      apClient.work.media.coverImage(id, 'icon'),
    ]);
    const coverImage = { main, thumb, icon };
    const apFileEntry = await apClient.work.fileEntry(id);
    const rsp = { id, workInfo, dlsiteInfo, coverImage, files: apFileEntry.transformed };
    metadataArray.push(rsp);
    // logger.debug(`${stringUtils.rjIdNumToStr(id)}: ${rsp.dlsiteInfo.work_name}`);
    logger.trace(`Release: ${rsp.workInfo.release}, Create date: ${rsp.workInfo.create_date}`);
    logger.trace(
      'File total size: ' + math.formatFileSize(math.arrayTotal(rsp.files.map((e) => e.size)), FORMAT_SIZE_OPTS),
    );
  }

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

  // logger.debug('Starting download test...');
  await rimraf(argvUtils.getArgv()['output-dir']); //! for testing purpose! please comment out in prod
  // const results = await download.downloadFiles(metadataArray.map((e) => e.files).flat());
  // logger.debug(`Downloaded files count: ${results.length}`);
  // logger.debug('Results: ' + JSON.stringify(results, null, 2));

  // await githubUtils.createNewRelease(octoClient, configAuth.github.owner.main, configAuth.github.repo.main, 'rel00000', 'Untitled', 'nothing to explain', true);
};
