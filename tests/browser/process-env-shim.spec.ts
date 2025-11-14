import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const g = globalThis as typeof globalThis & {
  __ENV__?: Record<string, string>;
};

const originalProcess = g.process;
const originalInjectedEnv = g.__ENV__;

const createProcessWithoutEnv = (): NodeJS.Process => {
  if (!originalProcess) {
    return {
      env: undefined,
    } as unknown as NodeJS.Process;
  }

  const stub = Object.create(originalProcess) as NodeJS.Process;
  Object.defineProperty(stub, 'env', {
    configurable: true,
    enumerable: true,
    get() {
      return undefined;
    },
    set(value) {
      Object.defineProperty(stub, 'env', {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
  });
  return stub;
};

describe('process env shim', () => {
  beforeEach(() => {
    vi.resetModules();
    g.__ENV__ = undefined;
    g.process = createProcessWithoutEnv();
  });

  afterEach(() => {
    g.__ENV__ = originalInjectedEnv;
    g.process = originalProcess;
    vi.resetModules();
  });

  it('reads values from globalThis.__ENV__ with dynamic keys', async () => {
    g.__ENV__ = { FOO: 'bar' };

    await import('../../src/browser.js');

    const env = g.process?.env;
    const key = 'FOO';
    expect(env?.FOO).toBe('bar');
    expect(env?.[key]).toBe('bar');
  });

  it('respects preexisting process env polyfills', async () => {
    const existingProcess = Object.create(originalProcess ?? {}) as NodeJS.Process;
    existingProcess.env = { MARK: 'ok' } as unknown as NodeJS.ProcessEnv;
    g.process = existingProcess;

    await import('../../src/browser.js');

    expect(g.process).toBe(existingProcess);
    expect(g.process.env.MARK).toBe('ok');
  });

  it('can be installed explicitly via the dedicated entry', async () => {
    g.__ENV__ = { FIZZ: 'buzz' };

    await import('../../src/install-env.js');

    expect(g.process?.env.FIZZ).toBe('buzz');
  });
});