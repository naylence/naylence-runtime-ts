import {
  getDefaultFameConfigResolver,
  setDefaultFameConfigResolver,
} from '@naylence/core';

import {
  configLogger as logger,
  normalizeExtendedFameConfig,
  parseConfigString,
  parseJson,
  parseYamlContent,
} from './extended-fame-config-base.js';
import type { ExtendedFameConfig } from './extended-fame-config-base.js';
import { isNode } from '../util/logging-types.js';

export { ExtendedFameConfigSchema } from './extended-fame-config-base.js';
export { normalizeExtendedFameConfig } from './extended-fame-config-base.js';
export type { ExtendedFameConfig } from './extended-fame-config-base.js';

export const ENV_VAR_FAME_CONFIG = 'FAME_CONFIG';

const CONFIG_SEARCH_PATHS = [
  'fame-config.json',
  'fame-config.yaml',
  'fame-config.yml',
  '/etc/fame/fame-config.json',
  '/etc/fame/fame-config.yaml',
  '/etc/fame/fame-config.yml',
] as const;

type FsModule = typeof import('fs');

const fsModuleSpecifier = String.fromCharCode(102) + String.fromCharCode(115);
let cachedFsModule: FsModule | null = null;

// Capture this module's URL without triggering TypeScript's import.meta restriction on CJS builds
const currentModuleUrl: string | undefined = (() => {
  try {
    return (0, eval)('import.meta.url') as string;
  } catch {
    return undefined;
  }
})();

let cachedNodeRequire: NodeRequire | null =
  typeof require === 'function' ? require : null;

function createFsShim(): FsModule | null {
  if (!isNode) {
    return null;
  }

  const processBinding = (process as NodeJS.Process & {
    binding?: (name: string) => unknown;
  }).binding;

  if (typeof processBinding !== 'function') {
    return null;
  }

  try {
    const fsBinding = processBinding('fs') as {
      readFileUtf8?: (path: string, flags?: number) => string;
      existsSync?: (path: string) => boolean;
      internalModuleStat?: (path: string) => number;
    } | null;

    if (!fsBinding || typeof fsBinding.readFileUtf8 !== 'function') {
      return null;
    }

    const shim: any = {
      readFileSync: (
        ...args: Parameters<FsModule['readFileSync']>
      ): ReturnType<FsModule['readFileSync']> => {
        const [pathOrDescriptor, options] = args;

        if (typeof pathOrDescriptor !== 'string') {
          throw new Error('FS shim only supports string file paths');
        }

        let encoding: BufferEncoding | undefined;
        if (typeof options === 'string') {
          encoding = options as BufferEncoding;
        } else if (
          options &&
          typeof options === 'object' &&
          'encoding' in options &&
          typeof (options as { encoding?: BufferEncoding | null }).encoding === 'string'
        ) {
          encoding = (options as { encoding: BufferEncoding }).encoding;
        }

        const data = fsBinding.readFileUtf8!(pathOrDescriptor, 0);

        if (!encoding) {
          return typeof Buffer !== 'undefined'
            ? Buffer.from(data, 'utf-8')
            : (data as unknown as ReturnType<FsModule['readFileSync']>);
        }

        const lowered = encoding.toLowerCase();
        if (lowered === 'utf-8' || lowered === 'utf8') {
          return data as unknown as ReturnType<FsModule['readFileSync']>;
        }

        if (typeof Buffer === 'undefined') {
          throw new Error(
            `Buffer API is not available to convert encoding ${String(encoding)}`
          );
        }

        return Buffer.from(data, 'utf-8').toString(
          encoding
        ) as unknown as ReturnType<FsModule['readFileSync']>;
      },
      existsSync: (
        ...args: Parameters<FsModule['existsSync']>
      ): ReturnType<FsModule['existsSync']> => {
        const [pathLike] = args;

        if (typeof pathLike !== 'string') {
          return false as ReturnType<FsModule['existsSync']>;
        }

        if (typeof fsBinding.existsSync === 'function') {
          try {
            return Boolean(
              fsBinding.existsSync(pathLike)
            ) as ReturnType<FsModule['existsSync']>;
          } catch {
            // fall through to the internal stat fallback
          }
        }

        if (typeof fsBinding.internalModuleStat === 'function') {
          try {
            return (fsBinding.internalModuleStat(pathLike) >= 0) as ReturnType<
              FsModule['existsSync']
            >;
          } catch {
            return false as ReturnType<FsModule['existsSync']>;
          }
        }

        return false as ReturnType<FsModule['existsSync']>;
      },
    };

    return shim as FsModule;
  } catch {
    return null;
  }
}

function fileUrlToPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') {
      return null;
    }

    let pathname = parsed.pathname;
    if (
      typeof process !== 'undefined' &&
      process.platform === 'win32' &&
      pathname.startsWith('/')
    ) {
      pathname = pathname.slice(1);
    }

    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function getNodeRequire(): NodeRequire | null {
  if (cachedNodeRequire) {
    return cachedNodeRequire;
  }

  if (!isNode) {
    return null;
  }

  const processBinding = (process as NodeJS.Process & {
    binding?: (name: string) => unknown;
  }).binding;

  if (typeof processBinding !== 'function') {
    return null;
  }

  try {
    const moduleWrap = processBinding('module_wrap') as {
      createRequire?: (filename: string) => NodeRequire;
    };

    if (typeof moduleWrap?.createRequire !== 'function') {
      return null;
    }

    const modulePathFromUrl = currentModuleUrl
      ? fileUrlToPath(currentModuleUrl)
      : null;

    const requireSource =
      modulePathFromUrl ?? `${process.cwd()}/.naylence-require-shim.js`;

    cachedNodeRequire = moduleWrap.createRequire(requireSource);
    return cachedNodeRequire;
  } catch {
    return null;
  }
}

