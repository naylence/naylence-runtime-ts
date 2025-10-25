const PACKAGE_JSON_RELATIVE_PATHS = [
  '../../../../../package.json',
  '../../../../package.json',
  '../../../package.json',
  '../../package.json',
  '../package.json',
  './package.json',
];

let cachedVersion: string | null | undefined;

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

async function tryReadPackageVersion(absolutePath: string): Promise<string | null> {
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

function tryGetImportMetaUrl(): string | undefined {
  try {
    // eslint-disable-next-line no-eval
    return (0, eval)('import.meta.url') as string;
  } catch {
    return undefined;
  }
}

function resolveFromEnv(
  env: Record<string, string | undefined> | undefined
): string | null {
  if (!env) {
    return null;
  }

  const explicit = env.NAYLENCE_RUNTIME_VERSION?.trim();
  if (explicit) {
    return explicit;
  }

  const npmName = env.npm_package_name;
  const npmVersion = env.npm_package_version;
  if (npmName === '@naylence/runtime' && typeof npmVersion === 'string') {
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
    const baseSpecifier =
      importMetaUrl ??
      new URL('./', `file://${processRef.cwd?.() ?? process.cwd()}/`);
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
        ? (specifier: string) =>
            requireForCurrentModule.resolve(specifier)
        : undefined
    );
    if (moduleResolvedVersion) {
      return moduleResolvedVersion;
    }

    const cwdRequire = createRequire(
      new URL('./', `file://${processRef.cwd?.() ?? process.cwd()}/`)
    );

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
