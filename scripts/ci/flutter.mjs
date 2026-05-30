import { run } from './lib.mjs';

export function runFlutterStage() {
  run('dart', ['pub', 'get']);
  run('dart', ['run', 'melos', 'bootstrap']);
  run('dart', ['run', 'melos', 'run', 'format']);
  run('dart', ['run', 'melos', 'run', 'analyze']);
  run('dart', ['run', 'melos', 'run', 'test']);
}

