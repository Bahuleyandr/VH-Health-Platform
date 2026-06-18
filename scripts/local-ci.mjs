#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

// Force Python utf-8 mode for child tools (e.g. semgrep). On Windows, Python's
// default locale codec (cp1252) raises UnicodeDecodeError reading utf-8 config /
// target files (an em-dash in .semgrep.yml, non-ASCII in scanned source), which
// crashes the security stage. utf-8 mode is the portable default — Linux Python
// already uses it — so this makes the local gate pass on Windows too.
process.env.PYTHONUTF8 ||= '1';

const result = spawnSync(process.execPath, ['scripts/ci/run.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
