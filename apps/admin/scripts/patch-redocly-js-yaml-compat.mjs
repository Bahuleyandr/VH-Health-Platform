import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const REDOCLY_VERSION = "1.34.18";
const JS_YAML_VERSION = "5.2.3";
const packageRoot = process.cwd();
const nodeModulesRoot = path.resolve(packageRoot, "node_modules");
const packageLock = JSON.parse(
  await readFile(path.join(packageRoot, "package-lock.json"), "utf8"),
);
const redoclyPaths = Object.entries(packageLock.packages)
  .filter(
    ([packagePath, metadata]) =>
      packagePath.endsWith("node_modules/@redocly/openapi-core") &&
      metadata.version === REDOCLY_VERSION,
  )
  .map(([packagePath]) => packagePath);

if (redoclyPaths.length !== 1) {
  throw new Error(
    `Expected one openapi-core@${REDOCLY_VERSION} installation, found ${redoclyPaths.length}`,
  );
}

const redoclyRoot = path.resolve(
  packageRoot,
  ...redoclyPaths[0].split("/"),
);
const localRequire = createRequire(path.join(redoclyRoot, "package.json"));
const jsYamlRoot = path.dirname(localRequire.resolve("js-yaml/package.json"));

for (const packagePath of [redoclyRoot, jsYamlRoot]) {
  const stat = await lstat(packagePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to patch through symlinked package at ${packagePath}`);
  }
  const canonicalPath = await realpath(packagePath);
  if (!canonicalPath.startsWith(`${nodeModulesRoot}${path.sep}`)) {
    throw new Error(`Dependency escaped node_modules: ${packagePath}`);
  }
}

const redoclyMetadata = JSON.parse(
  await readFile(path.join(redoclyRoot, "package.json"), "utf8"),
);
const jsYamlMetadata = JSON.parse(
  await readFile(path.join(jsYamlRoot, "package.json"), "utf8"),
);

if (
  redoclyMetadata.name !== "@redocly/openapi-core" ||
  redoclyMetadata.version !== REDOCLY_VERSION
) {
  throw new Error(`Unexpected Redocly version at ${redoclyRoot}`);
}
if (
  jsYamlMetadata.name !== "js-yaml" ||
  jsYamlMetadata.version !== JS_YAML_VERSION
) {
  throw new Error(`Unexpected js-yaml version at ${jsYamlRoot}`);
}

const target = path.join(redoclyRoot, "lib", "js-yaml", "index.js");
const source = await readFile(target, "utf8");
const vulnerableApi = `const DEFAULT_SCHEMA_WITHOUT_TIMESTAMP = js_yaml_1.JSON_SCHEMA.extend({
    implicit: [js_yaml_1.types.merge],
    explicit: [js_yaml_1.types.binary, js_yaml_1.types.omap, js_yaml_1.types.pairs, js_yaml_1.types.set],
});`;
const fixedApi = `const DEFAULT_SCHEMA_WITHOUT_TIMESTAMP = js_yaml_1.JSON_SCHEMA.withTags(
    js_yaml_1.mergeTag,
    js_yaml_1.binaryTag,
    js_yaml_1.omapTag,
    js_yaml_1.pairsTag,
    js_yaml_1.setTag,
);`;

if (!source.includes(fixedApi)) {
  if (!source.includes(vulnerableApi)) {
    throw new Error(`Redocly js-yaml compatibility anchor missing in ${target}`);
  }
  await writeFile(target, source.replace(vulnerableApi, fixedApi), "utf8");
}

delete localRequire.cache[target];
const { parseYaml, stringifyYaml } = localRequire(target);
const parsed = parseYaml(`defaults: &defaults
  enabled: true
merged:
  <<: *defaults
date: 2026-08-07
`);

if (
  parsed.merged.enabled !== true ||
  parsed.date !== "2026-08-07" ||
  !stringifyYaml(parsed).includes("enabled: true")
) {
  throw new Error("Redocly js-yaml compatibility check failed");
}

console.log(
  `Redocly compatibility ready: openapi-core@${REDOCLY_VERSION} with js-yaml@${JS_YAML_VERSION}`,
);
