import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const adminRoot = path.resolve(path.dirname(scriptPath), "..");
const generatedTargets = [
  ".next",
  "coverage",
  "playwright-report",
  "test-results",
  "tsconfig.tsbuildinfo",
  path.join("src", "lib", "openapi.generated.ts"),
];

export function getCleanTargets(root = adminRoot) {
  const resolvedRoot = path.resolve(root);
  return generatedTargets.map((relativePath) => {
    const target = path.resolve(resolvedRoot, relativePath);
    if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`refusing to clean outside Admin root: ${target}`);
    }
    return { relativePath, target };
  });
}

export function cleanAdminArtifacts({ root = adminRoot, dryRun = false } = {}) {
  const removed = [];
  for (const { relativePath, target } of getCleanTargets(root)) {
    if (!fs.existsSync(target)) continue;
    removed.push(relativePath);
    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
  }
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const dryRun = process.argv.includes("--dry-run");
  const removed = cleanAdminArtifacts({ dryRun });
  const verb = dryRun ? "would remove" : "removed";
  if (removed.length === 0) {
    console.log("Admin clean: no generated artifacts found.");
  } else {
    console.log(`Admin clean ${verb}: ${removed.join(", ")}`);
  }
}
