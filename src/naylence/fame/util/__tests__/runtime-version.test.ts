import {
  resolveRuntimeVersion,
  resetCachedRuntimeVersionForTesting,
} from '../runtime-version.js';
import { VERSION } from '../../../../version.js';

describe('resolveRuntimeVersion', () => {
  it('returns the build-time injected version', async () => {
    const version = await resolveRuntimeVersion();
    expect(version).toBe(VERSION);
  });

  it('returns null if VERSION is empty', async () => {
    // This would only happen if the build script fails to inject the version
    jest.doMock('../../../../version.js', () => ({
      VERSION: '',
    }));

    jest.resetModules();
    const { resolveRuntimeVersion: resolve } = await import(
      '../runtime-version.js'
    );
    const version = await resolve();

    expect(version).toBeNull();
    jest.dontMock('../../../../version.js');
  });

  it('maintains backward compatibility with async API', async () => {
    const result = resolveRuntimeVersion();
    expect(result).toBeInstanceOf(Promise);

    const version = await result;
    expect(typeof version).toBe('string');
  });
});

describe('resetCachedRuntimeVersionForTesting', () => {
  it('exists for backward compatibility but is a no-op', () => {
    // This function is kept for backward compatibility with existing tests
    // but does nothing since version is now static
    expect(() => resetCachedRuntimeVersionForTesting()).not.toThrow();
  });
});
