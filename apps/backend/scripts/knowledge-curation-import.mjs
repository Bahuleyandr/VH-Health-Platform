#!/usr/bin/env node
// knowledge-curation-import.mjs — WS5 B5.5 clinical-AI knowledge importer.
//
// Imports hospital-owned, in-our-control clinical reference data into the RAG
// knowledge-base substrate (migration 113) as curation-PENDING documents, so a
// human domain owner (pharmacy / microbiology-infection-control / protocol
// owner) signs them off before they feed a clinical-AI prompt. See
// docs/CLINICAL_AI_KNOWLEDGE_CURATION.md.
//
// Sources (all hospital-owned, in-our-control):
//   formulary    pharmacy_catalog (active rows)  → kb_type formulary
//   antibiogram  antibiogram_90d  (90-day view)  → kb_type antibiotic_policy
//   protocols    clinical_protocols (active)      → kb_type clinical_guideline
//
// Usage:
//   node scripts/knowledge-curation-import.mjs --source formulary --tenant <uuid> [--kb <id>] [--dry-run]
//   node scripts/knowledge-curation-import.mjs --source all       --tenant <uuid> [--dry-run]
//
// Options:
//   --source formulary|antibiogram|protocols|all   (required)
//   --tenant <uuid>   tenant to import for. Defaults to the platform default
//                     tenant (00000000-0000-4000-8000-000000000001).
//   --kb <id>         target knowledge_base id. Omit to auto-discover the
//                     tenant's active KB whose kb_type matches the source
//                     (and is not archived). With --source all, KBs are
//                     auto-discovered per source.
//   --dry-run         render + dedup-probe + count, no writes.
//
// Connection: DATABASE_URL (same env the backend uses). The importer runs the
// canonical service pipeline (render → chunk → embed via Ollama), so embeddings
// require a reachable embedder; when Ollama is down the docs are still inserted
// (curation_status='pending') and chunking degrades to 'embed_unavailable' —
// re-run, or call the reindex endpoint, once the embedder is back.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VALID_SOURCES = new Set(['formulary', 'antibiogram', 'protocols', 'all']);
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const KB_TYPE_FOR_SOURCE = {
  formulary: 'formulary',
  antibiogram: 'antibiotic_policy',
  protocols: 'clinical_guideline',
};

function parseArgs(argv) {
  const args = { dryRun: false, tenant: DEFAULT_TENANT, kb: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--kb') args.kb = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node scripts/knowledge-curation-import.mjs --source formulary --tenant <uuid> [--kb <id>] [--dry-run]
  node scripts/knowledge-curation-import.mjs --source all       --tenant <uuid> [--dry-run]

Sources: formulary | antibiogram | protocols | all
Connection: DATABASE_URL`);
}

// Resolve the target KB id for a single source: explicit --kb, else
// auto-discover the tenant's most-recent active KB of the matching kb_type.
async function resolveKbId(client, { tenantId, source, explicitKb }) {
  if (explicitKb) {
    const parsed = Number.parseInt(explicitKb, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--kb must be a positive integer (got ${explicitKb})`);
    }
    const { rows } = await client.query(
      `SELECT id, kb_type, status FROM knowledge_bases WHERE id = $1 AND tenant_id = $2::uuid`,
      [parsed, tenantId],
    );
    if (!rows[0]) throw new Error(`knowledge_base ${parsed} not found for tenant ${tenantId}`);
    return parsed;
  }
  const kbType = KB_TYPE_FOR_SOURCE[source];
  const { rows } = await client.query(
    `SELECT id FROM knowledge_bases
     WHERE tenant_id = $1::uuid AND kb_type = $2 AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [tenantId, kbType],
  );
  if (!rows[0]) {
    throw new Error(
      `No active knowledge_base of kb_type '${kbType}' for tenant ${tenantId}. ` +
      `Create one (POST /knowledge-bases or seed the starter set) or pass --kb <id>.`,
    );
  }
  return rows[0].id;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }
  const source = String(args.source || '').toLowerCase();
  if (!VALID_SOURCES.has(source)) {
    console.error(`--source must be one of: ${[...VALID_SOURCES].join(', ')}`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }

  // Lazy import so --help / arg validation never boot the backend prisma client.
  const { default: pg } = await import('pg');
  const { importSource } = await import('../src/services/ai/knowledgeCurationService.js');

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const startedAt = Date.now();
  try {
    const sources = source === 'all' ? ['formulary', 'antibiogram', 'protocols'] : [source];
    const kbIds = {};
    for (const src of sources) {
      kbIds[src] = await resolveKbId(client, {
        tenantId: args.tenant, source: src, explicitKb: source === 'all' ? null : args.kb,
      });
    }

    const result = await importSource({
      tenantId: args.tenant,
      source,
      kbIds,
      dryRun: args.dryRun,
    });

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const prefix = args.dryRun ? '[dry-run] ' : '';
    for (const [src, counts] of Object.entries(result)) {
      console.log(
        `${prefix}${src} → kb ${kbIds[src]}: ` +
        `processed ${counts.processed}, inserted ${counts.inserted}, ` +
        `skipped ${counts.skipped}, failed ${counts.failed}`,
      );
    }
    console.log(`${prefix}done in ${secs}s${args.dryRun ? ' (no writes)' : ' — imported docs are curation_status=pending until signed off'}`);
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export { parseArgs, resolveKbId };
