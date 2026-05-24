import config from '../../config.js';

export default {
  ky: {
    headers: {
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'ja-JP,ja;q=0.9',
      'Cache-Control': 'no-cache',
      Origin: config.network.api.audioProvider.referer.replace(/\/$/g, ''),
      Pragma: 'no-cache',
      Referer: config.network.api.audioProvider.referer,
      'Sec-CH-UA': config.network.secChUa.chrome,
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': 'Windows',
      'User-Agent': config.network.userAgent.chromeWindows,
    },
    timeout: config.network.timeout,
    retry: { limit: config.network.retryCount },
  },
};
