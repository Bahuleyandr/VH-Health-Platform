#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_TENANT_ID,
  makeEvidenceTemplate,
} from './indiaDeployabilityControls.mjs';

const args = parseArgs(process.argv.slice(2));
const template = makeEvidenceTemplate({ tenantId: args.tenantId });
const payload = `${JSON.stringify(template, null, 2)}\n`;

if (args.output) {
  const target = path.resolve(args.output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, payload, 'utf8');
  console.log(`Wrote India evidence template: ${target}`);
} else {
  process.stdout.write(payload);
}

function parseArgs(argv) {
  const parsed = {
    tenantId: DEFAULT_TENANT_ID,
    output: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant-id') parsed.tenantId = argv[++i] || parsed.tenantId;
    else if (arg.startsWith('--tenant-id=')) parsed.tenantId = arg.slice('--tenant-id='.length);
    else if (arg === '--output') parsed.output = argv[++i] || null;
    else if (arg.startsWith('--output=')) parsed.output = arg.slice('--output='.length);
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.tenantId)) {
    throw new Error(`Invalid --tenant-id UUID: ${parsed.tenantId}`);
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node apps/backend/scripts/india-evidence-template.mjs [options]

Options:
  --tenant-id <uuid>      Tenant to template. Defaults to the platform default tenant.
  --output <path>         Write JSON to a file instead of stdout.
`);
}
