import ky from 'ky';
import * as uuid from 'uuid';
import * as IApi from '../../../types/api/audioProvider';
import * as IApiCommon from '../../../types/api/audioProviderCommon';
import * as IApiFiles from '../../../types/api/audioProviderFiles';
import config from '../../config';
import logger from '../../logger';
import defaultSettings from './defaultSettings';

export default class AudioProviderClient {
  private api: typeof ky;

  private constructor(serverName: keyof typeof config.network.api.audioProvider.base) {
    this.api = ky.extend({
      prefix: `https://${config.network.api.audioProvider.base[serverName]}`,
      ...defaultSettings.ky,
    });
  }

  public static async createClient(
    serverName: keyof typeof config.network.api.audioProvider.base,
  ): Promise<AudioProviderClient> {
    const servers = Object.keys(
      config.network.api.audioProvider.base,
    ) as (keyof typeof config.network.api.audioProvider.base)[];
    const retryList = [serverName, ...servers.filter((s) => s !== serverName)];

    for (const name of retryList) {
      try {
        const client = new AudioProviderClient(name);
        logger.trace(`Audio Provider API health checking: ${name} ...`);
        const status = await client.health();
        logger.trace(`Audio Provider API health: ${name}, ${JSON.stringify(status)}`);

        if (status.available) {
          if (name !== serverName) {
            logger.warn(`Primary Audio Provider ${serverName} is unavailable. Falling back to: ${name}`);
          }
          return client;
        }
        logger.trace(`Audio Provider (${name}) health check failed: ${status.message}`);
      } catch (error) {
        logger.error(
          `Failed to connect to Audio Provider (${name}): ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    throw new Error('All available Audio Provider health checks failed.');
  }

  public async health(): Promise<{ available: boolean; message: string }> {
    const rsp = await this.api.get('health').text();
    return { available: rsp.includes('OK'), message: rsp };
  }

  public auth = {
    status: async (token: string | null = null): Promise<IApi.RspAuthMeGet> => {
      return this.api
        .get('auth/me', token ? { headers: { Authorization: `Bearer ${token}` } } : {})
        .json<IApi.RspAuthMeGet>();
    },
    login: async (body: IApi.ReqAuthMePost): Promise<IApi.RspAuthMePost> => {
      return this.api.post('auth/me', { json: body }).json<IApi.RspAuthMePost>();
    },
  };

  public works = {
    list: async (
      order: IApiCommon.OrderName,
      sort: 'asc' | 'desc',
      page: number,
      pageSize: number,
      subtitle: 0 | 1 = 0,
      seed: number = 0,
    ): Promise<IApi.RspWorks> => {
      if (page < 1) throw new Error('Invalid page number');
      if (pageSize < 1 || pageSize > 999) throw new Error('Invalid pageSize number');
      return this.api
        .get('works', { searchParams: { order, sort, page, pageSize, subtitle, seed } })
        .json<IApi.RspWorks>();
    },
  };

  public work = {
    info: async (workId: number): Promise<IApi.RspWorkInfoSanitized> => {
      const rsp = await this.api.get(`workInfo/${workId}`).json<IApi.RspWorkInfo>();
      const { samCoverUrl, thumbnailCoverUrl, mainCoverUrl, circle_id, name, ...rest } = rsp;

      if (circle_id !== rsp.circle.id || name !== rsp.circle.name) {
        throw new Error('workInfo API response sanitize error');
      }
      return rest;
    },

    fileEntry: async (workId: number) => {
      const raw = await this.api.get(`tracks/${workId}`).json<IApiFiles.FilesystemEntry[]>();
      const transformed: IApiFiles.FilesystemEntryTransformed[] = [];

      let refWorkStr: string | null = null;
      let refWorkTitle: string | null = null;

      const traverse = (items: IApiFiles.FilesystemEntry[], currentPath: string[]) => {
        for (const item of items) {
          if (item.type === 'folder') {
            traverse(item.children, [...currentPath, item.title]);
            continue;
          }
          const currentWorkStr = JSON.stringify(item.work);
          if (refWorkStr === null) {
            refWorkStr = currentWorkStr;
            refWorkTitle = item.workTitle;
          } else if (currentWorkStr !== refWorkStr || item.workTitle !== refWorkTitle) {
            throw new Error(`Inconsistent work or workTitle found at: ${[...currentPath, item.title].join('/')}`);
          }
          const { title, work, workTitle, ...rest } = item;
          transformed.push({ path: [...currentPath, title], uuid: uuid.v4(), ...rest });
        }
      };

      traverse(raw, []);
      return { raw, transformed };
    },

    media: {
      coverImage: async (workId: number, type: 'main' | 'thumb' | 'icon'): Promise<ArrayBuffer | null> => {
        const typeMap: Record<string, string> = { thumb: '240x240', icon: 'sam' };
        try {
          return await this.api
            .get(`cover/${workId}.jpg`, { searchParams: { type: typeMap[type] ?? type } })
            .arrayBuffer();
        } catch (err) {
          return null;
        }
      },
    },
  };
}
