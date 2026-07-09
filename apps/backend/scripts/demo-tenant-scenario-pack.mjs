#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DEMO_SCENARIO_DATE,
  DEFAULT_DEMO_TENANT_ID,
  DEFAULT_DEMO_TENANT_SLUG,
  assertLocalOnlyDatabaseUrl,
  buildDemoTenantScenarioPack,
} from '../src/services/demo/demoTenantScenarioPackService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUTPUT_ROOT = path.resolve(REPO_ROOT, 'output');
const KNOWN_ARTIFACTS = [
  'demo-ledger.json',
  'demo-ledger.md',
  'demo-tour-anchors.json',
];

function parseArgs(argv) {
  const options = {
    tenantId: process.env.npm_config_tenant_id || DEFAULT_DEMO_TENANT_ID,
    tenantSlug: process.env.npm_config_tenant_slug || DEFAULT_DEMO_TENANT_SLUG,
    tenantName: process.env.npm_config_tenant_name || undefined,
    scenarioDate: process.env.npm_config_scenario_date || DEFAULT_DEMO_SCENARIO_DATE,
    seed: process.env.npm_config_seed || 'nl11-s06-demo-pack',
    packId: process.env.npm_config_pack_id || 'sales-core',
    outDir: process.env.npm_config_out_dir || null,
    reset: process.env.npm_config_reset === 'true',
    json: false,
    help: false,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--reset') options.reset = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--tenant-id=')) options.tenantId = arg.split('=').slice(1).join('=');
    else if (arg === '--tenant-id') options.tenantId = next();
    else if (arg.startsWith('--tenant-slug=')) options.tenantSlug = arg.split('=').slice(1).join('=');
    else if (arg === '--tenant-slug') options.tenantSlug = next();
    else if (arg.startsWith('--tenant-name=')) options.tenantName = arg.split('=').slice(1).join('=');
    else if (arg === '--tenant-name') options.tenantName = next();
    else if (arg.startsWith('--scenario-date=')) options.scenarioDate = arg.split('=').slice(1).join('=');
    else if (arg === '--scenario-date') options.scenarioDate = next();
    else if (arg.startsWith('--seed=')) options.seed = arg.split('=').slice(1).join('=');
    else if (arg === '--seed') options.seed = next();
    else if (arg.startsWith('--pack-id=')) options.packId = arg.split('=').slice(1).join('=');
    else if (arg === '--pack-id') options.packId = next();
    else if (arg.startsWith('--out-dir=')) options.outDir = arg.split('=').slice(1).join('=');
    else if (arg === '--out-dir') options.outDir = next();
    else if (!arg.startsWith('-')) positionals.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (positionals[0]) options.tenantSlug = positionals[0];
  if (positionals[1]) options.outDir = positionals[1];
  return options;
}

function usage() {
  return [
    'Usage: node apps/backend/scripts/demo-tenant-scenario-pack.mjs [options]',
    '',
    'Options:',
    '  --tenant-slug <slug>       Demo tenant slug (default: vh-demo)',
    '  --tenant-id <uuid>         Demo tenant UUID used in the ledger',
    '  --tenant-name <name>       Demo tenant display name',
    '  --scenario-date <date>     Deterministic scenario date (default: 2026-07-07)',
    '  --seed <seed>              Deterministic replay seed',
    '  --pack-id <id>             Scenario pack id (default: sales-core)',
    '  --out-dir <path>           Output directory under output/',
    '  --reset                    Remove this script family artifacts before writing',
    '  --json                     Print the ledger JSON to stdout',
  ].join('\n');
}

function resolveOutputDir(options) {
  const relative = options.outDir || path.join('output', 'demo-tenant', options.tenantSlug);
  const resolved = path.resolve(REPO_ROOT, relative);
  if (resolved !== OUTPUT_ROOT && !resolved.startsWith(`${OUTPUT_ROOT}${path.sep}`)) {
    throw new Error(`Output directory must stay under ${OUTPUT_ROOT}`);
  }
  return resolved;
}

async function resetKnownArtifacts(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all(
    KNOWN_ARTIFACTS.map((fileName) => fs.rm(path.join(outputDir, fileName), { force: true }))
  );
}

function renderMarkdown(pack, databaseContext) {
  const counts = {
    personas: pack.personas.length,
    patients: pack.patients.length,
    journeys: pack.journeys.length,
    tourAnchors: pack.tourAnchors.length,
    ledgerEntries: pack.buildLedger.length,
  };
  return [
    `# ${pack.packId} Demo-Tenant Scenario Pack`,
    '',
    `- Schema: ${pack.schemaVersion}`,
    `- Seed tag: ${pack.seedTag}`,
    `- Tenant: ${pack.tenant.slug} (${pack.tenant.id})`,
    `- Replay key: ${pack.determinism.replayKey}`,
    `- Pack fingerprint: ${pack.packFingerprint}`,
    `- Final fingerprint: ${pack.finalFingerprint}`,
    `- Local guard: ${databaseContext.host}/${databaseContext.database}`,
    `- Counts: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    `- Generated-login smoke: ${pack.generatedLoginSmoke.status} (${pack.generatedLoginSmoke.checkedPersonas} personas)`,
    `- No-PHI scan: ${pack.contentSafety.status}`,
    '',
    '## Journeys',
    '',
    ...pack.journeys.map((journey) => `- ${journey.title}: ${journey.salesStory}`),
    '',
    '## Safe Reset',
    '',
    ...pack.safeReset.preflight.map((line) => `- ${line}`),
    '',
  ].join('\n');
}

async function writeArtifacts(outputDir, pack, databaseContext) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'demo-ledger.json'), `${JSON.stringify(pack, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'demo-ledger.md'), renderMarkdown(pack, databaseContext));
  await fs.writeFile(
    path.join(outputDir, 'demo-tour-anchors.json'),
    `${JSON.stringify(pack.tourAnchors, null, 2)}\n`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const databaseContext = assertLocalOnlyDatabaseUrl(
    process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  );
  const outputDir = resolveOutputDir(options);
  if (options.reset) await resetKnownArtifacts(outputDir);

  const pack = buildDemoTenantScenarioPack(options);
  await writeArtifacts(outputDir, pack, databaseContext);

  if (options.json) {
    console.log(JSON.stringify(pack, null, 2));
    return;
  }

  console.log(
    JSON.stringify(
      {
        script: 'demo-tenant-scenario-pack',
        status: 'ready',
        outputDir,
        packFingerprint: pack.packFingerprint,
        finalFingerprint: pack.finalFingerprint,
        generatedLoginSmoke: pack.generatedLoginSmoke.status,
        contentSafety: pack.contentSafety.status,
        counts: {
          personas: pack.personas.length,
          patients: pack.patients.length,
          journeys: pack.journeys.length,
          tourAnchors: pack.tourAnchors.length,
          ledgerEntries: pack.buildLedger.length,
        },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(`[demo-tenant-scenario-pack] ${err.message}`);
  process.exit(1);
});
