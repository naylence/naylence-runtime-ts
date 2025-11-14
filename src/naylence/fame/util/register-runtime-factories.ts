/**
 * Runtime helper for registering Naylence Fame runtime factories.
 *
 * This wraps the auto-generated manifest data to register every default runtime factory
 * against a provided registry implementation. By default it wires the factories into
 * the global {@link Registry} from `naylence-factory`, but callers can provide their own
 * registry instance for isolated testing or multi-runtime scenarios.
 */
import type { ResourceFactory } from '@naylence/factory';
import { Registry as DefaultRegistry } from '@naylence/factory';

import {
  MODULES,
  MODULE_LOADERS,
  type FactoryModuleLoader,
  type FactoryModuleSpec,
} from '../factory-manifest.js';

export type RuntimeFactoryRegistry = typeof DefaultRegistry;

const FACTORY_MODULE_PREFIX = '@naylence/runtime/naylence/fame/';
const BROWSER_DIST_SEGMENT = '/dist/browser/';
const NODE_ONLY_FACTORY_MODULES = new Set<FactoryModuleSpec>([
  './connector/http-listener-factory.js',
  './connector/websocket-listener-factory.js',
  './telemetry/open-telemetry-trace-emitter-factory.js',
  './security/credential/prompt-credential-provider-factory.js',
]);
const BROWSER_ONLY_FACTORY_MODULES = new Set<FactoryModuleSpec>([
  './security/auth/oauth2-pkce-token-provider-factory.js',
]);
const isNodeEnvironment =
  typeof process !== 'undefined' && Boolean(process?.versions?.node);

function detectModuleUrl(): string | null {
  // Prefer Node-friendly __filename when available.
  if (typeof __filename === 'string') {
    try {
      const normalized = __filename.startsWith('file://')
        ? __filename
        : `file://${__filename}`;
      return normalized;
    } catch {
      // fall through to stack parsing
    }
  }

  // Fallback to parsing the current stack trace to discover the executing module URL.
  try {
    throw new Error();
  } catch (error) {
    const stack =
      typeof error === 'object' && error && 'stack' in error
        ? String((error as Error).stack ?? '')
        : '';

    const lines = stack.split('\n');
    for (const line of lines) {
      const match = line.match(
        /(https?:\/\/[^\s)]+|file:\/\/[^\s)]+|\/[^\s)]+\.(?:js|ts))/u
      );
      if (!match) {
        continue;
      }

      const candidate = match[1];
      if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
        return candidate;
      }

      if (candidate.startsWith('file://')) {
        return candidate;
      }

      return `file://${candidate}`;
    }
  }

  return null;
}

function computeBrowserFactoryBase(rawUrl: string | null): string | null {
  if (!rawUrl) {
    return null;
  }

  const sanitized = rawUrl.split('?')[0]?.split('#')[0] ?? rawUrl;
  const esmMarker = '/dist/esm/naylence/fame/';
  const browserMarker = '/dist/browser/';
  const distMarker = '/dist/';

  if (sanitized.includes(esmMarker)) {
    return sanitized.slice(0, sanitized.indexOf(esmMarker) + esmMarker.length);
  }

  if (rawUrl.includes(BROWSER_DIST_SEGMENT)) {
    return new URL('../esm/naylence/fame/', rawUrl).href;
  }

  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    try {
      const parsed = new URL(rawUrl);
      const viteDepsSegment = '/node_modules/.vite/deps/';
      if (parsed.pathname.includes(viteDepsSegment)) {
        const baseOrigin = `${parsed.protocol}//${parsed.host}`;
        return `${baseOrigin}/node_modules/@naylence/runtime/dist/esm/naylence/fame/`;
      }
    } catch {
      // ignore and fall through to null
    }
  }

  if (sanitized.includes(browserMarker)) {
    const base = sanitized.slice(0, sanitized.indexOf(browserMarker) + browserMarker.length);
    return `${base.replace(/browser\/?$/u, '')}esm/naylence/fame/`;
  }

  if (sanitized.includes(distMarker)) {
    const index = sanitized.indexOf(distMarker);
    const base = sanitized.slice(0, index + distMarker.length);
    return `${base}esm/naylence/fame/`;
  }

  // Fallback for development: if this is a source file path, compute dist/esm path
  const srcMarker = '/src/naylence/fame/';
  if (sanitized.includes(srcMarker)) {
    const index = sanitized.indexOf(srcMarker);
    const projectRoot = sanitized.slice(0, index);
    return `${projectRoot}/dist/esm/naylence/fame/`;
  }

  return null;
}

const moduleUrl = detectModuleUrl();
const browserFactoryBase = computeBrowserFactoryBase(moduleUrl);

function resolveFactoryModuleSpecifier(specifier: string): string | null {
  if (specifier.startsWith('../')) {
    const relativePath = specifier.slice('../'.length);
    return `${FACTORY_MODULE_PREFIX}${relativePath}`;
  }

  if (specifier.startsWith('./')) {
    const relativePath = specifier.slice('./'.length);
    return `${FACTORY_MODULE_PREFIX}${relativePath}`;
  }

  return null;
}

