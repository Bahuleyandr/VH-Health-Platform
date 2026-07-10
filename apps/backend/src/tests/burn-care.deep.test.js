import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  createBurnChart,
  linkProtocolContent,
  recordFluidWorksheet,
  recordReassessment,
  recordTbsaRegions,
  PROTOCOL_UNAVAILABLE_MESSAGE,
} from '../services/clinical/burnCareService.js';
import { policyCodeForRecordType, ACCESS_POLICY_CODES } from '../services/security/accessPolicyRegistry.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '53600000-0000-4000-8000-0000000000a1';
const TENANT_B = '53600000-0000-4000-8000-0000000000b1';
const PATIENT_UID = '53600000-0000-4000-8000-0000000000c1';
const CLINICIAN_UID = '53600000-0000-4000-8000-0000000000d1';
const REVIEWER_UID = '53600000-0000-4000-8000-0000000000e1';
const APP_ROLE = 'burn_care_test_app';
const RUN_KEY = `NL14BURN-${Date.now()}`;

let savedEnforceFlag;
let savedRuntimeRole;
let emergencyVisitId;
let burnMlcId;
let nonBurnMlcId;
let contentOrderSetId;
let tbsaReferenceId;
let fluidReferenceId;
let burnChartId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM burn_reassessment_media
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM burn_fluid_worksheets
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM burn_protocol_content_links
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM burn_reassessments
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM burn_wound_regions
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM burn_charts
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM burn_tbsa_references
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM burn_fluid_references
      WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND patient_uid = $3::uuid
        AND source_table LIKE 'burn_%'`,
    TENANT_A,
    TENANT_B,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND patient_uid = $3::uuid
        AND resource_table LIKE 'burn_%'`,
    TENANT_A,
    TENANT_B,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM mlc_records
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND mlc_number LIKE $3`,
    TENANT_A,
    TENANT_B,
    `${RUN_KEY}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM emergency_visits
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND visit_number LIKE $3`,
    TENANT_A,
    TENANT_B,
    `${RUN_KEY}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_order_sets
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND code LIKE $3`,
    TENANT_A,
    TENANT_B,
    `${RUN_KEY}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID,
    CLINICIAN_UID,
    REVIEWER_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
}

