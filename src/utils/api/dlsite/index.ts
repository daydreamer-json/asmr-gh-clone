import ky from 'ky';
import defaultSettings from './defaultSettings';

export default class DlsiteClient {
  private api: typeof ky;

  constructor() {
    this.api = ky.extend({
      prefix: `https://${atob('d3d3LmRsc2l0ZS5jb20=')}`,
      ...defaultSettings.ky,
    });
  }

  work = {
    info: async (source_id: string): Promise<any> => {
      const rsp = await this.api
        .get('maniax/product/info/ajax', {
          ...defaultSettings.ky,
          searchParams: {
            product_id: source_id,
            cdn_cache_min: 1,
          },
        })
        .json();
      return (rsp as any)[source_id] ?? rsp;
    },
  };
}
