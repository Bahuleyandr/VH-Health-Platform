import { spawnSync } from "node:child_process";

const baseRef = process.env.ADMIN_FORMAT_BASE_REF ?? "HEAD";
const diff = spawnSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", baseRef, "--"],
  { encoding: "utf8" },
);
if (diff.status !== 0) {
  console.error(diff.stderr || `git diff failed with status ${diff.status}`);
  process.exit(diff.status ?? 1);
}

const supported =
  /\.(?:cjs|css|html|js|json|jsx|md|mjs|mts|scss|ts|tsx|yaml|yml)$/;
const files = diff.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => file.startsWith("apps/admin/"))
  .map((file) => file.slice("apps/admin/".length))
  .filter((file) => supported.test(file));

if (files.length === 0) {
  console.log("Admin format ratchet OK: no changed format-supported files.");
  process.exit(0);
}

const prettier = spawnSync(
  process.execPath,
  ["node_modules/prettier/bin/prettier.cjs", "--check", ...files],
  { stdio: "inherit" },
);
process.exit(prettier.status ?? 1);
