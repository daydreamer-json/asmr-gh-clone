import type { RspWorkInfoSanitized } from './api/audioProvider.js';

export interface DbChunk {
  uuid: string;
  url: string;
}

export interface DbFileChunk {
  uuid: string;
  offset: number;
  size: number;
}

export interface DbFile {
  hash: string;
  chunks: DbFileChunk[];
}

export interface DbWorkFile {
  path: string[];
  hash: string;
  chunks: DbFileChunk[];
}

export interface DbWork {
  id: number;
  workInfo: RspWorkInfoSanitized;
  dlsiteInfo: Record<string, unknown> | null;
  coverImage: {
    main: boolean;
    thumb: boolean;
    icon: boolean;
  };
  files: DbWorkFile[];
}
