#!/usr/bin/env node
// scripts/codegen.mjs
//
// Dart OpenAPI codegen driver for packages/vhhealth_core, with an explicit
// "dropped operations" report so no path silently disappears from the
// generated chopper client (the codebase's no-silent-truncation convention).
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

function reportDroppedPaths() {
  if (!existsSync(buildYaml)) {
    console.error(`✗ build.yaml not found at ${buildYaml}`);
    process.exit(2);
  }
  if (!existsSync(specPath)) {
    console.error(`✗ openapi.json not found at ${specPath}`);
    process.exit(2);
  }
  const patterns = readExcludePaths(readFileSync(buildYaml, 'utf8'));
  if (patterns.length === 0) {
    console.log('[codegen] exclude_paths: (none) — every spec path is generated.');
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
const args = ['run', 'build_runner', watch ? 'watch' : 'build'];
console.log(`\n[codegen] running: dart ${args.join(' ')}  (cwd: packages/vhhealth_core)`);
const result = spawnSync('dart', args, {
  cwd: corePkg,
  stdio: 'inherit',
  shell: useShell,
});
process.exit(result.status ?? 1);
