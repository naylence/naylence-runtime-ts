import { z } from 'zod';
import { type FameConfig, snakeToCamelObject } from '@naylence/core';
import { parse as parseYaml } from 'yaml';

import { getLogger } from '../util/logging.js';

export const configLogger = getLogger(
  'naylence.fame.config.extended_fame_config_base'
);

// Create the extended schema by preprocessing and then extending the base object schema
export const ExtendedFameConfigSchema = z.preprocess(
  snakeToCamelObject,
  z
    .object({
      fabric: z.any().optional().describe('Fame fabric config'),
      plugins: z
        .array(
          z.union([
            z.string(),
            z.object({
              name: z.string(),
              export: z.string().optional(),
            }),
          ])
        )
        .optional()
        .default([]),
      autoLoadPlugins: z.boolean().optional().default(true),
      pluginLogLevel: z
        .enum(['silent', 'error', 'warn', 'info', 'debug'])
        .optional()
        .default('warn'),
      node: z.unknown().optional(),
      welcome: z.unknown().optional(),
    })
    .loose()
);

export type ExtendedFameConfig = z.infer<typeof ExtendedFameConfigSchema>;

export function normalizeExtendedFameConfig(
  config: FameConfig | Record<string, unknown>
): ExtendedFameConfig {
  const result = ExtendedFameConfigSchema.parse(config);
  return result;
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJson(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content);
  if (!isPlainObject(parsed)) {
    throw new Error('Parsed JSON config must be an object');
  }
  return parsed;
}

export function parseYamlContent(content: string): Record<string, unknown> {
  const parsed = parseYaml(content ?? '') as unknown;
  if (parsed == null) {
    return {};
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Parsed YAML config must be an object');
  }
  return parsed;
}

export function parseConfigString(raw: string): Record<string, unknown> {
  let jsonError: unknown;

  try {
  const parsed = parseJson(raw);
  configLogger.debug('loaded_fame_config_from_env_var_json');
    return parsed;
  } catch (error) {
    jsonError = error;
  }

  try {
  const parsed = parseYamlContent(raw);
  configLogger.debug('loaded_fame_config_from_env_var_yaml');
    return parsed;
  } catch (yamlError) {
    configLogger.error('fame_config_env_invalid', {
      json_error:
        jsonError instanceof Error
          ? jsonError.message
          : String(jsonError ?? ''),
      yaml_error:
        yamlError instanceof Error
          ? yamlError.message
          : String(yamlError ?? ''),
    });
    throw new Error(
      `FAME_CONFIG contains invalid JSON/YAML. JSON error: ${
        jsonError instanceof Error ? jsonError.message : String(jsonError ?? '')
      }, YAML error: ${yamlError instanceof Error ? yamlError.message : String(yamlError ?? '')}`
    );
  }
}
