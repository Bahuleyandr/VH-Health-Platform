#!/usr/bin/env node

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || value === undefined) {
    console.error('Invalid minimum-version trust validator arguments');
    process.exit(2);
  }
  args.set(name, value);
}

const pairs = [
  {
    label: 'current',
    keyId: args.get('--current-key-id') ?? '',
    publicKey: args.get('--current-public-key') ?? ''
  },
  {
    label: 'next',
    keyId: args.get('--next-key-id') ?? '',
    publicKey: args.get('--next-public-key') ?? ''
  }
];
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const configured = pairs.filter(pair => pair.keyId !== '' || pair.publicKey !== '');

if (configured.length === 0) {
  console.log('patient minimum-version signing trust: HELD (no release keys configured)');
  process.exit(0);
}
if (pairs[0].keyId === '' || pairs[0].publicKey === '') {
  console.error('Current patient minimum-version key id and public key are required together');
  process.exit(1);
}

for (const pair of configured) {
  if (pair.keyId === '' || pair.publicKey === '') {
    console.error(`${pair.label} patient minimum-version key id and public key are required together`);
    process.exit(1);
  }
  if (!keyIdPattern.test(pair.keyId)) {
    console.error(`${pair.label} patient minimum-version key id is invalid`);
    process.exit(1);
  }
  const bytes = Buffer.from(pair.publicKey, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== pair.publicKey) {
    console.error(`${pair.label} patient minimum-version public key must be canonical base64 for 32 Ed25519 bytes`);
    process.exit(1);
  }
}
if (configured.length === 2 && pairs[0].keyId === pairs[1].keyId) {
  console.error('Current and next patient minimum-version key ids must differ');
  process.exit(1);
}

console.log(`patient minimum-version signing trust: ${configured.map(pair => pair.label).join(' + ')}`);
