import { registerRuntimeFactories } from "../src/naylence/runtime/register-runtime-factories.js";

beforeAll(async () => {
  await registerRuntimeFactories();
});
