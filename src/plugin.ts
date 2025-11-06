/**
 * Naylence Runtime plugin entry point for the naylence-factory plugin ecosystem.
 */
import type { FamePlugin } from '@naylence/factory';

import { registerRuntimeFactories } from './naylence/fame/util/register-runtime-factories.js';
import { VERSION } from './version.js';

let initialized = false;

const runtimePlugin: FamePlugin = {
  name: 'naylence:runtime',
  version: VERSION,
  async register(): Promise<void> {
    // console.log('[naylence:runtime] register() called, initialized=', initialized);
    if (initialized) {
      // console.log('[naylence:runtime] already initialized, skipping');
      return;
    }

    initialized = true;
    // console.log('[naylence:runtime] registering runtime factories...');

    // Register factories from manifest
    await registerRuntimeFactories();

    // Import modules with side-effect registrations (not in manifest)
    await import(
      './naylence/fame/transport/websocket-transport-provisioner.js'
    );

    // console.log('[naylence:runtime] runtime factories registered');
  },
};

export default runtimePlugin;

export const RUNTIME_PLUGIN_SPECIFIER = runtimePlugin.name;
