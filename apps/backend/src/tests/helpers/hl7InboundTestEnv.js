// HL7_INBOUND_ENABLED and HL7_INBOUND_SHARED_SECRET are ONE setting, not two.
//
// `src/utils/validateEnv.js:24-28` makes the secret `required()` the moment the
// flag reads exactly 'true', and that schema is evaluated at import of
// `src/app.js`. A test that declares the interface ON without the secret
// therefore does not fail an assertion — it reaches
// `validateEnv.js:569 process.exit(1)` and takes the whole jest worker with it.
// The suite reports nothing at all: no failure, no test count, just a dead
// worker and a non-zero exit. That is invisible on any Node where the module
// happens to die earlier for an unrelated reason, so it can ship green locally
// and only appear on CI.
//
// Never write `process.env.HL7_INBOUND_ENABLED = 'true'` in a test. Call this
// helper, which sets both halves together. The pairing is pinned by
// `src/tests/unit/hl7InboundEnvPairing.test.js`.

// Test-only value. Production/staging deliver the real secret through a
// SealedSecret (docs/DEPLOYMENT_GUIDE.md#secrets). Length is >= 32 chars
// because validateEnv enforces MIN_KEY_LENGTH on it.
export const HL7_INBOUND_TEST_SHARED_SECRET = 'test-hl7-inbound-shared-secret-32ch';

/**
 * Declare the I03 HTTP-bridge ingress ON for the current test module, with the
 * shared secret that `HL7_INBOUND_ENABLED=true` obliges an operator to have
 * provisioned. Call it at module scope, before importing `src/app.js`.
 *
 * An already-present secret is left alone so a suite that manages its own
 * credential keeps it.
 *
 * @param {{ secret?: string }} [options]
 * @returns {{ enabled: string, secret: string }} the effective pair
 */
export function enableHl7InboundForTest({ secret } = {}) {
  process.env.HL7_INBOUND_ENABLED = 'true';
  if (secret !== undefined) {
    process.env.HL7_INBOUND_SHARED_SECRET = secret;
  } else if (!process.env.HL7_INBOUND_SHARED_SECRET) {
    process.env.HL7_INBOUND_SHARED_SECRET = HL7_INBOUND_TEST_SHARED_SECRET;
  }
  return {
    enabled: process.env.HL7_INBOUND_ENABLED,
    secret: process.env.HL7_INBOUND_SHARED_SECRET,
  };
}

export default { enableHl7InboundForTest, HL7_INBOUND_TEST_SHARED_SECRET };
