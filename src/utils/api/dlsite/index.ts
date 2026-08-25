import ky from 'ky';
import defaultSettings from './defaultSettings';

const MAX_INFO_ATTEMPTS = 5;

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
      // DLsite API sometimes returns [] due to CDN cache issues; retry until valid
      for (let attempt = 1; attempt <= MAX_INFO_ATTEMPTS; attempt++) {
        const rsp: any = await this.api
          .get('maniax/product/info/ajax', {
            ...defaultSettings.ky,
            searchParams: {
              product_id: source_id,
              cdn_cache_min: 1,
            },
          })
          .json();
        const info = rsp?.[source_id] ?? rsp;
        if (!(Array.isArray(info) && info.length === 0)) return info;
      }
      throw new Error(`Response is [] after ${MAX_INFO_ATTEMPTS} attempts`);
    },
  };
}
