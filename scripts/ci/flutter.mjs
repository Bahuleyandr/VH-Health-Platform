import { run } from './lib.mjs';

export function runFlutterStage() {
  run('dart', ['pub', 'get']);
  run('dart', ['run', 'melos', 'bootstrap']);
  run('node', ['scripts/dart-format-check.mjs']);
  run('dart', ['run', 'melos', 'exec', '--', 'flutter analyze --no-fatal-infos']);
  run('dart', ['run', 'melos', 'exec', '--dir-exists=test', '--', 'flutter test']);
}
