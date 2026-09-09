import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Until 2026-09-03 admin forced @redocly/openapi-core's js-yaml from its
// declared 4.3.1 to 5.2.3 with an override and then rewrote redocly's YAML
// schema setup to the js-yaml 5 API from `postinstall`. The 4.x line has been
// patched since 4.3.1 (GHSA-5p4m-2wfm-xmqj), which redocly 1.34.x pins exactly,
// so native resolution needs neither. This suite pins that redocly parses YAML
// through the js-yaml it declares, unpatched, with the features the old
// post-install self-check exercised (merge keys and dates).
//
// 2026-09-09: GHSA-2883-xcg3-v3hh re-covered js-yaml 4.0.0-4.3.1 (patched at
// 4.3.2). redocly 1.34.19 still pins 4.3.1 exactly and openapi-typescript 7.13.0
// (the newest) accepts only the 1.34 line, so native resolution cannot reach the
// floor. The one substitution this suite now tolerates is a declarative
// `overrides["@redocly/openapi-core"]` whose SOLE key is `js-yaml` - it lifts the
// exact pin to the patched 4.x floor without a postinstall rewrite. Anything
// else under that override, a minimatch override, or a postinstall hook still
// fails. Remove the override (and this tolerance) when openapi-typescript adopts
// @redocly/openapi-core 2.x (js-yaml ^5.2.2).

const adminRoot = path.resolve(__dirname, "..", "..", "..");
const fromRedocly = createRequire(
  require.resolve("@redocly/openapi-core/package.json", { paths: [adminRoot] }),
);

describe("redocly resolves js-yaml natively", () => {
  it("runs no postinstall hook and overrides at most redocly's exact js-yaml pin", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(adminRoot, "package.json"), "utf8"),
    );
    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.overrides?.minimatch).toBeUndefined();
    const redoclyOverride = pkg.overrides?.["@redocly/openapi-core"];
    if (redoclyOverride !== undefined) {
      expect(Object.keys(redoclyOverride)).toEqual(["js-yaml"]);
      expect(typeof redoclyOverride["js-yaml"]).toBe("string");
    }
  });

  it("gives redocly the js-yaml 4 it declares", () => {
    const declared = fromRedocly("@redocly/openapi-core/package.json")
      .dependencies["js-yaml"];
    const resolved = fromRedocly("js-yaml/package.json").version as string;
    expect(declared).toBe("4.3.1");
    expect(resolved).toMatch(/^4\./);
    // The 4.x patched floor (GHSA-2883-xcg3-v3hh); the override exists only to
    // reach it, so a 4.x below it means the override is missing or wrong.
    const [major, minor, patch] = resolved.split(".").map(Number);
    expect(major).toBe(4);
    expect(minor > 3 || (minor === 3 && patch >= 2)).toBe(true);
  });

  it("parses merge keys and dates through redocly's own YAML layer, unpatched", () => {
    const yamlLayer = fromRedocly("@redocly/openapi-core/lib/js-yaml/index.js");
    const source = readFileSync(
      fromRedocly.resolve("@redocly/openapi-core/lib/js-yaml/index.js"),
      "utf8",
    );
    // The retired patch replaced this js-yaml 4 API call with the js-yaml 5 one.
    expect(source).toContain("JSON_SCHEMA.extend(");
    expect(source).not.toContain("JSON_SCHEMA.withTags(");

    const parsed = yamlLayer.parseYaml(
      "defaults: &defaults\n  enabled: true\nmerged:\n  <<: *defaults\ndate: 2026-08-07\n",
    ) as { merged: { enabled: boolean }; date: unknown };
    expect(parsed.merged.enabled).toBe(true);
    expect(parsed.date).toBe("2026-08-07");
    expect(yamlLayer.stringifyYaml(parsed)).toContain("enabled: true");
  });
});
