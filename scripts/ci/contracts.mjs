import process from 'node:process';
import { run } from './lib.mjs';

/**
 * Cross-stack contract checks: assertions that span more than one app and so
 * belong to no single stage. Dependency-free and a few seconds long, so this
 * runs early — a broken client/server contract should surface before the
 * multi-minute backend and Flutter stages.
 */
export function runContractsStage() {
  run(process.execPath, ['--test', 'scripts/ci/check-client-paths.test.mjs']);
  run(process.execPath, ['scripts/ci/check-client-paths.mjs', '--verbose']);
}
