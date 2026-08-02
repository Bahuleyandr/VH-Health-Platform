#!/usr/bin/env node
// scripts/codegen.mjs
//
// Dart OpenAPI codegen driver for packages/vhhealth_core, with an explicit
// "dropped operations" report so no path silently disappears from the
// generated chopper client (the codebase's no-silent-truncation convention).
//
// Scope: targets packages/vhhealth_core ONLY — it is the sole workspace member
// with a build.yaml / annotated codegen. (apps/patient declares build_runner as a
// dev-dep but has no build.yaml, so the previous `melos exec --depends-on=build_runner`
// fan-out was a no-op there.) If another member ever gains real codegen, extend
// this driver or restore a melos fan-out.
//
// Why a wrapper instead of calling build_runner directly:
//   The single FHIR bulk-export operation `/api/v1/fhir/Patient/{id}/$everything`
//   cannot be emitted by chopper_generator — the literal `$` is read by Dart as
//   string interpolation inside `@GET(path: '...$everything')`, which throws
//   `FormatException: Not an instance of String` and silently skips writing the
//   whole `openapi.swagger.chopper.dart` file (so `_$Openapi` never resolves and
//   the client does not compile). It is dropped via `exclude_paths` in
//   `packages/vhhealth_core/build.yaml`. `exclude_paths` is a SILENT drop inside
//   the generator, so this script reads those regexes back, matches them against
//   the spec's path keys, and prints exactly what was dropped before running the
//   generator. Documented in docs/API_CODEGEN.md.
//
// Usage:
//   node scripts/codegen.mjs            # report dropped ops, then build
//   node scripts/codegen.mjs --watch    # report, then build_runner watch
//   node scripts/codegen.mjs --report-only   # just print the drop report
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const corePkg = resolve(repoRoot, 'packages', 'vhhealth_core');
const buildYaml = resolve(corePkg, 'build.yaml');
const specPath = resolve(corePkg, 'swagger', 'openapi.json');

const watch = process.argv.includes('--watch');
const reportOnly = process.argv.includes('--report-only');

/**
 * Parse the `exclude_paths:` list out of build.yaml. We avoid pulling in a YAML
 * dependency: the block is a simple flat list of single-quoted regex strings
 * under the `exclude_paths:` key, e.g.
 *   exclude_paths:
 *     - '/api/v1/fhir/Patient/\{id\}/\$everything$'
 */
function readExcludePaths(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*exclude_paths\s*:/.test(l));
  if (idx === -1) return [];
  const keyIndent = lines[idx].match(/^(\s*)/)[1].length;
  const patterns = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    const m = line.match(/^\s*-\s*(.*\S)\s*$/);
    if (indent <= keyIndent || !m) break; // left the list
    let val = m[1].trim();
    // strip surrounding single or double quotes
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1);
    }
    patterns.push(val);
  }
  return patterns;
}

/**
 * Cheap presence check used only to guard the drop report: does build.yaml have a
 * non-empty `exclude_paths` (inline flow list or block entries) regardless of
 * whether readExcludePaths() managed to parse it? Lets us distinguish "no excludes"
 * from "excludes exist but the flat-list parser didn't understand the formatting".
 */
function excludePathsKeyHasEntries(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*exclude_paths\s*:/.test(l));
  if (idx === -1) return false;
  const inline = lines[idx].replace(/^\s*exclude_paths\s*:/, '').trim();
  if (inline && inline !== '[]') return true; // flow style: exclude_paths: ['...']
  const keyIndent = lines[idx].match(/^(\s*)/)[1].length;
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('#')) continue;
    if (lines[i].match(/^(\s*)/)[1].length <= keyIndent) break; // left the block
    if (t.startsWith('-')) return true;
  }
  return false;
}

function reportDroppedPaths() {
  if (!existsSync(buildYaml)) {
    console.error(`✗ build.yaml not found at ${buildYaml}`);
    process.exit(2);
  }
  if (!existsSync(specPath)) {
    console.error(`✗ openapi.json not found at ${specPath}`);
    process.exit(2);
  }
  const yamlText = readFileSync(buildYaml, 'utf8');
  const patterns = readExcludePaths(yamlText);
  if (patterns.length === 0) {
    // The parser only understands block-style lists. If build.yaml is ever
    // reformatted (flow list / block scalar) it could return [] while excludes
    // actually exist — which would make this report falsely claim "every path
    // generated". Warn loudly rather than mislead. The build itself is unaffected:
    // the Dart generator reads the real YAML, not this parser.
    if (excludePathsKeyHasEntries(yamlText)) {
      console.warn(
        '[codegen] ⚠ build.yaml has a non-empty exclude_paths but the flat-list parser extracted 0 patterns — ' +
          'the drop report is unreliable (the build is unaffected). Update readExcludePaths() to match the new formatting.',
      );
    } else {
      console.log('[codegen] exclude_paths: (none) — every spec path is generated.');
    }
    return;
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const allPaths = Object.keys(spec.paths ?? {});
  const compiled = patterns.map((p) => ({ src: p, re: new RegExp(p) }));

  const dropped = [];
  for (const path of allPaths) {
    for (const { src, re } of compiled) {
      if (re.test(path)) {
        dropped.push({ path, pattern: src });
        break;
      }
    }
  }

  console.log(
    `[codegen] exclude_paths active (${patterns.length} regex${patterns.length === 1 ? '' : 'es'}) — ` +
      `${dropped.length} of ${allPaths.length} spec paths dropped from the Dart client:`,
  );
  if (dropped.length === 0) {
    console.log(
      '  (no spec path currently matches — exclude_paths may be stale; see docs/API_CODEGEN.md)',
    );
  }
  for (const { path, pattern } of dropped) {
    console.log(`  - DROPPED  ${path}   (matched ${pattern})`);
  }
  console.log(
    '[codegen] These operations are intentionally absent from the generated chopper client. ' +
      'See docs/API_CODEGEN.md for the rationale (FHIR $everything cannot be emitted by chopper_generator).',
  );
}

reportDroppedPaths();
if (reportOnly) process.exit(0);

const useShell = process.platform === 'win32';
// NOTE: do NOT add --delete-conflicting-outputs. The build_runner version pinned
// in pubspec.lock has REMOVED that flag (auto-deleting conflicting outputs is now
// the default) — passing it only prints a "removed and were ignored" warning,
// which is log noise and a hazard if CI is warning-strict. Verified empirically:
// a non-clean regen (existing lib/api/generated/) rebuilds cleanly without it.
//
// NOTE: apps/staff/Dockerfile.web reproduces this exact invocation inline
// (`RUN dart run build_runner build` in packages/vhhealth_core) because that
// image has neither melos nor Node to run this driver. If the args below
// change, update that Dockerfile too.
const args = ['run', 'build_runner', watch ? 'watch' : 'build'];
console.log(`\n[codegen] running: dart ${args.join(' ')}  (cwd: packages/vhhealth_core)`);
const result = spawnSync('dart', args, {
  cwd: corePkg,
  stdio: 'inherit',
  shell: useShell,
});
process.exit(result.status ?? 1);
