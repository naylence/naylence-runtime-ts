const PACKAGE_JSON_RELATIVE_PATHS = [
  // Prioritize the path that resolves to this package's root so bundlers do not fetch
  // non-existent workspace-level package.json files in dev environments (e.g. Vite).
  '../../../../../package.json',
  '../../../../../../package.json',
  '../../../../package.json',
  '../../../package.json',
  '../../package.json',
  '../package.json',
  './package.json',
];

type PackageMetadata = {
  name?: string;
  version?: string;
};

type ImportCallOptions = Record<string, unknown>;
type ImportWithAttributesFn = (
  specifier: string,
  options: ImportCallOptions
) => Promise<unknown>;

let importWithAttributesFn: ImportWithAttributesFn | null | undefined;

function getImportWithAttributesFn(): ImportWithAttributesFn | null {
  if (importWithAttributesFn !== undefined) {
    return importWithAttributesFn;
  }

  try {
    importWithAttributesFn = new Function(
      'specifier',
      'options',
      'return import(specifier, options);'
    ) as ImportWithAttributesFn;
  } catch {
    importWithAttributesFn = null;
  }

  return importWithAttributesFn;
}
let cachedVersion: string | null | undefined;
let embeddedPackageVersion: string | null | undefined;
let embeddedPackageVersionPromise: Promise<string | null> | undefined;

async function importEmbeddedPackageMetadata(): Promise<PackageMetadata | null> {
  const importOptions: Array<Record<string, unknown>> = [
    { 'with': { type: 'json' } },
    { 'assert': { type: 'json' } },
  ];

  const importFn = getImportWithAttributesFn();
  if (!importFn) {
    return null;
  }

  for (const candidatePath of PACKAGE_JSON_RELATIVE_PATHS) {
    for (const options of importOptions) {
      try {
        const result = await importFn(
          candidatePath,
          options as ImportCallOptions
        );
        const candidate =
          (result as { default?: unknown }).default ?? (result as unknown);
        if (candidate && typeof candidate === 'object') {
          return candidate as PackageMetadata;
        }
      } catch {
        // Try next option/path combination if current attempt fails.
      }
    }
  }

  return null;
}

async function resolveEmbeddedPackageVersion(): Promise<string | null> {
  if (embeddedPackageVersion !== undefined) {
    return embeddedPackageVersion;
  }

  if (!embeddedPackageVersionPromise) {
    embeddedPackageVersionPromise = (async () => {
      const metadata = await importEmbeddedPackageMetadata();
      return readVersionFromPackageJson(metadata);
    })();
  }

  embeddedPackageVersion = await embeddedPackageVersionPromise;
  return embeddedPackageVersion;
}

function readVersionFromPackageJson(
  candidate: { name?: unknown; version?: unknown } | null | undefined
): string | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const { name, version } = candidate as {
    name?: unknown;
    version?: unknown;
  };

  if (name === '@naylence/runtime' && typeof version === 'string') {
    return version;
  }

  return null;
}

async function tryReadPackageVersion(
  absolutePath: string
): Promise<string | null> {
  try {
    const [{ readFile }, pathModule] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);

    let candidateDir = pathModule.dirname(absolutePath);

    for (let depth = 0; depth < 10; depth += 1) {
      const packageJsonPath = pathModule.join(candidateDir, 'package.json');
      try {
        const contents = await readFile(packageJsonPath, 'utf-8');
        const parsed = JSON.parse(contents) as {
          name?: unknown;
          version?: unknown;
        };
        const extracted = readVersionFromPackageJson(parsed);
        if (extracted) {
          return extracted;
        }
      } catch {
        // Continue traversing upwards until we exhaust likely directories
      }

      const parentDir = pathModule.dirname(candidateDir);
      if (parentDir === candidateDir) {
        break;
      }

      candidateDir = parentDir;
    }
  } catch {
    // Ignore filesystem failures; callers will continue with other strategies
  }

  return null;
}

async function tryResolveVersionFromModule(
  resolveFn: ((specifier: string) => string) | undefined
): Promise<string | null> {
  if (!resolveFn) {
    return null;
  }

  try {
    const entryPoint = resolveFn('@naylence/runtime');
    return await tryReadPackageVersion(entryPoint);
  } catch {
    return null;
  }
}

function tryGetProcessCwdFileUrl(
  processRef: { cwd?: (() => string) | undefined } | undefined
): URL | null {
  const candidates: Array<() => string | undefined> = [];

  if (processRef && typeof processRef.cwd === 'function') {
    candidates.push(() => processRef.cwd?.());
  }

  if (typeof process !== 'undefined' && process && process !== processRef) {
    const maybeProcess = process as unknown;
    if (
      maybeProcess &&
      typeof (maybeProcess as { cwd?: () => string }).cwd === 'function'
    ) {
      candidates.push(() => (maybeProcess as { cwd?: () => string }).cwd?.());
    }
  }

  for (const getPath of candidates) {
    try {
      const result = getPath();
      if (typeof result === 'string' && result.length > 0) {
        const normalized = result.endsWith('/') ? result : `${result}/`;
        return new URL('./', `file://${normalized}`);
      }
    } catch {
      // Ignore candidates that throw so we can fall back to other strategies.
    }
  }

  return null;
}

