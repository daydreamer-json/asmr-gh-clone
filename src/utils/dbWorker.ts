import path from 'node:path';
import type { DbChunk, DbFile, DbWork } from '../types/db.js';
import type { DbWorkerRequest, DbWorkerResponse, DbWorkerWrittenFile } from '../types/dbWorker.js';
import { readDbFile, writeDbFileAtomic } from './db.js';

declare const self: Worker;

let outputDbDir = '';
let initialized = false;
let works: DbWork[] = [];
let files: DbFile[] = [];
let chunks: DbChunk[] = [];
const fileIndex = new Map<string, DbFile>();

let chain: Promise<void> = Promise.resolve();

function worksPath(): string {
  return path.join(outputDbDir, 'works.msgpack.zst');
}

function filesPath(): string {
  return path.join(outputDbDir, 'files.msgpack.zst');
}

function chunksPath(): string {
  return path.join(outputDbDir, 'chunks.msgpack.zst');
}

function handleInit(dir: string): { workCount: number; fileCount: number; chunkCount: number } {
  if (!initialized || outputDbDir !== dir) {
    outputDbDir = dir;
    works = readDbFile<DbWork>(worksPath());
    files = readDbFile<DbFile>(filesPath());
    chunks = readDbFile<DbChunk>(chunksPath());
    fileIndex.clear();
    for (const file of files) {
      if (file && typeof file.hash === 'string') {
        fileIndex.set(file.hash, file);
      }
    }
    initialized = true;
  }
  return { workCount: works.length, fileCount: files.length, chunkCount: chunks.length };
}

function handleGetWorkIds(): { ids: number[] } {
  const ids: number[] = [];
  for (const work of works) {
    if (work && typeof work.id === 'number') {
      ids.push(work.id);
    }
  }
  return { ids };
}

function handleGetFilesByHashes(hashes: string[]): { files: (DbFile | null)[] } {
  return { files: hashes.map((hash) => fileIndex.get(hash) ?? null) };
}

function handleGetValidChunkUuids(): { uuids: string[] } {
  const uuids = new Set<string>();
  for (const file of files) {
    if (file.chunks) {
      for (const chunk of file.chunks) {
        if (chunk.uuid) {
          uuids.add(chunk.uuid);
        }
      }
    }
  }
  for (const work of works) {
    if (work.files) {
      for (const file of work.files) {
        if (file.chunks) {
          for (const chunk of file.chunks) {
            if (chunk.uuid) {
              uuids.add(chunk.uuid);
            }
          }
        }
      }
    }
  }
  return { uuids: [...uuids] };
}

function handleAppend(
  newWorks: DbWork[],
  newFiles: DbFile[],
  newChunks: DbChunk[],
): { written: DbWorkerWrittenFile[] } {
  const written: DbWorkerWrittenFile[] = [];
  if (newWorks.length > 0) {
    works.push(...newWorks);
    writeDbFileAtomic(worksPath(), works);
    written.push({ name: 'works.msgpack.zst', path: worksPath() });
  }
  if (newFiles.length > 0) {
    files.push(...newFiles);
    for (const file of newFiles) {
      if (file && typeof file.hash === 'string') {
        fileIndex.set(file.hash, file);
      }
    }
    writeDbFileAtomic(filesPath(), files);
    written.push({ name: 'files.msgpack.zst', path: filesPath() });
  }
  if (newChunks.length > 0) {
    chunks.push(...newChunks);
    writeDbFileAtomic(chunksPath(), chunks);
    written.push({ name: 'chunks.msgpack.zst', path: chunksPath() });
  }
  return { written };
}

function dispatch(request: DbWorkerRequest): Omit<DbWorkerResponse, 'requestId' | 'ok'> {
  if (request.type !== 'init' && !initialized) {
    throw new Error('DB worker is not initialized');
  }
  switch (request.type) {
    case 'init':
      return handleInit(request.outputDbDir);
    case 'getWorkIds':
      return handleGetWorkIds();
    case 'getFilesByHashes':
      return handleGetFilesByHashes(request.hashes ?? []);
    case 'getValidChunkUuids':
      return handleGetValidChunkUuids();
    case 'append':
      return handleAppend(request.works ?? [], request.files ?? [], request.chunks ?? []);
  }
}

self.onmessage = (event: MessageEvent) => {
  const request = event.data as DbWorkerRequest;
  chain = chain
    .then(() => {
      const data = dispatch(request);
      const response: DbWorkerResponse = { requestId: request.requestId, ok: true, ...data };
      self.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: DbWorkerResponse = {
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    });
};
