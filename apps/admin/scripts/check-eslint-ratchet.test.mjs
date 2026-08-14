import assert from "node:assert/strict";
import test from "node:test";

import {
  findWarningRegressions,
  selectWarningBaseline,
} from "./check-eslint-ratchet.mjs";

const baseline = {
  total: 3,
  rules: {
    "known-warning": 3,
  },
};

test("accepts warning counts at their configured ceilings", () => {
  assert.deepEqual(
    findWarningRegressions(new Map([["known-warning", 3]]), baseline),
    { regressions: [], totalWarnings: 3 },
  );
});

test("rejects a new warning rule even below the total ceiling", () => {
  assert.deepEqual(
    findWarningRegressions(new Map([["new-warning", 1]]), baseline),
    { regressions: ["new-warning: 1 > 0"], totalWarnings: 1 },
  );
});

test("rejects per-rule and total warning growth", () => {
  assert.deepEqual(
    findWarningRegressions(new Map([["known-warning", 4]]), baseline),
    {
      regressions: ["known-warning: 4 > 3", "total: 4 > 3"],
      totalWarnings: 4,
    },
  );
});

test("selects an integration baseline only when all sentinel files exist", () => {
  const config = {
    name: "base",
    variants: [
      {
        name: "integrated",
        requiredFiles: ["one.ts", "two.ts"],
      },
    ],
  };

  assert.equal(selectWarningBaseline(config, () => false).name, "base");
  assert.equal(
    selectWarningBaseline(config, (file) => file === "one.ts").name,
    "base",
  );
  assert.equal(selectWarningBaseline(config, () => true).name, "integrated");
});
