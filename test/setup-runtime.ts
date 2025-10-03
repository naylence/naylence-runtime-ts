import { registerRuntimeFactories } from "../src/naylence/fame/util/register-runtime-factories.js";

beforeAll(async () => {
  await registerRuntimeFactories();
});