function getFsModule(): FsModule {
  if (cachedFsModule) {
    return cachedFsModule;
  }

  if (!isNode) {
    throw new Error('File system access is not available in this environment');
  }

  const nodeRequire = typeof require === 'function' ? require : getNodeRequire();

  if (nodeRequire) {
    try {
      cachedFsModule = nodeRequire(fsModuleSpecifier) as FsModule;
      return cachedFsModule;
    } catch (error) {
      throw new Error(
        `Unable to load file system module: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const shim = createFsShim();
  if (shim) {
    cachedFsModule = shim;
    return cachedFsModule;
  }

  throw new Error('File system module is not accessible in this environment');
}

function readConfigFile(filePath: string): Record<string, unknown> {
  const fs = getFsModule();

  const content = fs.readFileSync(filePath, 'utf-8');
  const lower = filePath.toLowerCase();

  try {
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
      const parsed = parseYamlContent(content);
      logger.debug('loaded_fame_config_from_file_yaml', { file: filePath });
      return parsed;
    }

    const parsed = parseJson(content);
    logger.debug('loaded_fame_config_from_file_json', { file: filePath });
    return parsed;
  } catch (error) {
    logger.error('fame_config_file_parse_error', {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function resolveEnvValue(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  if (isNode) {
    try {
      const fs = getFsModule();
      if (typeof fs.existsSync === 'function' && fs.existsSync(trimmed)) {
        return readConfigFile(trimmed);
      }
    } catch {
      // fall through to string parsing when fs unavailable
    }
  }

  return parseConfigString(trimmed);
}

function loadFromEnv(): Record<string, unknown> | null {
  if (typeof process === 'undefined' || !process.env) {
    return null;
  }

  const raw = process.env[ENV_VAR_FAME_CONFIG];
  if (!raw) {
    return null;
  }

  try {
    return resolveEnvValue(raw);
  } catch (error) {
    logger.error('fame_config_env_parse_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function loadFromFiles(): Record<string, unknown> {
  if (!isNode) {
    return {};
  }

  let fs: FsModule;
  try {
    fs = getFsModule();
  } catch {
    return {};
  }

  for (const candidate of CONFIG_SEARCH_PATHS) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      return readConfigFile(candidate);
    } catch (error) {
      logger.error('fame_config_file_error', {
        file: candidate,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {};
}

let cachedConfig: ExtendedFameConfig | null = null;
let cachedRawConfig: Record<string, unknown> | null = null;

export function loadRawFameConfig(): Record<string, unknown> {
  if (cachedRawConfig) {
    return cachedRawConfig;
  }

  const fromEnv = loadFromEnv();
  const rawConfig = fromEnv ?? loadFromFiles();
  cachedRawConfig = rawConfig;
  return rawConfig;
}

export function loadFameConfig(): ExtendedFameConfig {
  const rawConfig = loadRawFameConfig();

  try {
    const normalized = normalizeExtendedFameConfig(rawConfig);
    cachedConfig = normalized;
    return normalized;
  } catch (error) {
    logger.error('fame_config_validation_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

let pluginsLoaded = false;

export async function loadPluginsFromConfig(): Promise<void> {
  if (pluginsLoaded) {
    return;
  }

  const rawConfig = loadRawFameConfig();
  const pluginNames = (rawConfig.plugins as string[] | undefined) ?? [];

  if (pluginNames.length === 0) {
    pluginsLoaded = true;
    return;
  }

  logger.debug('loading_plugins_from_config', { plugins: pluginNames });

  try {
    // Import each plugin and call its register function
    for (const pluginName of pluginNames) {
      try {
        // Import from the plugin subpath (all naylence plugins export ./plugin).
        // The Vite ignore hint avoids bundler analysis warnings for this runtime-only pattern.
        const pluginModule = await import(
          /* @vite-ignore */ `${pluginName}/plugin`
        );
        const plugin =
          pluginModule.default ?? pluginModule.plugin ?? pluginModule;

        if (
          plugin &&
          typeof (plugin as { register?: unknown }).register === 'function'
        ) {
          logger.debug('registering_plugin', {
            plugin: pluginName,
            name: (plugin as { name?: string }).name,
          });
          await (plugin as { register: () => Promise<void> }).register();
        } else {
          logger.error('plugin_missing_register_method', {
            plugin: pluginName,
            keys: Object.keys(pluginModule),
            hasDefault: 'default' in pluginModule,
            hasPlugin: 'plugin' in pluginModule,
          });
          throw new Error(
            `Plugin ${pluginName} does not export a register() method`
          );
        }
      } catch (error) {
        logger.error('plugin_load_failed', {
          plugin: pluginName,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    }

    pluginsLoaded = true;
    logger.debug('plugins_loaded_from_config');
  } catch (error) {
    logger.error('failed_to_load_plugins_from_config', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function getFameConfig(): ExtendedFameConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const config = loadFameConfig();
  cachedConfig = config;
  return config;
}

export function resetFameConfigCache(): void {
  cachedConfig = null;
  cachedRawConfig = null;
}

if (isNode && !getDefaultFameConfigResolver()) {
  setDefaultFameConfigResolver(async () => loadRawFameConfig());
}
