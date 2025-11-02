import { registerRuntimeFactories } from "../src/naylence/fame/util/register-runtime-factories.js";

let consoleWarnSpy: jest.SpyInstance;

beforeAll(async () => {
  consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  await registerRuntimeFactories();
});

afterAll(() => {
  consoleWarnSpy?.mockRestore();
});
