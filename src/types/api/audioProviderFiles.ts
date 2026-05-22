export interface CommonFile {
  hash: string;
  title: string; // file name
  work: { id: number; source_id: string; source_type: string };
  workTitle: string;
  mediaStreamUrl: string;
  mediaDownloadUrl: string;
  size: number;
}

export interface CommonFolder {
  title: string; // folder name
  children: FilesystemEntry[];
}

export type FilesystemEntry =
  | ({ type: 'audio'; streamLowQualityUrl: '' | string; duration: number } & CommonFile)
  | ({ type: 'image' | 'text' | 'other' } & CommonFile)
  | ({ type: 'folder' } & CommonFolder);

// path example: ['folderA', 'subfolderB', 'example.wav']. last element must always be a filename.
export type FilesystemEntryTransformed = { path: string[]; uuid: string } & (
  | ({ type: 'audio'; streamLowQualityUrl: '' | string; duration: number } & Omit<
      CommonFile,
      'title' | 'workTitle' | 'work'
    >)
  | ({ type: 'image' | 'text' | 'other' } & Omit<CommonFile, 'title' | 'workTitle' | 'work'>)
);