function resolveModuleCandidates(spec: string): string[] {
  const packageSpecifier = resolveFactoryModuleSpecifier(spec);
  const candidates: string[] = [];
  const preferSource = typeof moduleUrl === 'string' && moduleUrl.includes('/src/');

  const addCandidate = (candidate: string | null): void => {
    if (!candidate) {
      return;
    }
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  if (preferSource && spec.startsWith('./')) {
    const baseSource = `../${spec.slice(2)}`;
    addCandidate(baseSource);
    if (baseSource.endsWith('.js')) {
      addCandidate(baseSource.replace(/\.js$/u, '.ts'));
    }
  }

  if (browserFactoryBase && spec.startsWith('./')) {
    const browserCandidate = new URL(spec.slice('./'.length), browserFactoryBase).href;
    addCandidate(browserCandidate);
    if (browserCandidate.endsWith('.js')) {
      addCandidate(browserCandidate.replace(/\.js$/u, '.ts'));
    }
  }

  if (packageSpecifier) {
    addCandidate(packageSpecifier);
    if (packageSpecifier.endsWith('.js')) {
      addCandidate(packageSpecifier.replace(/\.js$/u, '.ts'));
    }
  }

  const baseFallback = spec.startsWith('./') ? `../${spec.slice(2)}` : spec;
  addCandidate(baseFallback);
  if (baseFallback.endsWith('.js')) {
    addCandidate(baseFallback.replace(/\.js$/u, '.ts'));
  }

  return candidates;
}

async function performRegistration(
  registry: RuntimeFactoryRegistry
): Promise<void> {
  await Promise.all(
    MODULES.map(async (spec: FactoryModuleSpec) => {
      if (!isNodeEnvironment && NODE_ONLY_FACTORY_MODULES.has(spec)) {
        return;
      }

      if (isNodeEnvironment && BROWSER_ONLY_FACTORY_MODULES.has(spec)) {
        return;
      }

      try {
        let mod: Record<string, unknown> | undefined;
        let lastError: unknown;

        const staticLoader: FactoryModuleLoader | undefined =
          MODULE_LOADERS?.[spec];

        if (staticLoader) {
          try {
            mod = await staticLoader();
          } catch (error) {
            lastError = error;
          }
        }

        if (!mod) {
          const candidates = resolveModuleCandidates(spec);

          for (const [index, candidate] of candidates.entries()) {
            try {
              mod = await import(/* @vite-ignore */ candidate);
              lastError = undefined;
              break;
            } catch (error) {
              lastError = error;

              const isLastCandidate = index === candidates.length - 1;
              if (isLastCandidate) {
                throw error;
              }

              const message =
                error instanceof Error ? error.message : String(error);
              const moduleNotFound =
                message.includes('Cannot find module') ||
                message.includes('ERR_MODULE_NOT_FOUND') ||
                message.includes('Unknown file extension') ||
                message.includes('Failed to fetch dynamically imported module') ||
                message.includes('Importing a module script failed');

              if (!moduleNotFound) {
                throw error;
              }
            }
          }
        }

        if (!mod) {
          throw (
            lastError ?? new Error(`Unable to import factory module: ${spec}`)
          );
        }

        const meta = (mod as Record<string, unknown>).FACTORY_META as
          | { base?: string; key?: string }
          | undefined;
        const Ctor = (mod as Record<string, unknown>).default as
          | (new (...args: unknown[]) => ResourceFactory<unknown, unknown>)
          | undefined;

        if (!meta?.base || !meta?.key || typeof Ctor !== 'function') {
          console.warn(
            '[factory-manifest] skipped',
            spec,
            '— missing FACTORY_META or default export ctor'
          );
          return;
        }

        registry.registerFactory(meta.base, meta.key, Ctor);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn('[factory-manifest] skipped', spec, '-', reason);
      }
    })
  );
}

export async function registerDefaultFactories(
  registry: RuntimeFactoryRegistry = DefaultRegistry
): Promise<void> {
  await performRegistration(registry);
}

/**
 * Register all default Naylence runtime factories into the supplied registry.
 *
 * @param registry Registry implementation to receive the default runtime factories.
 */
export async function registerRuntimeFactories(
  registry: RuntimeFactoryRegistry = DefaultRegistry
): Promise<void> {
  if (registry === DefaultRegistry) {
    await ensureDefaultRegistration();
    return;
  }

  await performRegistration(registry);
}

let defaultRegistrationPromise: Promise<void> | null = null;
let defaultRegistrationError: unknown | null = null;

async function ensureDefaultRegistration(): Promise<void> {
  if (defaultRegistrationError) {
    throw defaultRegistrationError;
  }

  if (!defaultRegistrationPromise) {
    defaultRegistrationError = null;
    defaultRegistrationPromise = performRegistration(DefaultRegistry).catch(
      (error) => {
        defaultRegistrationError = error;
        defaultRegistrationPromise = null;
        throw error;
      }
    );
  }

  await defaultRegistrationPromise;
}

export async function ensureRuntimeFactoriesRegistered(
  registry: RuntimeFactoryRegistry = DefaultRegistry
): Promise<void> {
  if (registry !== DefaultRegistry) {
    await performRegistration(registry);
    return;
  }

  await ensureDefaultRegistration();
}
