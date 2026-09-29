import { Octokit } from '@octokit/rest';
import argvUtils from '../utils/argv.js';
import configAuth from '../utils/configAuth.js';
import download from '../utils/download.js';
import logger from '../utils/logger.js';
import uploadUtils from '../utils/upload.js';

export default async () => {
  const argv = argvUtils.getArgv();
  const outputDbDir: string = argv['output-db-dir'];
  const dryRun: boolean = argv['dry-run'] === true;
  const forceRefresh: boolean = argv['force-refresh'] === true;
  const includeSealed: boolean = argv['all'] === true;
  const recentCount: number = typeof argv['recent'] === 'number' ? argv['recent'] : 0;

  const octoClient = new Octokit({ auth: configAuth.github.pat.main });
  const owner = configAuth.github.owner.main;
  const repo = configAuth.github.repo.main;

  const validChunkUuids = await download.collectValidChunkUuids(outputDbDir);
  logger.info(`Valid chunk UUIDs in local DB: ${validChunkUuids.size}`);

  if (recentCount > 0 && !includeSealed) {
    await uploadUtils.cleanupRecentAssets(octoClient, owner, repo, validChunkUuids, outputDbDir, recentCount, {
      dryRun,
      forceRefresh,
    });
    return;
  }

  await uploadUtils.cleanupPendingAssets(octoClient, owner, repo, validChunkUuids, {
    outputDbDir,
    includeSealed,
    dryRun,
    forceRefresh,
  });
};