async function ensureAppRole() {
  try {
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} NOLOGIN;
        END IF;
      END $$;
    `);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`).catch(() => {});
    await prisma.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`).catch(() => {});
    const member = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles g ON g.oid = m.member
        WHERE r.rolname = $1 AND g.rolname = current_user
        LIMIT 1`,
      APP_ROLE,
    );
    if (!member.length) {
      const me = (await prisma.$queryRawUnsafe(`SELECT current_user AS u`))[0].u;
      await prisma.$executeRawUnsafe(`GRANT ${APP_ROLE} TO ${me}`).catch(() => {});
    }
  } catch (err) {
    const exists = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1`,
      APP_ROLE,
    );
    if (!exists.length) {
      throw new Error(`Test role ${APP_ROLE} missing and cannot be created: ${err.message}`);
    }
  }
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
     VALUES
       ($1::uuid, $2, 'NL14 Burn Tenant A', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW()),
       ($3::uuid, $4, 'NL14 Burn Tenant B', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    TENANT_A,
    `nl14-burn-a-${Date.now()}`,
    TENANT_B,
    `nl14-burn-b-${Date.now()}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES
       ($1::uuid, $2, 'Burn Test Patient', 'PATIENT', true, $4::uuid, NOW()),
       ($3::uuid, $5, 'Burn Test Clinician', 'DOCTOR', true, $4::uuid, NOW()),
       ($6::uuid, $7, 'Burn Test Reviewer', 'CMO', true, $4::uuid, NOW())`,
    PATIENT_UID,
    '+919999536001',
    CLINICIAN_UID,
    TENANT_A,
    '+919999536002',
    REVIEWER_UID,
    '+919999536003',
  );
  const visit = await prisma.$queryRawUnsafe(
    `INSERT INTO emergency_visits
       (tenant_id, visit_number, patient_uid, arrival_mode, chief_complaint, status, is_mlc, created_by)
     VALUES ($1::uuid, $2, $3::uuid, 'walk_in', 'Flame burn', 'in_treatment', true, $4::uuid)
     RETURNING id, encounter_id`,
    TENANT_A,
    `${RUN_KEY}-VISIT`,
    PATIENT_UID,
    CLINICIAN_UID,
  );
  emergencyVisitId = visit[0].id;
  const burnMlc = await prisma.$queryRawUnsafe(
    `INSERT INTO mlc_records
       (tenant_id, emergency_visit_id, patient_uid, mlc_number, mlc_kind,
        incident_at, injuries, consent_for_examination, created_by)
     VALUES ($1::uuid, $2::int, $3::uuid, $4, 'burn',
        NOW(), '[]'::jsonb, true, $5::uuid)
     RETURNING id`,
    TENANT_A,
    emergencyVisitId,
    PATIENT_UID,
    `${RUN_KEY}-MLC-BURN`,
    CLINICIAN_UID,
  );
  burnMlcId = burnMlc[0].id;
  const nonBurnMlc = await prisma.$queryRawUnsafe(
    `INSERT INTO mlc_records
       (tenant_id, emergency_visit_id, patient_uid, mlc_number, mlc_kind,
        incident_at, injuries, consent_for_examination, created_by)
     VALUES ($1::uuid, $2::int, $3::uuid, $4, 'assault',
        NOW(), '[]'::jsonb, true, $5::uuid)
     RETURNING id`,
    TENANT_A,
    emergencyVisitId,
    PATIENT_UID,
    `${RUN_KEY}-MLC-NONBURN`,
    CLINICIAN_UID,
  );
  nonBurnMlcId = nonBurnMlc[0].id;
  const content = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_order_sets
       (tenant_id, code, title, specialty, condition_codes, description,
        active, created_by, family_key, version, status, approved_by,
        approved_at, source)
     VALUES ($1::uuid, $2, 'Burn fluid content', 'emergency', ARRAY['T31']::text[],
        'Approved burn fluid worksheet content', true, $3::uuid, $4, 1,
        'approved', $5::uuid, NOW(), 'authored')
     RETURNING id`,
    TENANT_A,
    `${RUN_KEY}-FLUID`,
    CLINICIAN_UID,
    `${RUN_KEY}-fluid-family`,
    REVIEWER_UID,
  );
  contentOrderSetId = Number(content[0].id);
  const tbsa = await prisma.$queryRawUnsafe(
    `INSERT INTO burn_tbsa_references
       (tenant_id, reference_key, title, version, source, age_template_key,
        region_weights, evidence_owner_uid, governance_owner_uid,
        reviewer_signoff_uid, reviewer_signoff_at, status, active)
     VALUES ($1::uuid, $2, 'Burn TBSA adult reference', 1, 'owner supplied',
        'adult', '{"arm": 9, "hand": 1}'::jsonb, $3::uuid, $3::uuid,
        $4::uuid, NOW(), 'approved', true)
     RETURNING id`,
    TENANT_A,
    `${RUN_KEY}-tbsa`,
    CLINICIAN_UID,
    REVIEWER_UID,
  );
  tbsaReferenceId = Number(tbsa[0].id);
  const fluid = await prisma.$queryRawUnsafe(
    `INSERT INTO burn_fluid_references
       (tenant_id, reference_key, title, version, source, content_order_set_id,
        evidence_owner_uid, governance_owner_uid, reviewer_signoff_uid,
        reviewer_signoff_at, status, active)
     VALUES ($1::uuid, $2, 'Burn fluid worksheet policy', 1, 'content studio',
        $3::int, $4::uuid, $4::uuid, $5::uuid, NOW(), 'approved', true)
     RETURNING id`,
    TENANT_A,
    `${RUN_KEY}-fluid`,
    contentOrderSetId,
    CLINICIAN_UID,
    REVIEWER_UID,
  );
  fluidReferenceId = Number(fluid[0].id);
}

