import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import prisma from '../src/lib/prisma.js';
import {
  createContinuityEdgeGrant,
  exportContinuityEdgeGrantSet,
  revokeContinuityEdgeGrant
} from '../src/services/downtime/continuityEdgeAccessService.js';
import { canonicalizeJson } from '../src/services/downtime/continuityPackCanonical.js';

const VALUE_FLAGS = new Set([
  'actor',
  'certificate',
  'device',
  'facility',
  'grant',
  'location',
  'location-type',
  'out',
  'policy-id',
  'policy-version',
  'reason',
  'staff',
  'tenant',
  'valid-from',
  'valid-until'
]);
const COMMAND_FLAGS = Object.freeze({
  grant: new Set([
    'actor',
    'certificate',
    'device',
    'facility',
    'location',
    'location-type',
    'policy-id',
    'policy-version',
    'staff',
    'tenant',
    'valid-from',
    'valid-until'
  ]),
  renew: new Set([
    'actor',
    'certificate',
    'device',
    'facility',
    'location',
    'location-type',
    'policy-id',
    'policy-version',
    'staff',
    'tenant',
    'valid-from',
    'valid-until'
  ]),
  revoke: new Set(['actor', 'facility', 'grant', 'reason', 'tenant']),
  export: new Set(['facility', 'out', 'tenant'])
});

export function parseArgs(argv) {
  const command = argv[0];
  if (!['grant', 'renew', 'revoke', 'export'].includes(command)) {
    throw new Error('command must be grant, renew, revoke, or export');
  }
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!VALUE_FLAGS.has(name)) throw new Error(`unsupported flag: --${name}`);
    if (!COMMAND_FLAGS[command].has(name)) {
      throw new Error(`--${name} is not supported by ${command}`);
    }
    if (Object.hasOwn(options, name)) throw new Error(`duplicate flag: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function required(options, names) {
  for (const name of names) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
}

async function grant(options) {
  required(options, [
    'actor',
    'certificate',
    'device',
    'facility',
    'location',
    'location-type',
    'policy-id',
    'policy-version',
    'staff',
    'tenant',
    'valid-from',
    'valid-until'
  ]);
  const certificatePem = await fs.readFile(path.resolve(options.certificate), 'utf8');
  return createContinuityEdgeGrant({
    tenantId: options.tenant,
    facilityId: options.facility,
    locationType: options['location-type'],
    locationIdentifier: options.location,
    staffUid: options.staff,
    deviceId: options.device,
    certificatePem,
    validFrom: options['valid-from'],
    validUntil: options['valid-until'],
    policyVersionId: options['policy-id'],
    policyVersion: options['policy-version'],
    createdBy: options.actor
  });
}

async function revoke(options) {
  required(options, ['actor', 'facility', 'grant', 'reason', 'tenant']);
  return revokeContinuityEdgeGrant({
    tenantId: options.tenant,
    facilityId: options.facility,
    grantId: options.grant,
    revokedBy: options.actor,
    reason: options.reason
  });
}

async function exportGrantSet(options) {
  required(options, ['facility', 'out', 'tenant']);
  const grantSet = await exportContinuityEdgeGrantSet({
    tenantId: options.tenant,
    facilityId: options.facility
  });
  const outputPath = path.resolve(options.out);
  await fs.writeFile(outputPath, `${canonicalizeJson(grantSet)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
  return { outputPath, accessRevision: grantSet.accessRevision };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let result;
  if (options.command === 'grant' || options.command === 'renew') {
    result = await grant(options);
  } else if (options.command === 'revoke') {
    result = await revoke(options);
  } else {
    result = await exportGrantSet(options);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.code || 'CONTINUITY_EDGE_CLI_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}
