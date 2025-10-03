import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { PluginResolver } from "naylence-factory";
import { loadPlugins } from "naylence-factory";

jest.mock("../naylence/fame/util/register-runtime-factories.js", () => ({
  registerRuntimeFactories: jest.fn(() => Promise.resolve()),
}));

describe("runtime plugin", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("register() is idempotent", async () => {
    const pluginModule = await import("../plugin.js");
    const { registerRuntimeFactories } = await import(
      "../naylence/fame/util/register-runtime-factories.js"
    );
    const registerRuntimeFactoriesMock = registerRuntimeFactories as jest.Mock;

    await pluginModule.default.register();
    await pluginModule.default.register();

    expect(registerRuntimeFactoriesMock).toHaveBeenCalledTimes(1);
  });

  test("works with factory loader + resolver", async () => {
    const pluginModule = await import("../plugin.js");
    const { registerRuntimeFactories } = await import(
      "../naylence/fame/util/register-runtime-factories.js"
    );
    const registerRuntimeFactoriesMock = registerRuntimeFactories as jest.Mock;

    const resolver: PluginResolver = {
      resolve: jest.fn(async (spec) => {
        if (spec === pluginModule.RUNTIME_PLUGIN_SPECIFIER) {
          return pluginModule.default;
        }
        return null;
      }),
    };

    await loadPlugins(pluginModule.RUNTIME_PLUGIN_SPECIFIER, resolver);

    expect((resolver.resolve as jest.Mock).mock.calls).toEqual([
      [pluginModule.RUNTIME_PLUGIN_SPECIFIER],
    ]);
    expect(registerRuntimeFactoriesMock).toHaveBeenCalledTimes(1);
  });
});
