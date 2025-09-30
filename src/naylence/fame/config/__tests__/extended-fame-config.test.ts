import fs from "fs";
import os from "os";
import path from "path";

import {
  ENV_VAR_FAME_CONFIG,
  getFameConfig,
  loadFameConfig,
  resetFameConfigCache,
} from "../extended-fame-config.js";

describe("extended fame config loader", () => {
  const originalCwd = process.cwd();
  const originalEnvValue =
    typeof process !== "undefined" && process.env ? process.env[ENV_VAR_FAME_CONFIG] : undefined;

  function setEnv(value: string | undefined): void {
    if (typeof process === "undefined" || !process.env) {
      throw new Error("process.env is not available in this environment");
    }

    if (value === undefined) {
      delete process.env[ENV_VAR_FAME_CONFIG];
      return;
    }

    process.env[ENV_VAR_FAME_CONFIG] = value;
  }

  beforeEach(() => {
    resetFameConfigCache();
    process.chdir(originalCwd);
    setEnv(undefined);
  });

  afterEach(() => {
    resetFameConfigCache();
    process.chdir(originalCwd);
    setEnv(undefined);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    setEnv(originalEnvValue);
  });

  it("parses JSON config supplied via environment variable", () => {
    const envConfig = {
      fabric: { driver: "memory" },
      node: { id: "env-json-node" },
    };

    setEnv(JSON.stringify(envConfig));

    const config = loadFameConfig();

    expect(config.fabric).toEqual({ driver: "memory" });
    expect(config.node).toEqual({ id: "env-json-node" });
  });

  it("parses YAML config supplied via environment variable", () => {
    const yamlConfig = ["fabric:", "  driver: websocket", "welcome:", "  enabled: true"].join("\n");

    setEnv(yamlConfig);

    const config = loadFameConfig();

    expect(config.fabric).toEqual({ driver: "websocket" });
    expect(config.welcome).toEqual({ enabled: true });
  });

  it("loads config from a file referenced by the environment variable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fame-config-file-env-"));
    const filePath = path.join(tempDir, "fame-config.yaml");
    const fileContents = ["fabric:", "  driver: file", "node:", "  id: file-node"].join("\n");

    fs.writeFileSync(filePath, fileContents, "utf-8");
    setEnv(filePath);

    try {
      const config = loadFameConfig();

      expect(config.fabric).toEqual({ driver: "file" });
      expect(config.node).toEqual({ id: "file-node" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("searches default config files when no environment override is provided", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fame-config-default-"));
    const filePath = path.join(tempDir, "fame-config.json");
    const jsonPayload = JSON.stringify({ welcome: { enabled: false } });

    fs.writeFileSync(filePath, jsonPayload, "utf-8");

    try {
      process.chdir(tempDir);

      const config = loadFameConfig();

      expect(config.welcome).toEqual({ enabled: false });
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("caches config instances across getFameConfig invocations", () => {
    setEnv(JSON.stringify({ node: { id: "cache-test" } }));

    const first = getFameConfig();

    setEnv(JSON.stringify({ node: { id: "ignored-after-cache" } }));

    const second = getFameConfig();

    expect(second).toBe(first);

    resetFameConfigCache();

    const refreshed = getFameConfig();

    expect(refreshed).not.toBe(first);
    expect(refreshed.node).toEqual({ id: "ignored-after-cache" });
  });

  it("raises an error for invalid environment configuration content", () => {
    setEnv("not valid json or yaml");

    expect(() => loadFameConfig()).toThrow("FAME_CONFIG contains invalid JSON/YAML");
  });
});
