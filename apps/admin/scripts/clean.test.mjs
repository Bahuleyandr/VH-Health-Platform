import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanAdminArtifacts, getCleanTargets } from "./clean.mjs";

test("clean targets stay inside the selected Admin root", () => {
  const root = path.resolve("fixture-admin-root");
  for (const { target } of getCleanTargets(root)) {
    assert.ok(target.startsWith(`${root}${path.sep}`));
  }
});

test("clean removes generated output without touching source or dependencies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-admin-clean-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".next"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, ".next", "BUILD_ID"), "fixture");
  fs.writeFileSync(path.join(root, "src", "keep.ts"), "export {};");

  assert.deepEqual(cleanAdminArtifacts({ root }), [".next"]);
  assert.equal(fs.existsSync(path.join(root, ".next")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules")), true);
  assert.equal(fs.existsSync(path.join(root, "src", "keep.ts")), true);
});