d('NL-14 P3 burn care service', () => {
  beforeAll(async () => {
    savedEnforceFlag = process.env.AUTH_ENFORCE_TENANT_RLS;
    savedRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    await cleanup();
    await ensureAppRole();
    await seed();
  }, 45000);

  afterAll(async () => {
    if (savedEnforceFlag === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedEnforceFlag;
    if (savedRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = savedRuntimeRole;
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 45000);

  it('opens a burn chart from a burn MLC and writes timeline plus audit rows', async () => {
    const chart = await createBurnChart({
      tenantId: TENANT_A,
      mlcRecordId: burnMlcId,
      mechanism: 'domestic flame burn',
      firstAid: 'cool running water',
      inhalationRisk: true,
      circumferentialBurns: false,
      actorUid: CLINICIAN_UID,
      actorRole: 'DOCTOR',
    });
    burnChartId = chart.id;
    expect(chart.patient_uid).toBe(PATIENT_UID);
    expect(chart.mlc_record_id).toBe(burnMlcId);
    expect(chart.emergency_visit_id).toBe(emergencyVisitId);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT id, event_type, source_table, source_id
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND event_type = 'burn.chart.created'
          AND source_table = 'burn_charts'
          AND source_id = $3`,
      TENANT_A,
      PATIENT_UID,
      String(burnChartId),
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT id, action, resource_table, resource_id
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND action = 'burn.chart.created'
          AND resource_table = 'burn_charts'
          AND resource_id = $3`,
      TENANT_A,
      PATIENT_UID,
      String(burnChartId),
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  it('rejects a non-burn MLC instead of silently linking the chart', async () => {
    await expect(createBurnChart({
      tenantId: TENANT_A,
      mlcRecordId: nonBurnMlcId,
      mechanism: 'incorrect MLC link',
      actorUid: CLINICIAN_UID,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BURN_MLC_KIND_REQUIRED',
    });
  });

  it('records versioned TBSA regions and uses clinician override in the total', async () => {
    const result = await recordTbsaRegions({
      tenantId: TENANT_A,
      burnChartId,
      referenceId: tbsaReferenceId,
      actorUid: CLINICIAN_UID,
      actorRole: 'DOCTOR',
      regions: [
        {
          bodyRegionCode: 'right_arm',
          bodyRegionLabel: 'Right arm',
          side: 'right',
          depth: 'partial_thickness',
          areaPercent: 9,
        },
        {
          bodyRegionCode: 'left_hand',
          bodyRegionLabel: 'Left hand',
          side: 'left',
          depth: 'deep_partial',
          areaPercent: 4.5,
          clinicianOverridePercent: 6,
          overrideReason: 'palmar surface reassessed by consultant',
        },
      ],
    });
    expect(result.tbsa_percent).toBe(15);
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0].reference_version).toBe(1);
    expect(Number(result.regions[1].clinician_override_percent)).toBe(6);

    await expect(recordTbsaRegions({
      tenantId: TENANT_A,
      burnChartId,
      referenceKey: `${RUN_KEY}-missing-tbsa`,
      actorUid: CLINICIAN_UID,
      regions: [{
        bodyRegionCode: 'torso',
        bodyRegionLabel: 'Torso',
        depth: 'mixed',
        areaPercent: 12,
      }],
    })).rejects.toMatchObject({ message: PROTOCOL_UNAVAILABLE_MESSAGE });
  });

  it('links approved content and fails closed when fluid content is unavailable', async () => {
    const link = await linkProtocolContent({
      tenantId: TENANT_A,
      burnChartId,
      protocolKind: 'fluid',
      contentOrderSetId,
      actorUid: CLINICIAN_UID,
    });
    expect(link.content_order_set_id).toBe(contentOrderSetId);
    expect(link.family_key).toBe(`${RUN_KEY}-fluid-family`);

    const worksheet = await recordFluidWorksheet({
      tenantId: TENANT_A,
      burnChartId,
      protocolReferenceId: fluidReferenceId,
      contentOrderSetId,
      weightKg: 62,
      tbsaPercent: 15,
      worksheetInputs: { assessed_tbsa_percent: 15 },
      clinicianDecisions: { plan: 'clinician signed fluid worksheet' },
      actorUid: CLINICIAN_UID,
      reviewedBy: REVIEWER_UID,
      reviewedAt: new Date().toISOString(),
    });
    expect(worksheet.protocol_reference_id).toBe(fluidReferenceId);
    expect(worksheet.content_order_set_id).toBe(contentOrderSetId);

    await expect(recordFluidWorksheet({
      tenantId: TENANT_A,
      burnChartId,
      protocolReferenceId: fluidReferenceId,
      contentOrderSetId: 2147483000,
      weightKg: 62,
      tbsaPercent: 15,
      clinicianDecisions: { plan: 'should not persist' },
      actorUid: CLINICIAN_UID,
    })).rejects.toMatchObject({ message: PROTOCOL_UNAVAILABLE_MESSAGE });
  });

  it('records serial wound reassessment timeline and stores media metadata only', async () => {
    const reassessment = await recordReassessment({
      tenantId: TENANT_A,
      burnChartId,
      painScore: 0,
      woundStatus: 'serial assessment stable',
      infectionConcern: false,
      perfusionConcern: true,
      serialAssessment: { distal_pulse: 'present', dressing: 'changed' },
      media: [{
        mediaStorageKey: `burns/${RUN_KEY}/reassessment-1.jpg`,
        mediaSha256Hash: 'a'.repeat(64),
        mimeType: 'image/jpeg',
        fileSizeBytes: 0,
        consentConfirmed: true,
        mediaKind: 'photo',
      }],
      actorUid: CLINICIAN_UID,
      actorRole: 'DOCTOR',
    });
    expect(reassessment.media).toHaveLength(1);
    expect(reassessment.media[0].media_storage_key).toContain(RUN_KEY);
    expect(reassessment.media[0]).not.toHaveProperty('media_blob');
    expect(reassessment.media[0]).not.toHaveProperty('base64');

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT id, payload
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND event_type = 'burn.reassessment.recorded'
          AND source_id = $3`,
      TENANT_A,
      PATIENT_UID,
      String(reassessment.id),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].payload.media_count).toBe(1);

    const blockedColumns = await prisma.$queryRawUnsafe(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'burn_reassessment_media'
          AND column_name ~* '(blob|base64|raw_bytes)'`,
    );
    expect(blockedColumns).toHaveLength(0);
  });

  it('keeps burn PHI tables tenant-scoped and maps BURN_CHART to critical-care access policy', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;
    const rows = await setTenantTx(TENANT_B, (tx) => tx.$queryRawUnsafe(
      `SELECT id, tenant_id::text AS tenant_id
         FROM burn_charts
        WHERE id = $1::bigint`,
      burnChartId,
    ));
    expect(rows).toHaveLength(0);

    const posture = await prisma.$queryRawUnsafe(
      `SELECT c.relname, c.relforcerowsecurity, p.policyname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1::text[])
          AND p.policyname = 'tenant_isolation'`,
      [
        'burn_charts',
        'burn_tbsa_references',
        'burn_wound_regions',
        'burn_reassessments',
        'burn_reassessment_media',
        'burn_fluid_references',
        'burn_fluid_worksheets',
        'burn_protocol_content_links',
      ],
    );
    expect(posture).toHaveLength(8);
    expect(posture.every((row) => row.relforcerowsecurity === true)).toBe(true);
    expect(policyCodeForRecordType('BURN_CHART')).toBe(
      ACCESS_POLICY_CODES.PATIENT_CRITICAL_CARE_VIEW,
    );
  });
});
