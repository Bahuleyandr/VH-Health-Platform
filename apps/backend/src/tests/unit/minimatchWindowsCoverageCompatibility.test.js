import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const backendRoot = path.resolve(import.meta.dirname, "../../..");
const windowsTest = process.platform === "win32" ? test : test.skip;

describe("minimatch Windows coverage compatibility", () => {
  test("test-exclude retains its Windows path compatibility patch", () => {
    const packageLock = JSON.parse(
      readFileSync(path.join(backendRoot, "package-lock.json"), "utf8"),
    );
    expect(packageLock.packages["node_modules/test-exclude"]?.version).toBe("6.0.0");
    expect(packageLock.packages["node_modules/minimatch"]?.version).toBe("10.2.5");

    const testExcludeWin32Path = require.resolve(
      "test-exclude/is-outside-dir-win32.js",
    );
    expect(readFileSync(testExcludeWin32Path, "utf8")).toContain(
      "windowsPathsNoEscape: true",
    );

    const minimatch = require("minimatch");
    expect(
      minimatch(
        "D:\\repo\\src\\services\\auth\\otpService.js",
        "D:\\repo\\**",
        { dot: true, windowsPathsNoEscape: true },
      ),
    ).toBe(true);
  });

  windowsTest("test-exclude enforces the backend root on Windows", () => {
    const TestExclude = require("test-exclude");
    const exclude = new TestExclude({ cwd: backendRoot });
    expect(
      exclude.shouldInstrument(
        path.join(backendRoot, "src", "services", "auth", "otpService.js"),
      ),
    ).toBe(true);
    expect(
      exclude.shouldInstrument(path.resolve(backendRoot, "..", "outside.js")),
    ).toBe(false);
  });
});
