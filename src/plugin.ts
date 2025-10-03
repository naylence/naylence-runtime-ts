/**
 * Naylence Runtime plugin entry point for the naylence-factory plugin ecosystem.
 */
import type { FamePlugin } from "naylence-factory";

import { registerRuntimeFactories } from "./naylence/fame/util/register-runtime-factories.js";

let initialized = false;

const runtimePlugin: FamePlugin = {
  name: "naylence:runtime",
  async register(): Promise<void> {
    if (initialized) {
      return;
    }

    initialized = true;
    await registerRuntimeFactories();
  },
};

export default runtimePlugin;

export const RUNTIME_PLUGIN_SPECIFIER = runtimePlugin.name;
