import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  dependencyEntries,
  dependencyViolations,
} from "../../../scripts/security/dependency-floors.mjs";

const lockfile = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const dependencies = [
  {
    name: "brace-expansion",
    floors: { 1: "1.1.21", 2: "2.1.7", 5: "5.0.12" },
    vulnerable: { 1: "1.1.18", 2: "2.1.4", 5: "5.0.9" },
    copies: 10,
  },
  {
    name: "undici",
    floors: { 8: "8.10.2" },
    vulnerable: { 8: "8.10.0" },
    copies: 1,
  },
];

for (const { name, floors, vulnerable, copies } of dependencies) {
  const entries = dependencyEntries(lockfile, name);

  test(`${name} checks the complete locked population`, () => {
    assert.equal(entries.length, copies);
  });

  test(`${name} has no resolved copy below its advisory floor`, () => {
    assert.deepEqual(dependencyViolations(lockfile, name, floors), []);
  });

  for (const { packagePath, version } of entries) {
    test(`${name} rejects a downgrade at ${packagePath}`, () => {
      const mutated = structuredClone(lockfile);
      const downgrade = vulnerable[version.split(".")[0]];
      assert.ok(downgrade, `Missing negative control for ${version}`);
      mutated.packages[packagePath].version = downgrade;
      const violations = dependencyViolations(mutated, name, floors);
      assert.equal(violations.length, 1);
      assert.ok(
        violations[0].startsWith(`${packagePath} resolved ${downgrade}`),
      );
    });
  }

  test(`${name} rejects an empty dependency population`, () => {
    const mutated = structuredClone(lockfile);
    for (const { packagePath } of entries) delete mutated.packages[packagePath];
    assert.deepEqual(dependencyViolations(mutated, name, floors), [
      `${name} is absent from the lockfile`,
    ]);
  });
}
