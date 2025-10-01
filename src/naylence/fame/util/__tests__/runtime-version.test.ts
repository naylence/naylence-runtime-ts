import { resolveRuntimeVersion, resetCachedRuntimeVersionForTesting } from "../runtime-version.js";

const ORIGINAL_ENV = { ...process.env };

describe("resolveRuntimeVersion", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetCachedRuntimeVersionForTesting();
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
    resetCachedRuntimeVersionForTesting();
  });

  it("prefers explicit NAYLENCE_RUNTIME_VERSION", async () => {
    process.env.NAYLENCE_RUNTIME_VERSION = " 1.2.3 ";
    const version = await resolveRuntimeVersion();
    expect(version).toBe("1.2.3");
  });

  it("uses npm package metadata when running via npm", async () => {
    delete process.env.NAYLENCE_RUNTIME_VERSION;
    process.env.npm_package_name = "naylence-runtime";
    process.env.npm_package_version = "9.9.9";

    const version = await resolveRuntimeVersion();
    expect(version).toBe("9.9.9");
  });

  it("falls back to the local package.json when no environment metadata is available", async () => {
    delete process.env.NAYLENCE_RUNTIME_VERSION;
    delete process.env.npm_package_name;
    delete process.env.npm_package_version;

    const version = await resolveRuntimeVersion();

    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);

    const packageJsonPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf-8")) as { version?: string };

    expect(version).toBe(pkg.version ?? null);
  });
});