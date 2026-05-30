import process from 'node:process';
import { run } from './lib.mjs';

export function runSmokeStage() {
  run(process.execPath, ['scripts/qa-orchestrator.mjs', '--include-role', '--include-desktop']);
}

