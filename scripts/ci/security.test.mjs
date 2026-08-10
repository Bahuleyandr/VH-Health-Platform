import assert from 'node:assert/strict';
import test from 'node:test';

import { requireSemgrepAvailability } from './security.mjs';

test('missing Semgrep fails closed in CI', () => {
  assert.throws(
    () => requireSemgrepAvailability(false, { env: { CI: 'true' }, log: () => {} }),
    /Semgrep is required in CI/,
  );
});

test('missing Semgrep remains an explicit local-development skip', () => {
  const messages = [];
  assert.equal(
    requireSemgrepAvailability(false, {
      env: {},
      log: (message) => messages.push(message),
    }),
    false,
  );
  assert.match(messages.join('\n'), /semgrep not found/i);
});
