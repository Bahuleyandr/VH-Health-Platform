#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { patientMinimumVersionPolicyFromEnv } from '../src/services/patientMinimumVersionPolicy.js';
import { createSignedPatientMinimumVersionPolicy } from '../src/services/patientMinimumVersionPolicySigner.js';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || value === undefined) {
    fail('Arguments must be supplied as --name value pairs');
  }
  args.set(name, value);
}

const required = [
  '--private-key',
  '--key-id',
  '--tenant-id',
  '--revision',
  '--minimum',
  '--issued-at',
  '--grace-until'
];
for (const name of required) {
  if (!args.get(name)) fail(`${name} is required`);
}

const revision = exactNonNegativeInteger(args.get('--revision'));
const minimum = exactNonNegativeInteger(args.get('--minimum'));
if (revision === null || revision === 0) fail('--revision must be a positive safe integer');
if (minimum === null) fail('--minimum must be a non-negative safe integer');

let privateKey;
try {
  privateKey = readFileSync(args.get('--private-key'), 'utf8');
} catch {
  fail('--private-key must name a readable operator-owned Ed25519 PEM file');
}

let envelope;
try {
  envelope = createSignedPatientMinimumVersionPolicy(
    {
      keyId: args.get('--key-id'),
      tenantId: args.get('--tenant-id'),
      revision,
      minPatientVersionCode: minimum,
      issuedAt: args.get('--issued-at'),
      graceUntil: args.get('--grace-until')
    },
    privateKey
  );
} catch {
  fail('--private-key must contain a valid Ed25519 private key');
}
if (patientMinimumVersionPolicyFromEnv(JSON.stringify(envelope), envelope.policy.tenant_id) === null) {
  fail('Policy fields do not satisfy the bounded patient minimum-version contract');
}

process.stdout.write(`${JSON.stringify(envelope)}\n`);

function exactNonNegativeInteger(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value ?? '')) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
