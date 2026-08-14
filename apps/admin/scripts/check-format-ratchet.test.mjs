import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findChangedAdminFiles } from "./check-format-ratchet.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFeatureRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-admin-format-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Admin CI fixture");
  git(root, "config", "user.email", "admin-ci@example.invalid");
  fs.mkdirSync(path.join(root, "apps", "admin", "src"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "apps", "admin", "src", "base.ts"),
    "export {};\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const baseRef = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-c", "feature");
  fs.writeFileSync(
    path.join(root, "apps", "admin", "src", "base.ts"),
    "export const changed = true;\n",
  );
  fs.writeFileSync(
    path.join(root, "apps", "admin", "src", "added.tsx"),
    "export const Added = () => null;\n",
  );
  fs.writeFileSync(path.join(root, "outside.txt"), "not an Admin file\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "feature");
  return { root, baseRef };
}

test("ordinary feature pushes inspect the complete Admin PR diff", (t) => {
  const fixture = createFeatureRepo(t);
  assert.deepEqual(
    findChangedAdminFiles({ cwd: fixture.root, baseRef: fixture.baseRef }),
    ["src/added.tsx", "src/base.ts"],
  );
});

test("an empty final marker still inspects the complete Admin PR diff", (t) => {
  const fixture = createFeatureRepo(t);
  git(fixture.root, "commit", "--allow-empty", "-m", "ci: final [full-ci]");
  assert.deepEqual(
    findChangedAdminFiles({ cwd: fixture.root, baseRef: fixture.baseRef }),
    ["src/added.tsx", "src/base.ts"],
  );
});
