import fs from "fs";
import { getDefaultFameConfigResolver, setDefaultFameConfigResolver } from "naylence-core";

import {
  configLogger as logger,
  normalizeExtendedFameConfig,
  parseConfigString,
  parseJson,
  parseYamlContent,
} from "./extended-fame-config-base.js";
import type { ExtendedFameConfig } from "./extended-fame-config-base.js";
import { isNode } from "../util/logging-types.js";

export { ExtendedFameConfigSchema } from "./extended-fame-config-base.js";
export { normalizeExtendedFameConfig } from "./extended-fame-config-base.js";
export type { ExtendedFameConfig } from "./extended-fame-config-base.js";

export const ENV_VAR_FAME_CONFIG = "FAME_CONFIG";

const CONFIG_SEARCH_PATHS = [
  "fame-config.json",
  "fame-config.yaml",
  "fame-config.yml",
  "/etc/fame/fame-config.json",
  "/etc/fame/fame-config.yaml",
  "/etc/fame/fame-config.yml",
] as const;

function readConfigFile(filePath: string): Record<string, unknown> {
  if (!isNode || !fs || typeof fs.readFileSync !== "function") {
    throw new Error("File system access is not available in this environment");
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lower = filePath.toLowerCase();

  try {
    if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
      const parsed = parseYamlContent(content);
      logger.debug("loaded_fame_config_from_file_yaml", { file: filePath });
      return parsed;
    }

    const parsed = parseJson(content);
    logger.debug("loaded_fame_config_from_file_json", { file: filePath });
    return parsed;
  } catch (error) {
    logger.error("fame_config_file_parse_error", {
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

  if (isNode && fs && typeof fs.existsSync === "function" && fs.existsSync(trimmed)) {
    return readConfigFile(trimmed);
  }

  return parseConfigString(trimmed);
}

function loadFromEnv(): Record<string, unknown> | null {
  if (typeof process === "undefined" || !process.env) {
    return null;
  }

  const raw = process.env[ENV_VAR_FAME_CONFIG];
  if (!raw) {
    return null;
  }

  try {
    return resolveEnvValue(raw);
  } catch (error) {
    logger.error("fame_config_env_parse_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function loadFromFiles(): Record<string, unknown> {
  if (!isNode || !fs || typeof fs.existsSync !== "function") {
    return {};
  }

  for (const candidate of CONFIG_SEARCH_PATHS) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      return readConfigFile(candidate);
    } catch (error) {
      logger.error("fame_config_file_error", {
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
    logger.error("fame_config_validation_error", {
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
