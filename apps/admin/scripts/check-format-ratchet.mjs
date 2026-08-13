import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const adminRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(adminRoot, "..", "..");
const supported =
  /\.(?:cjs|css|html|js|json|jsx|md|mjs|mts|scss|ts|tsx|yaml|yml)$/;

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      result.stderr ||
        `git ${args.join(" ")} failed with status ${result.status}`,
    );
  }
  return result.stdout.trim();
}

export function findChangedAdminFiles({
  cwd = repoRoot,
  baseRef,
  headRef = "HEAD",
}) {
  if (!baseRef) throw new Error("ADMIN_FORMAT_BASE_REF is required");
  const mergeBase = runGit(["merge-base", baseRef, headRef], cwd);
  if (!mergeBase) {
    throw new Error(
      `git merge-base returned no commit for ${baseRef} ${headRef}`,
    );
  }
  const changed = runGit(
    [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      mergeBase,
      headRef,
      "--",
      "apps/admin/",
    ],
    cwd,
  );

  return changed
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.slice("apps/admin/".length))
    .filter((file) => supported.test(file));
}

function main() {
  let files;
  try {
    files = findChangedAdminFiles({
      baseRef: process.env.ADMIN_FORMAT_BASE_REF ?? "origin/main",
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (files.length === 0) {
    console.log("Admin format ratchet OK: no changed format-supported files.");
    return;
  }

  const prettier = spawnSync(
    process.execPath,
    [
      "node_modules/prettier/bin/prettier.cjs",
      "--check",
      "--end-of-line",
      "auto",
      ...files,
    ],
    { cwd: adminRoot, stdio: "inherit" },
  );
  process.exitCode = prettier.status ?? 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(scriptPath).toLowerCase()
) {
  main();
}
