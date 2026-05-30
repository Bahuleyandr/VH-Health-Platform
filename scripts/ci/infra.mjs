import process from 'node:process';
import { run } from './lib.mjs';

export function runInfraStage() {
  run(process.execPath, ['scripts/validate-kubernetes-manifests.mjs']);
}

