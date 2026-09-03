import prisma from '../lib/prisma.js';
import { authClient, ensureTestIdentity } from './testClient.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { setTransplantProgramEnabled } from '../services/transplant/transplantProgramFeatureService.js';
import { createProgram } from '../services/transplant/transplantProgramService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = DEFAULT_TENANT_ID;
const OTHER_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_PATIENT = 'NL13P6 Transplant Patient';
const OTHER_PATIENT = 'NL13P6 Other Tenant Patient';

let patientUid;
let programId;
let candidateId;
let committeeReviewId;
let donorReferralId;
let nottoExportId;

const clinician = (tenantId = TENANT_ID) => authClient('DOCTOR', { uid: ACTOR_UID, tenant_id: tenantId });

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_notto_exports WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_immunosuppression_plans WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_match_reviews WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_waitlist_status_history WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_committee_reviews WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_donor_referrals WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_candidates WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_programs WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM transplant_program_settings WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE event_type LIKE 'transplant.%'
         OR patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`,
    TEST_PATIENT,
    OTHER_PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE action LIKE 'TRANSPLANT_%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_credentials WHERE tenant_id IN ($1::uuid, $2::uuid) AND staff_uid = $3::uuid`,
    TENANT_ID,
    OTHER_TENANT_ID,
    ACTOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM privilege_catalog
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND privilege_key LIKE 'transplant_%'`,
    TENANT_ID,
    OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name IN ($1, $2)`, TEST_PATIENT, OTHER_PATIENT).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, OTHER_TENANT_ID).catch(() => {});
}

