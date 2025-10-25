const ORIGINAL_ENV = { ...process.env };

type RuntimeModule = typeof import('../runtime-version.js');

async function readLocalPackageVersion(): Promise<string | null> {
  const [{ readFile }, { join }] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
  ]);

  const packageJsonPath = join(process.cwd(), 'package.json');
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
    version?: string;
  };

  return typeof pkg.version === 'string' ? pkg.version : null;
}

async function loadRuntimeModule(): Promise<RuntimeModule> {
  jest.resetModules();
  jest.unmock('node:module');

  const module = (await import('../runtime-version.js')) as RuntimeModule;
  module.resetCachedRuntimeVersionForTesting();

  return module;
}

describe('resolveRuntimeVersion', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('prefers explicit NAYLENCE_RUNTIME_VERSION', async () => {
    const runtime = await loadRuntimeModule();
    process.env.NAYLENCE_RUNTIME_VERSION = ' 1.2.3 ';
    const version = await runtime.resolveRuntimeVersion();
    expect(version).toBe('1.2.3');
  });

  it('uses npm package metadata when running via npm', async () => {
    const runtime = await loadRuntimeModule();
    delete process.env.NAYLENCE_RUNTIME_VERSION;
    process.env.npm_package_name = '@naylence/runtime';
    process.env.npm_package_version = '9.9.9';

    const version = await runtime.resolveRuntimeVersion();
    expect(version).toBe('9.9.9');
  });

  it('falls back to the local package.json when no environment metadata is available', async () => {
    const runtime = await loadRuntimeModule();
    delete process.env.NAYLENCE_RUNTIME_VERSION;
    delete process.env.npm_package_name;
    delete process.env.npm_package_version;

    const version = await runtime.resolveRuntimeVersion();
    const pkgVersion = await readLocalPackageVersion();

    expect(version).toBe(pkgVersion);
  });

  it('caches resolved versions until the cache is reset', async () => {
    const runtime = await loadRuntimeModule();
    process.env.NAYLENCE_RUNTIME_VERSION = '1.2.0';

    const first = await runtime.resolveRuntimeVersion();
    expect(first).toBe('1.2.0');

    process.env.NAYLENCE_RUNTIME_VERSION = '9.9.9';

    const second = await runtime.resolveRuntimeVersion();
    expect(second).toBe('1.2.0');

    runtime.resetCachedRuntimeVersionForTesting();

    const third = await runtime.resolveRuntimeVersion();
    expect(third).toBe('9.9.9');
  });

  it('returns null when the process does not expose a Node runtime', async () => {
    const runtime = await loadRuntimeModule();
    delete process.env.NAYLENCE_RUNTIME_VERSION;
    delete process.env.npm_package_name;
    delete process.env.npm_package_version;

    const processDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'process'
    );

    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      writable: true,
      value: { env: {} },
    });

    try {
      const version = await runtime.resolveRuntimeVersion();
      expect(version).toBeNull();
    } finally {
      if (processDescriptor) {
        Object.defineProperty(globalThis, 'process', processDescriptor);
      } else {
        delete (globalThis as any).process;
      }
    }
  });

  it('ignores blank environment overrides', async () => {
    const runtime = await loadRuntimeModule();
    process.env.NAYLENCE_RUNTIME_VERSION = '   ';
    delete process.env.npm_package_name;
    delete process.env.npm_package_version;

    const version = await runtime.resolveRuntimeVersion();
    const pkgVersion = await readLocalPackageVersion();

    expect(version).toBe(pkgVersion);
  });

  it('ignores npm metadata for other packages', async () => {
    const runtime = await loadRuntimeModule();
    delete process.env.NAYLENCE_RUNTIME_VERSION;
    process.env.npm_package_name = 'some-other-package';
    process.env.npm_package_version = '3.3.3';

    const version = await runtime.resolveRuntimeVersion();
    const pkgVersion = await readLocalPackageVersion();

    expect(version).toBe(pkgVersion);
  });
});
