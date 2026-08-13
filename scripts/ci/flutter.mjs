import { join } from 'node:path';

import { repoRoot, run } from './lib.mjs';

export function runFlutterStage() {
  // First, and intentionally so: a pure-Node file compare (~5ms, no toolchain)
  // that fails if a guarded doc states a plugin version the pubspecs contradict.
  // Cheapest possible gate in front of the most expensive stage — no reason to
  // spend pub get + bootstrap + analyze + test + dart2js to then report a stale
  // markdown table. Mirrors the "Docs plugin-version drift" step in
  // .github/workflows/_reusable-flutter-workspace.yml.
  run(process.execPath, ['--test', 'scripts/check-docs-plugin-versions.test.mjs']);
  run(process.execPath, ['scripts/check-docs-plugin-versions.mjs']);
  run(process.execPath, ['scripts/generate-vital-bounds.mjs', '--check']);
  run(process.execPath, ['scripts/generate-staff-role-contract.mjs', '--check']);

  run('dart', ['pub', 'get']);
  run('dart', ['run', 'melos', 'bootstrap']);
  run('node', ['scripts/dart-format-check.mjs']);
  // Regenerate the gitignored Dart client BEFORE analyze/test: the barrel,
  // VHAuthInterceptor, and the compose test import generated symbols that are
  // absent on a fresh clone (lib/api/generated/** is gitignored). Runs after the
  // format check so format only sees hand-written code. Mirrors the GitHub
  // _reusable-flutter-workspace.yml codegen gate (OpenAPI Phase 4).
  run('node', ['scripts/codegen.mjs']);
  run('dart', ['run', 'melos', 'exec', '--', 'flutter analyze --no-fatal-infos']);
  run('dart', ['run', 'melos', 'exec', '--dir-exists=test', '--', 'flutter test']);
  // Web compile last: analyze/test are cheaper and localize a fault better, so
  // let them fail first. dart2js applies JS number semantics the VM does not —
  // an int literal above 2^53 or a web-unimplemented import passes everything
  // above and breaks only here (the #691 governance-ceiling class). This is the
  // Forgejo/canonical half of the gate that .github/workflows/
  // _reusable-flutter-workspace.yml's web-build job provides on GitHub PRs:
  // .forgejo/workflows/ci.yml and full-stack-sweep.yml have no Flutter YAML of
  // their own, they invoke this stage, so parity lives here. Same precedent as
  // cc7e270db, which gave Forgejo the codegen step by editing only this file.
  // Staff only — apps/patient has no real web target (see the web-build job
  // comment for the evidence); vhhealth_core is covered either way because both
  // apps import it through the same barrel. --debug still runs dart2js, just
  // unoptimized.
  run('flutter', ['build', 'web', '--debug'], { cwd: join(repoRoot, 'apps', 'staff') });
}
