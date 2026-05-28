import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import cmds from './cmds.js';
import * as TypesLogLevels from './types/LogLevels.js';
import argvUtils from './utils/argv.js';
import appConfig from './utils/config.js';
import configEmbed from './utils/configEmbed.js';
import exitUtils from './utils/exit.js';
import logger from './utils/logger.js';

if (configEmbed.VERSION_NUMBER === null) throw new Error('Embed VERSION_NUMBER is null');

function wrapHandler<T>(handler: (argv: T) => Promise<void>) {
  return async (argv: T) => {
    try {
      await handler(argv);
      await exitUtils.exit(0);
    } catch (error) {
      logger.error('Error caught:', error);
      await exitUtils.exit(1);
    }
  };
}

async function parseCommand() {
  const yargsInstance = yargs(hideBin(process.argv));
  await yargsInstance
    .command(
      ['archive'],
      'Download specified works from input.json and Upload to mirror',
      (yargs) => {
        yargs.options({
          'output-db-dir': {
            // alias: ['o'],
            desc: 'Output root directory',
            default: path.resolve('output_db'),
            normalize: true,
            type: 'string',
          },
          'output-dir': {
            // alias: ['o'],
            desc: 'Output root directory',
            default: path.resolve('output'),
            normalize: true,
            type: 'string',
          },
        });
      },
      wrapHandler(cmds.archive),
    )
    .command(
      ['filterInputWrite <date-start> <date-end>'],
      'Filter works and write input.json',
      (yargs) => {
        yargs
          .positional('date-start', {
            type: 'string',
            demandOption: true,
          })
          .positional('date-end', {
            type: 'string',
            demandOption: true,
          })
          .options({});
      },
      wrapHandler(cmds.filterInputWrite),
    )
    .command(
      ['syncDb'],
      'Download DB if remote is newer',
      (yargs) => {
        yargs.options({
          'output-db-dir': {
            // alias: ['o'],
            desc: 'Output root directory',
            default: path.resolve('output_db'),
            normalize: true,
            type: 'string',
          },
        });
      },
      wrapHandler(cmds.syncDb),
    )
    .command(
      ['optimizeChunk'],
      'Optimize chunk binary file',
      (yargs) => {
        yargs.options({
          'output-db-dir': {
            // alias: ['o'],
            desc: 'Output root directory',
            default: path.resolve('output_db'),
            normalize: true,
            type: 'string',
          },
          'output-dir': {
            desc: 'Output root directory',
            default: path.resolve('output'),
            normalize: true,
            type: 'string',
          },
          'dry-run': {
            desc: 'Perform a trial run with no changes made',
            default: false,
            type: 'boolean',
          },
        });
      },
      wrapHandler(cmds.optimizeChunk),
    )
    .command(
      ['test'],
      'Test command',
      (yargs) => {
        yargs.options({
          'output-db-dir': {
            // alias: ['o'],
            desc: 'Output root directory',
            default: path.resolve('output_db'),
            normalize: true,
            type: 'string',
          },
        });
      },
      wrapHandler(cmds.test),
    )
    .options({
      'log-level': {
        desc: 'Set log level (' + TypesLogLevels.LOG_LEVELS_NUM.join(', ') + ')',
        default: appConfig.logger.logLevel,
        type: 'number',
        coerce: (arg: number): TypesLogLevels.LogLevelString => {
          if (arg < TypesLogLevels.LOG_LEVELS_NUM[0] || arg > TypesLogLevels.LOG_LEVELS_NUM.slice(-1)[0]!) {
            throw new Error(`Invalid log level: ${arg} (Expected: ${TypesLogLevels.LOG_LEVELS_NUM.join(', ')})`);
          } else {
            return TypesLogLevels.LOG_LEVELS[arg as TypesLogLevels.LogLevelNumber];
          }
        },
      },
      spinner: {
        desc: 'Enable or disable interactive progress spinner',
        default: true,
        type: 'boolean',
      },
    })
    .middleware(async (argv) => {
      argvUtils.setArgv(argv);
      logger.level = argvUtils.getArgv()['logLevel'];
      logger.trace('Process started: ' + `${configEmbed.APPLICATION_NAME} v${configEmbed.VERSION_NUMBER}`);
    })
    .scriptName(configEmbed.APPLICATION_NAME)
    .version(String(configEmbed.VERSION_NUMBER))
    .usage('$0 <command> [argument] [option]')
    .help()
    .alias('help', 'h')
    .alias('help', '?')
    .alias('version', 'V')
    .demandCommand(1)
    .strict()
    .recommendCommands()
    .parse();
}

export default parseCommand;