async function grantTransplantPrivileges(tenantId) {
  const privileges = [
    ['transplant_surgeon', 'Transplant surgeon'],
    ['transplant_physician', 'Transplant physician'],
    ['transplant_coordinator', 'Transplant coordinator'],
    ['transplant_committee_member', 'Transplant committee member'],
  ];
  for (const [key, label] of privileges) {
    const catalog = await prisma.$queryRawUnsafe(
      `INSERT INTO privilege_catalog
         (tenant_id, privilege_key, display_name, description,
          required_credential_types, review_cadence_days, enforcement_scope, metadata)
       VALUES ($1::uuid, $2::text, $3::text, $3::text, ARRAY['registration', 'privilege']::text[], 365, 'transplant',
                '{"test_seed": true}'::jsonb)
       ON CONFLICT (tenant_id, privilege_key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         enforcement_scope = EXCLUDED.enforcement_scope,
         updated_at = NOW()
       RETURNING id`,
      tenantId,
      key,
      label,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_credentials
         (tenant_id, staff_uid, credential_type, name, status, privilege_catalog_id,
          valid_until, metadata)
       VALUES ($1::uuid, $2::uuid, 'privilege', $3::text, 'active', $4::bigint, '2030-01-01',
                '{"test_seed": true}'::jsonb)`,
      tenantId,
      ACTOR_UID,
      key,
      catalog[0].id,
    );
  }
}

d('NL-13 P6 transplant program management', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity(ACTOR_UID);
  });
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'default', 'Default Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'nl13-p6-other', 'NL13 P6 Other Tenant')
       ON CONFLICT (id) DO NOTHING`,
      OTHER_TENANT_ID,
    );
    await grantTransplantPrivileges(TENANT_ID);
    await grantTransplantPrivileges(OTHER_TENANT_ID);
    await setTransplantProgramEnabled(TENANT_ID, true, {
      actorUid: ACTOR_UID,
      snapshot: { nl13_p6: true },
      ownerEvidenceReference: 'OWNER-GATE-NL13-P6',
    });
    await setTransplantProgramEnabled(OTHER_TENANT_ID, true, {
      actorUid: ACTOR_UID,
      snapshot: { nl13_p6: true },
      ownerEvidenceReference: 'OWNER-GATE-NL13-P6',
    });
    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'PATIENT', true, NOW())
       RETURNING uid`,
      TENANT_ID,
      `+9199136${String(Date.now() % 10000).padStart(4, '0')}`,
      TEST_PATIENT,
    );
    patientUid = patient[0].uid;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'PATIENT', true, NOW())`,
      OTHER_TENANT_ID,
      `+9199137${String(Date.now() % 10000).padStart(4, '0')}`,
      OTHER_PATIENT,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('candidate evaluation to committee, waitlist, donor referral, match, immunosuppression, and NOTTO ledger', async () => {
    const program = await clinician().post('/api/v1/transplant/programs').send({
      organ: 'kidney',
      service_line: 'Abdominal transplant',
      site: 'NL13 P6 Main Site',
      status: 'active',
      program_owner_uid: ACTOR_UID,
      program_owner_role: 'DOCTOR',
      notto_evidence_owner_uid: ACTOR_UID,
      notto_evidence_owner_role: 'TRANSPLANT_COORDINATOR',
      notto_evidence_reference: 'OWNER-SUPPLIED-NOTTO-EVIDENCE-SLOT',
    });
    expect(program.status).toBe(201);
    programId = program.body.data.program.id;

    const candidate = await clinician().post(`/api/v1/transplant/programs/${programId}/candidates`).send({
      patient_uid: patientUid,
      diagnosis: 'End-stage kidney disease',
      required_organs: ['kidney'],
      contraindications_summary: 'No absolute contraindications recorded',
    });
    expect(candidate.status).toBe(201);
    candidateId = candidate.body.data.candidate.id;
    expect(candidate.body.data.candidate.timeline_event_id).toBeTruthy();
    expect(candidate.body.data.candidate.audit_event_id).toBeTruthy();

    const committee = await clinician().post(`/api/v1/transplant/candidates/${candidateId}/committee-reviews`).send({
      program_id: programId,
      attendees: [{ uid: ACTOR_UID, role: 'transplant_committee_member' }],
      quorum_policy_reference: 'LOCAL-OPERATOR-QUORUM-POLICY',
      decision: 'approved',
      recommendations: 'Proceed to listing under local committee policy',
    });
    expect(committee.status).toBe(201);
    committeeReviewId = committee.body.data.review.id;
    expect(committee.body.data.review.timeline_event_id).toBeTruthy();

    const waitlist = await clinician().post(`/api/v1/transplant/candidates/${candidateId}/waitlist-status`).send({
      status: 'listed',
      reason: 'Committee approved listing',
      committee_review_id: committeeReviewId,
    });
    expect(waitlist.status).toBe(201);
    expect(waitlist.body.data.status.status).toBe('listed');
    expect(waitlist.body.data.status.timeline_event_id).toBeTruthy();

    const donor = await clinician().post('/api/v1/transplant/donor-referrals').send({
      program_id: programId,
      donor_type: 'living',
      source: 'Family donor referral',
      relation_category: 'relative',
      screening_summary: 'Initial screening packet received',
      documents: [{ kind: 'screening_summary', ref: 'R2/test-only' }],
    });
    expect(donor.status).toBe(201);
    donorReferralId = donor.body.data.referral.id;

    const match = await clinician().post('/api/v1/transplant/match-reviews').send({
      candidate_id: candidateId,
      donor_referral_id: donorReferralId,
      compatibility_summary: 'Compatibility review documented; no allocation rules encoded',
      crossmatch_documents: [{ kind: 'crossmatch_chain', ref: 'R2/test-crossmatch' }],
      chain_of_custody: { specimen: 'test-specimen', custody: 'documented' },
      risk_flags: ['owner_review_required'],
      decision: 'accepted',
    });
    expect(match.status).toBe(201);
    expect(match.body.data.review.timeline_event_id).toBeTruthy();

    const immuno = await clinician().post(`/api/v1/transplant/candidates/${candidateId}/immunosuppression-plans`).send({
      regimen_summary: 'Tacrolimus-based regimen owner-reviewed in transplant clinic',
      monitoring_plan: 'Therapeutic drug monitoring per local protocol',
      prescribing_owner_uid: ACTOR_UID,
      downstream_medication_links: [{ ref: 'med-order-placeholder' }],
      status: 'active',
    });
    expect(immuno.status).toBe(201);
    expect(immuno.body.data.plan.timeline_event_id).toBeTruthy();

    const exportDraft = await clinician().post('/api/v1/transplant/notto-exports').send({
      program_id: programId,
      candidate_id: candidateId,
      package_metadata: { format: 'operator-supplied' },
      owner_reviewed_status: 'draft',
    });
    expect(exportDraft.status).toBe(201);
    nottoExportId = exportDraft.body.data.export.id;

    const blockedRelease = await clinician().post(`/api/v1/transplant/notto-exports/${nottoExportId}/release`).send({
      upload_reference_id: '',
      audit_evidence: {},
    });
    expect(blockedRelease.status).toBe(409);

    const released = await clinician().post(`/api/v1/transplant/notto-exports/${nottoExportId}/release`).send({
      upload_reference_id: 'NOTTO-OWNER-REF-001',
      audit_evidence: { owner_review: 'operator supplied before release' },
    });
    expect(released.status).toBe(200);
    expect(released.body.data.export.owner_reviewed_status).toBe('released');

    const dashboard = await clinician().get('/api/v1/transplant/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.dashboard.counts.candidates).toBeGreaterThanOrEqual(1);
    expect(dashboard.body.data.dashboard.counts.donor_referrals).toBeGreaterThanOrEqual(1);
  });

  test('keeps donor referrals off patient timeline and separate from blood-bank donor rails', async () => {
    const donorTimeline = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM clinical_timeline_events
        WHERE source_table = 'transplant_donor_referrals'`,
    );
    expect(Number(donorTimeline[0].count)).toBe(0);

    const entangledColumns = await prisma.$queryRawUnsafe(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'transplant_donor_referrals'
          AND column_name IN ('blood_donor_id', 'donation_id', 'blood_component_id', 'transfusion_request_id')`,
    );
    expect(entangledColumns).toHaveLength(0);
  });

  test('tenant isolation keeps another tenant program out of the default tenant dashboard', async () => {
    await createProgram({
      tenantId: OTHER_TENANT_ID,
      organ: 'heart',
      serviceLine: 'Cardiac transplant',
      site: 'NL13 P6 Other Tenant Site',
      status: 'active',
      programOwnerUid: ACTOR_UID,
      nottoEvidenceOwnerUid: ACTOR_UID,
      nottoEvidenceReference: 'OTHER-TENANT-EVIDENCE',
    }, { actorUid: ACTOR_UID, actorRole: 'DOCTOR' });

    const dashboard = await clinician().get('/api/v1/transplant/dashboard');
    expect(dashboard.status).toBe(200);
    const sites = dashboard.body.data.dashboard.programs.map((program) => program.site);
    expect(sites).toContain('NL13 P6 Main Site');
    expect(sites).not.toContain('NL13 P6 Other Tenant Site');
  });
});
