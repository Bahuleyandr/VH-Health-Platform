import { run } from './lib.mjs';

export function runFlutterStage() {
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
}
