// src/tests/lab-loinc-code-mapping.deep.test.js
//
// DB-REQUIRED DEEP TEST (Postgres on :5433/:55432 via jest.setup.cjs; skips
// itself when no TEST_DATABASE_URL/DATABASE_URL is configured). Not part of
// the prisma-mocked unit tier — run it with the deep suites only.
//
// Terminology WP3 (migration 721) — LOINC closed loop through the real ORU
// ingest path:
//   1. Gate fully on + active mapping  → lab_results.loinc_code stamped.
//   2. Gate fully on, no mapping row   → loinc_code stays null (fail-open
//      passthrough; ingest never blocks).
//   3. Env kill switch off             → loinc_code stays null even though
//      the tenant flag and mapping row exist (byte-identical dark posture).
//
// NOTE: flips tenants.settings.labLoincMapping for the default test tenant
// (saved + restored, abdm-enrolment-link.deep.test.js pattern) and relies on
// this process not having warmed the 60s tenant cache with the pre-flip row
// before the first ingest.

import { randomUUID } from 'node:crypto';

import prisma from '../lib/prisma.js';
import { ingestOruMessage } from '../services/lab/labResultsService.js';
import {
  createMapping,
  deactivateMapping,
  _invalidateLabCodeMappingCache,
} from '../services/lab/labCodeMappingService.js';
import { cleanupGovernedOruFixture } from './helpers/labThresholdGovernanceFixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfTestDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const ACTOR = randomUUID();
const PATIENT_UID = randomUUID();
const ANALYZER = `LOINCMAP-${RUN_ID}`;
const LOCAL_CODE = `LK${RUN_ID}`;
const UNMAPPED_CODE = `LX${RUN_ID}`;
const MAPPED_LOINC = '2823-3';

function phoneFor(seed) {
  const numeric = Number.parseInt(seed.replaceAll('-', '').slice(0, 8), 16);
  return `+91${String(numeric).padStart(10, '0').slice(-10)}`;
}

function messageFor({ controlId, testCode }) {
  // Patient-only shadow path (no ORC/OBR placer id); OBX-3 carries a bare
  // local analyzer code with no LN/LOINC coding-system component.
  return [
    `MSH|^~\\&|${ANALYZER}|LAB|VH|VH|20260820120000||ORU^R01|${controlId}|P|2.5`,
    `PID|1||${PATIENT_UID}||Patient^LoincMap`,
    `OBR|1|||${testCode}^LOINC mapping test`,
    `OBX|1|NM|${testCode}^LOINC mapping test||4.1|mmol/L|3.5-5.1|N|||F`,
  ].join('\r');
}

async function ingest(controlId, testCode) {
  return ingestOruMessage(messageFor({ controlId, testCode }), {
    tenantId: TENANT_ID,
    actorUid: ACTOR,
    actorRole: 'LAB_STAFF',
    actorRoles: ['LAB_STAFF'],
  });
}

async function loincOf(resultId) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT loinc_code FROM lab_results WHERE tenant_id = $1::uuid AND id = $2::int',
    TENANT_ID,
    Number(resultId),
  );
  return rows[0]?.loinc_code ?? null;
}

describeIfTestDb('LOINC analyzer-code mapping closed loop (ORU ingest)', () => {
  let savedSettings = null;
  let savedEnv;
  let mappingId;

  beforeAll(async () => {
    savedEnv = process.env.LAB_LOINC_MAPPING_ENABLED;
    const tenant = await prisma.$queryRawUnsafe(
      'SELECT id, settings FROM tenants WHERE id = $1::uuid LIMIT 1',
      TENANT_ID,
    );
    if (!tenant[0]) throw new Error(`Test tenant ${TENANT_ID} is missing`);
    savedSettings = tenant[0].settings ?? {};
    await prisma.$executeRawUnsafe(
      `UPDATE tenants
          SET settings = COALESCE(settings, '{}'::jsonb) || '{"labLoincMapping":{"enabled":true}}'::jsonb
        WHERE id = $1::uuid`,
      TENANT_ID,
    );

    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $3::uuid, $4, 'LOINC Map Actor', 'LAB_STAFF', true, 'active', NOW()),
         ($2::uuid, $3::uuid, $5, 'LOINC Map Patient', 'PATIENT', true, 'active', NOW())`,
      ACTOR,
      PATIENT_UID,
      TENANT_ID,
      phoneFor(ACTOR),
      phoneFor(PATIENT_UID),
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO lab_analyzers
         (tenant_id, analyzer_code, display_name, interface_kind, status, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $2, 'hl7', 'active',
               jsonb_build_object('hl7_actor_uids', jsonb_build_array($3::text)),
               NOW(), NOW())`,
      TENANT_ID,
      ANALYZER,
      ACTOR,
    );

    const mapping = await createMapping({
      tenantId: TENANT_ID,
      actorUid: ACTOR,
      mapping: {
        source_key: ANALYZER,
        incoming_code: LOCAL_CODE,
        loinc_code: MAPPED_LOINC,
        display: 'Potassium (mapped)',
      },
    });
    mappingId = mapping.id;
  });

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.LAB_LOINC_MAPPING_ENABLED;
    else process.env.LAB_LOINC_MAPPING_ENABLED = savedEnv;
    if (mappingId) {
      await deactivateMapping({ tenantId: TENANT_ID, id: mappingId, actorUid: ACTOR })
        .catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM lab_analyzer_code_mappings
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT_ID,
        mappingId,
      );
    }
    if (savedSettings !== null) {
      await prisma.$executeRawUnsafe(
        'UPDATE tenants SET settings = $2::jsonb WHERE id = $1::uuid',
        TENANT_ID,
        JSON.stringify(savedSettings),
      ).catch(() => {});
    }
    try {
      await cleanupGovernedOruFixture({
        tenantId: TENANT_ID,
        analyzerCodes: [ANALYZER],
        userUids: [ACTOR, PATIENT_UID],
      });
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  beforeEach(() => {
    _invalidateLabCodeMappingCache();
  });

  it('stamps loinc_code from the active mapping when env + tenant gates are on', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    const out = await ingest(`LM1-${RUN_ID}`, LOCAL_CODE);
    expect(out.results).toHaveLength(1);
    await expect(loincOf(out.results[0].id)).resolves.toBe(MAPPED_LOINC);
  });

  it('passes unmapped codes through unchanged (fail-open) with the gate on', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    const out = await ingest(`LM2-${RUN_ID}`, UNMAPPED_CODE);
    expect(out.results).toHaveLength(1);
    await expect(loincOf(out.results[0].id)).resolves.toBeNull();
  });

  it('stays byte-identical with the env kill switch off, mapping and tenant flag notwithstanding', async () => {
    delete process.env.LAB_LOINC_MAPPING_ENABLED;
    const out = await ingest(`LM3-${RUN_ID}`, LOCAL_CODE);
    expect(out.results).toHaveLength(1);
    await expect(loincOf(out.results[0].id)).resolves.toBeNull();
  });
});
