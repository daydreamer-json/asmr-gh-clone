import deepmerge from 'deepmerge';
import YAML from 'yaml';

type Freeze<T> = Readonly<{
  [P in keyof T]: T[P] extends object ? Freeze<T[P]> : T[P];
}>;
type AllRequired<T> = Required<{
  [P in keyof T]: T[P] extends object ? Freeze<T[P]> : T[P];
}>;

type ConfigType = AllRequired<
  Freeze<{
    github: {
      pat: {
        main: string;
      };
    };
  }>
>;

const initialConfig: ConfigType = {
  github: {
    pat: { main: '' },
  },
};

const deobfuscator = (input: ConfigType): ConfigType => {
  const newConfig = JSON.parse(JSON.stringify(input)) as any;
  const pats = newConfig.github.pat;
  for (const key of Object.keys(pats) as (keyof typeof pats)[]) {
    pats[key] = atob(pats[key]);
  }
  return newConfig as ConfigType;
};

const filePath = 'config/config_auth.yaml';

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
