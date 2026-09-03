import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MINIMATCH_VERSION = '10.2.5';
const TEST_EXCLUDE_VERSION = '6.0.0';
const packageRoot = process.cwd();
const nodeModulesRoot = path.resolve(packageRoot, 'node_modules');
const omittedDependencyTypes = new Set(
  (process.env.npm_config_omit ?? process.env.NPM_CONFIG_OMIT ?? '').split(/[\s,]+/).filter(Boolean)
);
const devDependenciesOmitted = omittedDependencyTypes.has('dev');
const packageLock = JSON.parse(await readFile(path.join(packageRoot, 'package-lock.json'), 'utf8'));

const minimatchPackages = Object.entries(packageLock.packages)
  .filter(
    ([packagePath, metadata]) =>
      packagePath.endsWith('node_modules/minimatch') && metadata.version === MINIMATCH_VERSION
  )
  .map(([packagePath]) => {
    if (packagePath.includes('..') || !packagePath.startsWith('node_modules/')) {
      throw new Error(`Unsafe minimatch lockfile path: ${packagePath}`);
    }

    const resolved = path.resolve(packageRoot, ...packagePath.split('/'));
    if (!resolved.startsWith(`${nodeModulesRoot}${path.sep}`)) {
      throw new Error(`Minimatch path escaped node_modules: ${packagePath}`);
    }
    return resolved;
  });

if (minimatchPackages.length === 0) {
  throw new Error(`No minimatch@${MINIMATCH_VERSION} installation was found to patch`);
}

const patches = [
  {
    relativePath: 'dist/commonjs/index.js',
    anchor: 'exports.minimatch.unescape = unescape_js_1.unescape;\n',
    addition:
      'Object.assign(exports.minimatch, exports);\n' + 'module.exports = exports.minimatch;\n'
  },
  {
    relativePath: 'dist/esm/index.js',
    anchor: 'minimatch.unescape = unescape;\n',
    addition: 'export default minimatch;\n'
  },
  {
    relativePath: 'dist/commonjs/index.d.ts',
    anchor: "export { unescape } from './unescape.js';\n",
    addition: 'export default minimatch;\n'
  },
  {
    relativePath: 'dist/esm/index.d.ts',
    anchor: "export { unescape } from './unescape.js';\n",
    addition: 'export default minimatch;\n'
  }
];

async function assertContainedPatchTarget(canonicalPackageRoot, target) {
  const targetStat = await lstat(target);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`Refusing to patch non-regular file at ${target}`);
  }

  const canonicalTarget = await realpath(target);
  const relativeTarget = path.relative(canonicalPackageRoot, canonicalTarget);
  if (
    relativeTarget === '' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(`Patch target escaped package root: ${target}`);
  }
}

let patchedFiles = 0;
const installedMinimatchRoots = new Set();

