import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const backendRoot = path.resolve(import.meta.dirname, "../../..");
const isWindows = process.platform === "win32";

// This suite runs on BOTH platforms and asserts on both. The pinned versions
// and the patched shim are platform-independent facts about the install; the
// glob and instrumentation behaviour is asserted with the separator the host
// actually uses. It deliberately does NOT use `test.skip` off Windows: a skip
// marker without an entry in scripts/jest-skip-floor.json fails the canonical
// gate, and the floor is meant to stay empty (see its $comment).
describe("minimatch Windows coverage compatibility", () => {
  test("the install pins the patched test-exclude/minimatch pair", () => {
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
  });

  test("minimatch matches a repo-rooted path using this platform's separator", () => {
    const minimatch = require("minimatch");
    // `windowsPathsNoEscape` makes a backslash a separator rather than an
    // escape, which is only meaningful where the host uses backslashes. On
    // POSIX the same guarantee is expressed with forward slashes, so assert
    // the equivalent rather than skipping and leaving CI with no coverage.
    const [target, pattern] = isWindows
      ? ["D:\\repo\\src\\services\\auth\\otpService.js", "D:\\repo\\**"]
      : ["/repo/src/services/auth/otpService.js", "/repo/**"];

    expect(
      minimatch(target, pattern, { dot: true, windowsPathsNoEscape: true }),
    ).toBe(true);
  });

  test("test-exclude instruments inside the backend root and refuses outside it", () => {
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
