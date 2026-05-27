import { DateTime } from 'luxon';
import PQueue from 'p-queue';
import api from '../utils/api/index.js';
import argvUtils from '../utils/argv.js';
import config from '../utils/config.js';
import logger from '../utils/logger';

export default async () => {
  const argv = argvUtils.getArgv();
  const inputFilePath = 'config/input.json';
  const apClient = await api.AudioProviderClient.createClient('original');

  const apiDb = await (async () => {
    logger.info('Fetching all works from API ...');
    const queue = new PQueue({ concurrency: config.threadCount.networkMetadata });
    const pageSize = 999;

    const initRsp = await apClient.works.list('create_date', 'asc', 1, pageSize);
    const workCount = initRsp.pagination.totalCount;
    const totalPages = Math.ceil(workCount / pageSize);

    const results: (Awaited<ReturnType<typeof apClient.works.list>>['works'] | null)[] = new Array(totalPages).fill(
      null,
    );

    results[0] = initRsp.works;
    // logger.trace(`Fetched: Page 1, ${initRsp.works.length} / ${workCount}`);

    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      const resultsIndex = pageNum - 1;

      queue.add(async () => {
        try {
          const rsp = await apClient.works.list('create_date', 'asc', pageNum, pageSize);
          results[resultsIndex] = rsp.works;
          // logger.trace(`Fetched: Page ${pageNum}, ${rsp.works.length} / ${workCount}`);
        } catch (error) {
          logger.error(`Fetch error: Page: ${pageNum}, `, error);
          throw error;
        }
      });
    }

    await queue.onIdle();

    const failedIndex = results.findIndex((page) => page === null);
    if (failedIndex !== -1) throw new Error(`Failed to fetch page ${failedIndex + 1}`);

    const retArr = results.flat() as Awaited<ReturnType<typeof apClient.works.list>>['works'];
    logger.info(`Fetch success: ${retArr.length} / ${workCount}`);
    return retArr;
  })();

  const filteredWorks = apiDb.filter((e) => {
    const target = DateTime.fromISO(e.create_date);
    const start = DateTime.fromISO(argv['date-start']);
    const end = DateTime.fromISO(argv['date-end']);
    return start <= target && target <= end;
  });
  logger.info(`Filtered works: ${argv['date-start']} - ${argv['date-end']}: ${filteredWorks.length} works`);
  await Bun.write(
    inputFilePath,
    JSON.stringify(
      filteredWorks.map((e) => e.id),
      null,
      2,
    ),
  );
};
