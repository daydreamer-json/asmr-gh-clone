import deepmerge from 'deepmerge';
import YAML from 'yaml';
// import * as TypesGameEntry from '../types/GameEntry.js';
import * as TypesLogLevels from '../types/LogLevels.js';

type Freeze<T> = Readonly<{
  [P in keyof T]: T[P] extends object ? Freeze<T[P]> : T[P];
}>;
type AllRequired<T> = Required<{
  [P in keyof T]: T[P] extends object ? Freeze<T[P]> : T[P];
}>;

type ConfigType = AllRequired<
  Freeze<{
    network: {
      api: {
        audioProvider: {
          base: {
            latest: string;
            original: string;
            mirror1: string;
            mirror2: string;
            mirror3: string;
          };
          referer: string;
        };
      };
      userAgent: {
        // UA to hide the fact that the access is from this tool
        minimum: string;
        chromeWindows: string;
        curl: string;
        ios: string;
      };
      secChUa: {
        chrome: string;
      };
      timeout: number; // Network timeout
      retryCount: number; // Number of retries for access failure
    };
    threadCount: {
      // Upper limit on the number of threads for parallel processing
      networkDownload: number; // network access
      networkUpload: number; // network access
      networkMetadata: number; // network access
      hashing: number; // file hashing
    };
    logger: {
      // log4js-node logger settings
      logLevel: TypesLogLevels.LogLevelNumber;
      useCustomLayout: boolean;
      customLayoutPattern: string;
      progressBarConfig: {
        // cli-progress settings
        barCompleteChar: string;
        barIncompleteChar: string;
        hideCursor: boolean;
        barsize: number;
        fps: number;
        clearOnComplete: boolean;
      };
    };
  }>
>;

const initialConfig: ConfigType = {
  network: {
    api: {
      audioProvider: {
        base: {
          latest: 'YXBpLmFzbXItMjAwLmNvbS9hcGk=',
          original: 'YXBpLmFzbXIub25lL2FwaQ==',
          mirror1: 'YXBpLmFzbXItMTAwLmNvbS9hcGk=',
          mirror2: 'YXBpLmFzbXItMjAwLmNvbS9hcGk=',
          mirror3: 'YXBpLmFzbXItMzAwLmNvbS9hcGk=',
        },
        referer: 'aHR0cHM6Ly9hc21yLm9uZS8=',
      },
    },
    userAgent: {
      minimum: 'Mozilla/5.0',
      chromeWindows:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      curl: 'curl/8.4.0',
      ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    },
    secChUa: {
      chrome: '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    },
    timeout: 20000,
    retryCount: 5,
  },
  threadCount: { networkDownload: 8, networkUpload: 4, networkMetadata: 8, hashing: 8 },
  logger: {
    logLevel: 0,
    useCustomLayout: true,
    customLayoutPattern: '%[%d{hh:mm:ss.SSS} %-5.0p >%] %m',
    progressBarConfig: {
      barCompleteChar: '\u2588',
      barIncompleteChar: ' ',
      hideCursor: false,
      barsize: 30,
      fps: 10,
      clearOnComplete: true,
    },
  },
};

const deobfuscator = (input: ConfigType): ConfigType => {
  const newConfig = JSON.parse(JSON.stringify(input)) as any;
  const apiAud = newConfig.network.api.audioProvider;
  for (const key of Object.keys(apiAud.base) as (keyof typeof apiAud.base)[]) {
    apiAud.base[key] = atob(apiAud.base[key]);
  }
  apiAud.referer = atob(apiAud.referer);
  return newConfig as ConfigType;
};

const filePath = 'config/config.yaml';

if ((await Bun.file(filePath).exists()) === false) {
  await Bun.write(filePath, YAML.stringify(initialConfig));
}

const config: ConfigType = await (async () => {
  const rawFileData: ConfigType = YAML.parse(await Bun.file(filePath).text()) as ConfigType;
  const mergedConfig = deepmerge(initialConfig, rawFileData, {
    arrayMerge: (_destinationArray, sourceArray) => sourceArray,
  });
  if (JSON.stringify(rawFileData) !== JSON.stringify(mergedConfig)) {
    await Bun.write(filePath, YAML.stringify(mergedConfig));
  }
  return deobfuscator(mergedConfig);
})();

export default config;
