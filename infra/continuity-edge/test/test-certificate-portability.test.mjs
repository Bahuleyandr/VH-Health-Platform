import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign, verify, X509Certificate } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installTestPrivateKey } from './helpers/test-identity.mjs';

const edgeRoot = path.resolve(import.meta.dirname, '..');
const minimumValidity = 24 * 60 * 60 * 1000;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vh edge #cert %-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = path.join(root, 'tools');
  const helpers = path.join(root, 'test', 'helpers');
  const fixtures = path.join(root, 'test', 'fixtures');
  await Promise.all([tools, helpers, fixtures].map(directory => mkdir(directory, { recursive: true })));
  const script = path.join(tools, 'ensure-test-certificate.mjs');
  await Promise.all([
    copyFile(path.join(edgeRoot, 'tools', 'ensure-test-certificate.mjs'), script),
    copyFile(path.join(edgeRoot, 'test', 'helpers', 'test-identity.mjs'), path.join(helpers, 'test-identity.mjs')),
  ]);
  return {
    root,
    script,
    certificate: path.join(fixtures, 'test-only-logging-cert.pem'),
  };
}

function runBootstrap(state) {
  const result = spawnSync(process.execPath, [state.script], {
    cwd: state.root,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function assertUsableCertificate(state) {
  const certificate = new X509Certificate(await readFile(state.certificate));
  assert.equal(certificate.publicKey.asymmetricKeyType, 'ed25519');
  assert.ok(Date.parse(certificate.validTo) - Date.now() >= minimumValidity);
  const keyPath = await installTestPrivateKey(path.join(state.root, 'key-check'));
  const challenge = Buffer.from('portable-test-certificate-keymatch');
  const signature = sign(null, challenge, createPrivateKey(await readFile(keyPath)));
  assert.equal(verify(null, challenge, certificate.publicKey, signature), true);
}

async function certificateForKey(state, keyPath, days) {
  const pem = execFileSync('openssl', [
    'req', '-new', '-x509',
    '-key', keyPath,
    '-days', String(days),
    '-subj', '/CN=vhhealth-continuity-edge-test-only-portability',
  ], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  await writeFile(state.certificate, pem);
}

test('test certificate bootstrap works from paths containing spaces and URL delimiters', async t => {
  const state = await fixture(t);
  assert.match(runBootstrap(state), /\[ensure-test-certificate\] generated /);
  await assertUsableCertificate(state);
});

test('a usable public test certificate is reused without rewriting it', async t => {
  const state = await fixture(t);
  assert.match(runBootstrap(state), /\[ensure-test-certificate\] generated /);
  const before = await readFile(state.certificate);
  assert.match(runBootstrap(state), /\[ensure-test-certificate\] fixture OK: /);
  assert.deepEqual(await readFile(state.certificate), before);
  await assertUsableCertificate(state);
});

test('a malformed test certificate is regenerated', async t => {
  const state = await fixture(t);
  await writeFile(state.certificate, 'not a certificate\n');
  assert.match(runBootstrap(state), /\[ensure-test-certificate\] generated /);
  await assertUsableCertificate(state);
});

test('a test certificate with less than a day remaining is regenerated', async t => {
  const state = await fixture(t);
  const keyPath = await installTestPrivateKey(path.join(state.root, 'seed-key'));
  await certificateForKey(state, keyPath, 1);
  const before = await readFile(state.certificate);
  assert.ok(Date.parse(new X509Certificate(before).validTo) - Date.now() < minimumValidity);
  assert.match(runBootstrap(state), /\[ensure-test-certificate\] generated /);
  assert.notDeepEqual(await readFile(state.certificate), before);
  await assertUsableCertificate(state);
});

test('a test certificate for a different Ed25519 key is regenerated', async t => {
  const state = await fixture(t);
  const keyPath = path.join(state.root, 'different-test-key.pem');
  const { privateKey } = generateKeyPairSync('ed25519');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await certificateForKey(state, keyPath, 3650);
  const before = await readFile(state.certificate);
  assert.match(runBootstrap(state), /\[ensure-test-certificate\] generated /);
  assert.notDeepEqual(await readFile(state.certificate), before);
  await assertUsableCertificate(state);
});
