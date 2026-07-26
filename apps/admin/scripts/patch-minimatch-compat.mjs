import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MINIMATCH_VERSION = "10.2.5";
const packageRoot = process.cwd();
const nodeModulesRoot = path.resolve(packageRoot, "node_modules");
const packageLock = JSON.parse(
  await readFile(path.join(packageRoot, "package-lock.json"), "utf8"),
);

const minimatchPackages = Object.entries(packageLock.packages)
  .filter(
    ([packagePath, metadata]) =>
      packagePath.endsWith("node_modules/minimatch") &&
      metadata.version === MINIMATCH_VERSION,
  )
  .map(([packagePath]) => {
    if (
      packagePath.includes("..") ||
      !packagePath.startsWith("node_modules/")
    ) {
      throw new Error(`Unsafe minimatch lockfile path: ${packagePath}`);
    }

    const resolved = path.resolve(packageRoot, ...packagePath.split("/"));
    if (!resolved.startsWith(`${nodeModulesRoot}${path.sep}`)) {
      throw new Error(`Minimatch path escaped node_modules: ${packagePath}`);
    }
    return resolved;
  });

if (minimatchPackages.length === 0) {
  throw new Error(
    `No minimatch@${MINIMATCH_VERSION} installation was found to patch`,
  );
}

const patches = [
  {
    relativePath: "dist/commonjs/index.js",
    anchor: "exports.minimatch.unescape = unescape_js_1.unescape;\n",
    addition:
      "Object.assign(exports.minimatch, exports);\n" +
      "module.exports = exports.minimatch;\n",
  },
  {
    relativePath: "dist/esm/index.js",
    anchor: "minimatch.unescape = unescape;\n",
    addition: "export default minimatch;\n",
  },
  {
    relativePath: "dist/commonjs/index.d.ts",
    anchor: "export { unescape } from './unescape.js';\n",
    addition: "export default minimatch;\n",
  },
  {
    relativePath: "dist/esm/index.d.ts",
    anchor: "export { unescape } from './unescape.js';\n",
    addition: "export default minimatch;\n",
  },
];

let patchedFiles = 0;
const installedMinimatchRoots = new Set();

for (const minimatchRoot of new Set(minimatchPackages)) {
  let rootStat;
  try {
    rootStat = await lstat(minimatchRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to patch symlinked package at ${minimatchRoot}`);
  }

  const canonicalRoot = await realpath(minimatchRoot);
  if (!canonicalRoot.startsWith(`${nodeModulesRoot}${path.sep}`)) {
    throw new Error(`Minimatch package escaped node_modules: ${minimatchRoot}`);
  }

  const metadata = JSON.parse(
    await readFile(path.join(minimatchRoot, "package.json"), "utf8"),
  );

  if (metadata.name !== "minimatch" || metadata.version !== MINIMATCH_VERSION) {
    throw new Error(`Refusing to patch unexpected package at ${minimatchRoot}`);
  }
  installedMinimatchRoots.add(minimatchRoot);

  for (const patch of patches) {
    const target = path.join(minimatchRoot, ...patch.relativePath.split("/"));
    const source = await readFile(target, "utf8");

    if (source.includes(patch.addition)) {
      continue;
    }
    if (!source.includes(patch.anchor)) {
      throw new Error(`Compatibility anchor missing in ${target}`);
    }

    await writeFile(
      target,
      source.replace(patch.anchor, patch.anchor + patch.addition),
      "utf8",
    );
    patchedFiles += 1;
  }
}

if (installedMinimatchRoots.size === 0) {
  throw new Error(
    `No installed minimatch@${MINIMATCH_VERSION} package was found to patch`,
  );
}

const localRequire = createRequire(import.meta.url);

for (const minimatchRoot of installedMinimatchRoots) {
  const commonJs = localRequire(minimatchRoot);
  const esm = await import(
    pathToFileURL(path.join(minimatchRoot, "dist/esm/index.js"))
  );

  if (
    typeof commonJs !== "function" ||
    !commonJs("care-pathway.js", "care-*.js") ||
    !commonJs("care-pathway.js", "{care,referral}-*.js") ||
    typeof commonJs.Minimatch !== "function"
  ) {
    throw new Error(`CommonJS compatibility check failed at ${minimatchRoot}`);
  }
  if (
    typeof esm.default !== "function" ||
    !esm.default("care-pathway.js", "care-*.js") ||
    !esm.default("care-pathway.js", "{care,referral}-*.js") ||
    typeof esm.Minimatch !== "function"
  ) {
    throw new Error(`ES module compatibility check failed at ${minimatchRoot}`);
  }
}

console.log(
  `minimatch compatibility ready: ${installedMinimatchRoots.size} package copies verified, ${patchedFiles} files patched`,
);
