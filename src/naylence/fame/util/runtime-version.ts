const PACKAGE_JSON_RELATIVE_PATHS = [
  "../../../../../package.json",
  "../../../../package.json",
  "../../../package.json",
  "../../package.json",
  "../package.json",
  "./package.json",
];

let cachedVersion: string | null | undefined;

function tryGetImportMetaUrl(): string | undefined {
  try {
    // eslint-disable-next-line no-eval
    return (0, eval)("import.meta.url") as string;
  } catch {
    return undefined;
  }
}

function resolveFromEnv(env: Record<string, string | undefined> | undefined): string | null {
  if (!env) {
    return null;
  }

  const explicit = env.NAYLENCE_RUNTIME_VERSION?.trim();
  if (explicit) {
    return explicit;
  }

  const npmName = env.npm_package_name;
  const npmVersion = env.npm_package_version;
  if (npmName === "naylence-runtime" && typeof npmVersion === "string") {
    return npmVersion;
  }

  return null;
}

async function resolveFromPackageJson(): Promise<string | null> {
  try {
    const processRef = (globalThis as any)?.process;
    if (!processRef?.versions?.node) {
      return null;
    }

    try {
      if (typeof require === "function") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const localRequire = require as NodeJS.Require;
  for (const candidate of PACKAGE_JSON_RELATIVE_PATHS) {
    try {
      const result = localRequire(candidate) as { version?: unknown };
      if (result && typeof result.version === "string") {
        return result.version;
      }
    } catch {
      // Continue trying remaining candidates
    }
  }
      }
    } catch {
      // ignore and fall through to dynamic require resolution
    }

    const { createRequire } = await import("node:module");
    const importMetaUrl = tryGetImportMetaUrl();
    const baseSpecifier =
      importMetaUrl ?? new URL("./", `file://${processRef.cwd?.() ?? process.cwd()}/`);
    const requireForCurrentModule = createRequire(baseSpecifier);
    for (const candidate of PACKAGE_JSON_RELATIVE_PATHS) {
      try {
        const result = requireForCurrentModule(candidate) as { version?: unknown };
        if (result && typeof result.version === "string") {
          return result.version;
        }
      } catch {
        // Continue trying remaining candidates
      }
    }
  } catch {
    // Ignore failures and fall through to null
  }

  return null;
}

export async function resolveRuntimeVersion(): Promise<string | null> {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }

  const envVersion = resolveFromEnv((globalThis as any)?.process?.env);
  if (envVersion) {
    cachedVersion = envVersion;
    return cachedVersion;
  }

  const packageVersion = await resolveFromPackageJson();
  cachedVersion = packageVersion ?? null;
  return cachedVersion;
}

export function resetCachedRuntimeVersionForTesting(): void {
  cachedVersion = undefined;
}