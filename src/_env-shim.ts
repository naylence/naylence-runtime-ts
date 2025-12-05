// --- ENV SHIM (runs once in browser) ---
export function installProcessEnvShim(): void {
  const g: any = globalThis;
  if (g?.process?.env) return; // already installed

  const existingProcess = typeof g.process === 'object' ? g.process : undefined;
  const preservedEnvSource =
    existingProcess?.env && typeof existingProcess.env === 'object'
      ? (existingProcess.env as Record<string, string | undefined>)
      : undefined;

  type R = Record<string, string | undefined>;
  const localEnv: R = {};
  let envProxy: R;
  function snap(): R {
    const out: R = {};
    if (g.__ENV__ && typeof g.__ENV__ === 'object')
      Object.assign(out, g.__ENV__);
    try {
      // import.meta is only available in ESM builds
      // @ts-ignore
      const ie =
        (typeof import.meta !== 'undefined' && (import.meta as any).env) ||
        undefined;
      if (ie && typeof ie === 'object') Object.assign(out, ie);
    } catch {}
    if (preservedEnvSource && preservedEnvSource !== envProxy) {
      Object.assign(out, preservedEnvSource);
    }
    Object.assign(out, localEnv);
    return out;
  }

  envProxy = new Proxy(localEnv, {
    get(_t, p: string) {
      const v = snap()[String(p)];
      return v === undefined ? undefined : String(v);
    },
    has(_t, p) {
      return Object.prototype.hasOwnProperty.call(snap(), String(p));
    },
    ownKeys() {
      return Object.keys(snap());
    },
    getOwnPropertyDescriptor(_t, p) {
      const v = snap()[String(p)];
      return v === undefined
        ? undefined
        : { enumerable: true, configurable: true, value: v };
    },
    set(_t, p, value) {
      const key = String(p);
      const next = value === undefined ? undefined : String(value);
      if (next === undefined) {
        delete localEnv[key];
      } else {
        localEnv[key] = next;
      }
      return true;
    },
    deleteProperty(_t, p) {
      delete localEnv[String(p)];
      return true;
    },
  });

  const targetProcess = existingProcess ?? {};
  Object.defineProperty(targetProcess, 'env', {
    configurable: true,
    enumerable: true,
    get() {
      return envProxy;
    },
    set(value) {
      if (value && typeof value === 'object') {
        Object.assign(localEnv, value as Record<string, string | undefined>);
      } else if (value === undefined) {
        for (const key of Object.keys(localEnv)) delete localEnv[key];
      }
    },
  });
  g.process = targetProcess;
}
installProcessEnvShim();
// --- END ENV SHIM ---
