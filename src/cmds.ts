import archive from './cmds/archive.js';
import cleanupOrphans from './cmds/cleanupOrphans.js';
import filterInputWrite from './cmds/filterInputWrite.js';
import missingDlsiteMetaDl from './cmds/missingDlsiteMetaDl.js';
import optimizeChunk from './cmds/optimizeChunk.js';
import syncDb from './cmds/syncDb.js';
import test from './cmds/test.js';

export default {
  archive,
  cleanupOrphans,
  filterInputWrite,
  missingDlsiteMetaDl,
  syncDb,
  test,
  optimizeChunk,
};
