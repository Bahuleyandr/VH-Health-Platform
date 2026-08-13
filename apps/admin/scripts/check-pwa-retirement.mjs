import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const forbiddenArtifacts = [
  "public/sw.js",
  "public/sw.js.map",
  "public/workbox-f1770938.js",
  "public/workbox-f1770938.js.map",
];
const forbiddenDependencies = [
  "@ducanh2912/next-pwa",
  "@rollup/plugin-terser",
  "serialize-javascript",
  "workbox-build",
  "workbox-webpack-plugin",
];
const violations = [];

for (const artifact of forbiddenArtifacts) {
  if (fs.existsSync(path.join(root, artifact))) {
    violations.push(`retired output exists: ${artifact}`);
  }
}
for (const dependency of forbiddenDependencies) {
  if (
    packageJson.dependencies?.[dependency] ||
    packageJson.devDependencies?.[dependency]
  ) {
    violations.push(`retired dependency exists: ${dependency}`);
  }
}
if (
  fs.existsSync(
    path.join(root, "src", "components", "ServiceWorkerCleanup.tsx"),
  )
) {
  violations.push("origin-wide ServiceWorkerCleanup still exists");
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  process.exitCode = 1;
} else {
  console.log("Legacy Admin PWA output and dependency retirement is complete.");
}
