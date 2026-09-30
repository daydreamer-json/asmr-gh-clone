import type { DbChunk, DbFile, DbWork } from './db.js';

export type DbWorkerRequestType = 'init' | 'getWorkIds' | 'getFilesByHashes' | 'getValidChunkUuids' | 'append';

export interface DbWorkerRequest {
  requestId: number;
  type: DbWorkerRequestType;
  outputDbDir: string;
  hashes?: string[];
  works?: DbWork[];
  files?: DbFile[];
  chunks?: DbChunk[];
}

export interface DbWorkerWrittenFile {
  name: string;
  path: string;
}

export interface DbWorkerResponse {
  requestId: number;
  ok: boolean;
  error?: string;
  workCount?: number;
  fileCount?: number;
  chunkCount?: number;
  ids?: number[];
  files?: (DbFile | null)[];
  uuids?: string[];
  written?: DbWorkerWrittenFile[];
}
