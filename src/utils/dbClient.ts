import fs from 'node:fs';
import type { DbChunk, DbFile, DbWork } from '../types/db.js';
import type { DbWorkerRequest, DbWorkerResponse, DbWorkerWrittenFile } from '../types/dbWorker.js';

let worker: Worker | null = null;
let workerDir: string | null = null;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (value: DbWorkerResponse) => void; reject: (error: Error) => void }>();

function rejectAll(error: Error): void {
  for (const entry of pending.values()) {
    entry.reject(error);
  }
  pending.clear();
}

function ensureWorker(outputDbDir: string): Worker {
  if (worker === null) {
    const created: Worker = new Worker(new URL('./dbWorker.ts', import.meta.url).href);
    created.onmessage = (event: MessageEvent) => {
      const response = event.data as DbWorkerResponse;
      const entry = pending.get(response.requestId);
      if (entry !== undefined) {
        pending.delete(response.requestId);
        entry.resolve(response);
      }
    };
    created.onerror = (event: ErrorEvent) => {
      rejectAll(new Error(`DB worker error: ${event.message}`));
    };
    worker = created;
  }
  if (workerDir !== null && workerDir !== outputDbDir) {
    throw new Error(`DB worker already initialized for a different directory: ${workerDir}`);
  }
  return worker;
}

function send(request: Omit<DbWorkerRequest, 'requestId'>): Promise<DbWorkerResponse> {
  const active = ensureWorker(request.outputDbDir);
  const requestId = nextRequestId++;
  const full: DbWorkerRequest = { ...request, requestId };
  return new Promise<DbWorkerResponse>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        if (pending.delete(requestId)) {
          reject(new Error(`DB worker request timed out: ${request.type}`));
        }
      },
      15 * 60 * 1000,
    );
    pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      active.postMessage(full);
    } catch (error) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function unwrap(response: DbWorkerResponse): DbWorkerResponse {
  if (!response.ok) {
    throw new Error(`DB worker failed: ${response.error ?? 'unknown error'}`);
  }
  return response;
}

async function init(outputDbDir: string): Promise<void> {
  if (!fs.existsSync(outputDbDir)) {
    fs.mkdirSync(outputDbDir, { recursive: true });
  }
  unwrap(await send({ type: 'init', outputDbDir }));
  workerDir = outputDbDir;
}

export async function getWorkIds(outputDbDir: string): Promise<number[]> {
  await init(outputDbDir);
  return unwrap(await send({ type: 'getWorkIds', outputDbDir })).ids ?? [];
}

export async function getFilesByHashes(outputDbDir: string, hashes: string[]): Promise<(DbFile | null)[]> {
  await init(outputDbDir);
  return unwrap(await send({ type: 'getFilesByHashes', outputDbDir, hashes })).files ?? [];
}

export async function getValidChunkUuids(outputDbDir: string): Promise<string[]> {
  await init(outputDbDir);
  return unwrap(await send({ type: 'getValidChunkUuids', outputDbDir })).uuids ?? [];
}

export async function append(
  outputDbDir: string,
  works: DbWork[],
  files: DbFile[],
  chunks: DbChunk[],
): Promise<DbWorkerWrittenFile[]> {
  await init(outputDbDir);
  return unwrap(await send({ type: 'append', outputDbDir, works, files, chunks })).written ?? [];
}

export async function shutdown(): Promise<void> {
  rejectAll(new Error('DB worker is shutting down'));
  if (worker !== null) {
    await worker.terminate();
    worker = null;
  }
  workerDir = null;
}

export default {
  getWorkIds,
  getFilesByHashes,
  getValidChunkUuids,
  append,
  shutdown,
};