for (const minimatchRoot of new Set(minimatchPackages)) {
  let rootStat;
  try {
    rootStat = await lstat(minimatchRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
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

  const metadata = JSON.parse(await readFile(path.join(minimatchRoot, 'package.json'), 'utf8'));

  if (metadata.name !== 'minimatch' || metadata.version !== MINIMATCH_VERSION) {
    throw new Error(`Refusing to patch unexpected package at ${minimatchRoot}`);
  }
  installedMinimatchRoots.add(minimatchRoot);

  for (const patch of patches) {
    const target = path.join(minimatchRoot, ...patch.relativePath.split('/'));
    await assertContainedPatchTarget(canonicalRoot, target);
    const source = await readFile(target, 'utf8');

    if (source.includes(patch.addition)) {
      continue;
    }
    if (!source.includes(patch.anchor)) {
      throw new Error(`Compatibility anchor missing in ${target}`);
    }

    await writeFile(target, source.replace(patch.anchor, patch.anchor + patch.addition), 'utf8');
    patchedFiles += 1;
  }
}

if (installedMinimatchRoots.size === 0) {
  throw new Error(`No installed minimatch@${MINIMATCH_VERSION} package was found to patch`);
}

const testExcludeLock = packageLock.packages['node_modules/test-exclude'];
if (testExcludeLock?.version !== TEST_EXCLUDE_VERSION) {
  throw new Error(`Expected test-exclude@${TEST_EXCLUDE_VERSION} in the package lock`);
}

let testExcludeWin32Path;
const testExcludeRoot = path.join(nodeModulesRoot, 'test-exclude');
let testExcludeStat;
try {
  testExcludeStat = await lstat(testExcludeRoot);
} catch (error) {
  if (error?.code !== 'ENOENT' || testExcludeLock.dev !== true || !devDependenciesOmitted) {
    throw error;
  }
}

if (testExcludeStat !== undefined) {
  if (testExcludeStat.isSymbolicLink()) {
    throw new Error(`Refusing to patch symlinked package at ${testExcludeRoot}`);
  }

  const canonicalTestExcludeRoot = await realpath(testExcludeRoot);
  if (!canonicalTestExcludeRoot.startsWith(`${nodeModulesRoot}${path.sep}`)) {
    throw new Error(`test-exclude package escaped node_modules: ${testExcludeRoot}`);
  }

  const testExcludeMetadata = JSON.parse(
    await readFile(path.join(testExcludeRoot, 'package.json'), 'utf8')
  );
  if (
    testExcludeMetadata.name !== 'test-exclude' ||
    testExcludeMetadata.version !== TEST_EXCLUDE_VERSION
  ) {
    throw new Error(`Refusing to patch unexpected package at ${testExcludeRoot}`);
  }

  testExcludeWin32Path = path.join(testExcludeRoot, 'is-outside-dir-win32.js');
  await assertContainedPatchTarget(canonicalTestExcludeRoot, testExcludeWin32Path);
  const testExcludeWin32Source = await readFile(testExcludeWin32Path, 'utf8');
  const testExcludeAnchor = 'const dot = { dot: true };';
  const testExcludeReplacement = 'const dot = { dot: true, windowsPathsNoEscape: true };';
  if (!testExcludeWin32Source.includes(testExcludeReplacement)) {
    if (!testExcludeWin32Source.includes(testExcludeAnchor)) {
      throw new Error(`Compatibility anchor missing in ${testExcludeWin32Path}`);
    }
    await writeFile(
      testExcludeWin32Path,
      testExcludeWin32Source.replace(testExcludeAnchor, testExcludeReplacement),
      'utf8'
    );
    patchedFiles += 1;
  }
}

const localRequire = createRequire(import.meta.url);

for (const minimatchRoot of installedMinimatchRoots) {
  const commonJs = localRequire(minimatchRoot);
  const esm = await import(pathToFileURL(path.join(minimatchRoot, 'dist/esm/index.js')));

  if (
    typeof commonJs !== 'function' ||
    !commonJs('care-pathway.js', 'care-*.js') ||
    !commonJs('care-pathway.js', '{care,referral}-*.js') ||
    typeof commonJs.Minimatch !== 'function'
  ) {
    throw new Error(`CommonJS compatibility check failed at ${minimatchRoot}`);
  }
  if (
    typeof esm.default !== 'function' ||
    !esm.default('care-pathway.js', 'care-*.js') ||
    !esm.default('care-pathway.js', '{care,referral}-*.js') ||
    typeof esm.Minimatch !== 'function'
  ) {
    throw new Error(`ES module compatibility check failed at ${minimatchRoot}`);
  }
}

if (testExcludeWin32Path !== undefined) {
  const isOutsideDirWin32 = localRequire(testExcludeWin32Path);
  const insidePath = path.join(packageRoot, 'src', 'app.js');
  const outsidePath = path.resolve(packageRoot, '..', 'outside.js');
  if (isOutsideDirWin32(packageRoot, insidePath) || !isOutsideDirWin32(packageRoot, outsidePath)) {
    throw new Error('test-exclude Windows path compatibility check failed');
  }
}

const testExcludeStatus =
  testExcludeWin32Path === undefined
    ? 'test-exclude omitted with dev dependencies'
    : 'test-exclude verified';
console.log(
  `minimatch compatibility ready: ${installedMinimatchRoots.size} package copies and ${testExcludeStatus}, ${patchedFiles} files patched`
);