function tryGetImportMetaUrl(): string | undefined {
  try {
    // eslint-disable-next-line no-eval
    return (0, eval)('import.meta.url') as string;
  } catch {
    return undefined;
  }
}

function readEnvValue(
  env: Record<string, string | undefined> | undefined,
  aliases: string[]
): string | undefined {
  if (!env) {
    return undefined;
  }

  for (const alias of aliases) {
    const value = env[alias];
    if (typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

function resolveFromEnv(
  env: Record<string, string | undefined> | undefined
): string | null {
  if (!env) {
    return null;
  }

  const explicitRaw = readEnvValue(env, [
    'NAYLENCE_RUNTIME_VERSION',
    'naylence_runtime_version',
    'naylenceRuntimeVersion',
    'NaylenceRuntimeVersion',
  ]);
  const explicit = explicitRaw?.trim();
  if (explicit) {
    return explicit;
  }

  const npmName = readEnvValue(env, ['npm_package_name', 'npmPackageName']);
  const npmVersion = readEnvValue(env, [
    'npm_package_version',
    'npmPackageVersion',
  ]);
  if (npmName === '@naylence/runtime' && typeof npmVersion === 'string') {
    return npmVersion;
  }

  return null;
}

async function resolveFromPackageJson(): Promise<string | null> {
  try {
    const processRef = (globalThis as any)?.process;

    const cwdUrl = tryGetProcessCwdFileUrl(processRef);

    try {
      if (typeof require === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const localRequire = require as NodeJS.Require;
        for (const candidate of PACKAGE_JSON_RELATIVE_PATHS) {
          try {
            const result = localRequire(candidate) as {
              name?: unknown;
              version?: unknown;
            };
            const extracted = readVersionFromPackageJson(result);
            if (extracted) {
              return extracted;
            }
          } catch {
            // Continue trying remaining candidates
          }
        }

        // Fallback: try direct package resolution
        try {
          const result = localRequire('@naylence/runtime/package.json') as {
            name?: unknown;
            version?: unknown;
          };
          const extracted = readVersionFromPackageJson(result);
          if (extracted) {
            return extracted;
          }
        } catch {
          // Continue to next strategy
        }

        const resolvedFromLocalRequire = await tryResolveVersionFromModule(
          typeof localRequire.resolve === 'function'
            ? (specifier: string) => localRequire.resolve(specifier)
            : undefined
        );
        if (resolvedFromLocalRequire) {
          return resolvedFromLocalRequire;
        }
      }
    } catch {
      // ignore and fall through to dynamic require resolution
    }

    const { createRequire } = await import('node:module');
    const importMetaUrl = tryGetImportMetaUrl();
    const baseSpecifier = importMetaUrl ?? cwdUrl ?? new URL('./', 'file:///');
    const requireForCurrentModule = createRequire(baseSpecifier);
    for (const candidate of PACKAGE_JSON_RELATIVE_PATHS) {
      try {
        const result = requireForCurrentModule(candidate) as {
          name?: unknown;
          version?: unknown;
        };
        const extracted = readVersionFromPackageJson(result);
        if (extracted) {
          return extracted;
        }
      } catch {
        // Continue trying remaining candidates
      }
    }

    const moduleResolvedVersion = await tryResolveVersionFromModule(
      typeof requireForCurrentModule.resolve === 'function'
        ? (specifier: string) => requireForCurrentModule.resolve(specifier)
        : undefined
    );
    if (moduleResolvedVersion) {
      return moduleResolvedVersion;
    }

    const cwdRequire = cwdUrl ? createRequire(cwdUrl) : null;

    if (cwdRequire) {
      const cwdResolvedVersion = await tryResolveVersionFromModule(
        typeof cwdRequire.resolve === 'function'
          ? (specifier: string) => cwdRequire.resolve(specifier)
          : undefined
      );
      if (cwdResolvedVersion) {
        return cwdResolvedVersion;
      }

      try {
        const result = cwdRequire('@naylence/runtime/package.json') as {
          name?: unknown;
          version?: unknown;
        };
        const extracted = readVersionFromPackageJson(result);
        if (extracted) {
          return extracted;
        }
      } catch {
        // All attempts failed
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

  const embeddedVersion = await resolveEmbeddedPackageVersion();
  if (embeddedVersion) {
    cachedVersion = embeddedVersion;
    return cachedVersion;
  }

  const packageVersion = await resolveFromPackageJson();
  cachedVersion = packageVersion ?? null;
  return cachedVersion;
}

export function resetCachedRuntimeVersionForTesting(): void {
  cachedVersion = undefined;
  embeddedPackageVersion = undefined;
  embeddedPackageVersionPromise = undefined;
  importWithAttributesFn = undefined;
}
