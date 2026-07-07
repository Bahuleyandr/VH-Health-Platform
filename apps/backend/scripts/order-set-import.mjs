#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');

dotenv.config({ path: join(backendRoot, '.env.local'), quiet: true });
dotenv.config({ path: join(backendRoot, '.env'), quiet: true });

function usage() {
  return [
    'Usage:',
    '  node scripts/order-set-import.mjs --tenant <uuid> --actor <uid> --file <path> [--role DOCTOR] [--dry-run]',
    '',
    'Imports vh-order-set/1 JSON as a governed draft, or validates it without writing when --dry-run is present.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    role: 'DOCTOR',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (['--tenant', '--actor', '--file', '--role'].includes(token)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${token} requires a value`);
      }
      args[token.slice(2)] = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.tenant || !args.actor || !args.file) {
    throw new Error('Missing required --tenant, --actor, or --file argument');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolve(process.cwd(), args.file);
  const document = JSON.parse(await readFile(filePath, 'utf8'));
  const { importOrderSetDocument } = await import('../src/services/emr/orderSetGovernanceService.js');
  const prismaModule = await import('../src/lib/prisma.js');

  try {
    const result = await importOrderSetDocument({
      tenantId: args.tenant,
      document,
      actor: { uid: args.actor, role: args.role },
      dryRun: args.dryRun,
      sourceFile: filePath,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prismaModule.default.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n\n${usage()}\n`);
  process.exit(1);
});
