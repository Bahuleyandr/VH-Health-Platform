#!/usr/bin/env node
// Generates the TEST-ONLY logging certificate fixture the audit-log and
// gateway-integration suites read from test/fixtures/test-only-logging-cert.pem.
//
// The matching Ed25519 private key is a public constant committed in
// test/helpers/test-identity.mjs — it exists purely so signatures in tests are
// deterministic to reason about. The certificate is therefore public test
// material too, but `.gitignore` blanket-ignores `**/*.pem`, so the fixture
// cannot be committed and must be (re)generated before the suites run. CI and
// the package's `pretest` hook both call this script; it is idempotent and
// skips regeneration while the existing fixture still matches the key and has
// comfortable validity left.
//
// Requires the `openssl` CLI (present on the GitHub runners and virtually
// every dev machine) because node:crypto can verify but not mint X.509.
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const helpersDir = path.resolve(import.meta.dirname, '..', 'test', 'helpers');
const { installTestPrivateKey, testCertificatePath } = await import(
  path.join(helpersDir, 'test-identity.mjs')
);

const MIN_REMAINING_VALIDITY_MS = 24 * 60 * 60 * 1000;

function existingCertificateIsUsable(privateKeyPem) {
  let certificate;
  try {
    certificate = new X509Certificate(readFileSync(testCertificatePath));
  } catch {
    return false;
  }
  if (Date.parse(certificate.validTo) - Date.now() < MIN_REMAINING_VALIDITY_MS) return false;
  if (certificate.publicKey.asymmetricKeyType !== 'ed25519') return false;
  const challenge = Buffer.from('ensure-test-certificate-keymatch');
  const signature = sign(null, challenge, createPrivateKey(privateKeyPem));
  return verify(null, challenge, certificate.publicKey, signature);
}

const workDir = mkdtempSync(path.join(os.tmpdir(), 'vh-edge-test-cert-'));
try {
  const privateKeyPath = await installTestPrivateKey(workDir);
  const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
  if (existingCertificateIsUsable(privateKeyPem)) {
    console.log(`[ensure-test-certificate] fixture OK: ${testCertificatePath}`);
  } else {
    const pem = execFileSync('openssl', [
      'req', '-new', '-x509',
      '-key', privateKeyPath,
      '-days', '3650',
      '-subj', '/CN=vhhealth-continuity-edge-test-only-logging',
    ], { encoding: 'utf8' });
    writeFileSync(testCertificatePath, pem, { mode: 0o644 });
    console.log(`[ensure-test-certificate] generated ${testCertificatePath}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
