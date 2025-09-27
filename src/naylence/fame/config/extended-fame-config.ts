import fs from 'fs';
import { z } from 'zod';
import { FameConfigSchema, type FameConfig } from 'naylence-core';
import { parse as parseYaml } from 'yaml';

import { getLogger } from '../util/logging.js';
import { isNode } from '../util/logging-types.js';

const logger = getLogger('naylence.fame.config');

export const ENV_VAR_FAME_CONFIG = 'FAME_CONFIG';

const CONFIG_SEARCH_PATHS = [
  'fame-config.json',
  'fame-config.yaml',
  'fame-config.yml',
  '/etc/fame/fame-config.json',
  '/etc/fame/fame-config.yaml',
  '/etc/fame/fame-config.yml',
] as const;

export const ExtendedFameConfigSchema = FameConfigSchema.extend({
  node: z.unknown().optional(),
  welcome: z.unknown().optional(),
}).passthrough();

export type ExtendedFameConfig = z.infer<typeof ExtendedFameConfigSchema>;

export function normalizeExtendedFameConfig(
  config: FameConfig | Record<string, unknown>
): ExtendedFameConfig {
  return ExtendedFameConfigSchema.parse(config);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content);
  if (!isPlainObject(parsed)) {
    throw new Error('Parsed JSON config must be an object');
  }
  return parsed;
}

function parseYamlContent(content: string): Record<string, unknown> {
  const parsed = parseYaml(content ?? '') as unknown;
  if (parsed == null) {
    return {};
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Parsed YAML config must be an object');
  }
  return parsed;
}

function parseConfigString(raw: string): Record<string, unknown> {
  let jsonError: unknown;

  try {
    const parsed = parseJson(raw);
    logger.debug('loaded_fame_config_from_env_var_json');
    return parsed;
  } catch (error) {
    jsonError = error;
  }

  try {
    const parsed = parseYamlContent(raw);
    logger.debug('loaded_fame_config_from_env_var_yaml');
    return parsed;
  } catch (yamlError) {
    logger.error('fame_config_env_invalid', {
      json_error: jsonError instanceof Error ? jsonError.message : String(jsonError ?? ''),
      yaml_error: yamlError instanceof Error ? yamlError.message : String(yamlError ?? ''),
    });
    throw new Error(
      `FAME_CONFIG contains invalid JSON/YAML. JSON error: ${
        jsonError instanceof Error ? jsonError.message : String(jsonError ?? '')
      }, YAML error: ${yamlError instanceof Error ? yamlError.message : String(yamlError ?? '')}`
    );
  }
}

function readConfigFile(filePath: string): Record<string, unknown> {
  if (!isNode || !fs || typeof fs.readFileSync !== 'function') {
    throw new Error('File system access is not available in this environment');
  }

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

  if (isNode && fs && typeof fs.existsSync === 'function' && fs.existsSync(trimmed)) {
    return readConfigFile(trimmed);
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
  if (!isNode || !fs || typeof fs.existsSync !== 'function') {
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

export function loadFameConfig(): ExtendedFameConfig {
  const fromEnv = loadFromEnv();
  const rawConfig = fromEnv ?? loadFromFiles();

  try {
    return normalizeExtendedFameConfig(rawConfig);
  } catch (error) {
    logger.error('fame_config_validation_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function getFameConfig(): ExtendedFameConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = loadFameConfig();
  return cachedConfig;
}

export function resetFameConfigCache(): void {
  cachedConfig = null;
}
