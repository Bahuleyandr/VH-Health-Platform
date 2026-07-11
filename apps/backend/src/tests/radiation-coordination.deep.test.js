// NL-13 P4 deep test — nuclear-medicine & radiotherapy coordination.
// Drives the full chain against a real DB: oncology diagnosis/staging -> radiotherapy
// referral -> external plan reference -> fraction schedule -> delivery -> nuclear-medicine
// order -> radioisotope administration, asserting the canonical timeline + audit invariant,
// the required-external-reference guardrails (fail closed), the register/audit-only safety
// evidence path (NEVER a patient timeline event), and PACS/OHIF deep-link reuse.

import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';
import {
  setRadiationCoordinationSettings,
  createReferral,
  transitionReferralStatus,
  createPlanRef,
  transitionPlanStatus,
  scheduleFraction,
  transitionFractionStatus,
  createNuclearOrder,
  transitionNuclearOrderStatus,
  recordRadioisotopeAdministration,
  recordSafetyEvidence,
} from '../services/clinical/radiationCoordinationService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const ACTOR = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const stamp = Date.now();

d('NL-13 P4 radiation coordination deep chain', () => {
  let patientUid;
  let diagnosisId;
  let stagingId;

  beforeAll(async () => {
    process.env.PACS_VIEWER_URL = 'https://imaging.test.local';
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'NL13 P4 Deep Tenant', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT, `nl13-p4-deep-${stamp}`,
    );
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'NL13 P4 Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      TENANT, `+9198${String(stamp).slice(-8)}`,
    );
    patientUid = u[0].uid;
    const dg = await prisma.$queryRawUnsafe(
      `INSERT INTO oncology_diagnoses (tenant_id, patient_uid, cancer_site, malignancy_flag_source, malignancy_flag)
       VALUES ($1::uuid, $2::uuid, 'Nasopharynx', 'manual_owner_source', 'malignant') RETURNING id`,
      TENANT, patientUid,
    );
    diagnosisId = Number(dg[0].id);
    const st = await prisma.$queryRawUnsafe(
      `INSERT INTO oncology_staging_records (tenant_id, diagnosis_id, patient_uid, clinical_stage)
       VALUES ($1::uuid, $2::bigint, $3::uuid, 'III') RETURNING id`,
      TENANT, diagnosisId, patientUid,
    );
    stagingId = Number(st[0].id);
    await setRadiationCoordinationSettings({ tenantId: TENANT, enabled: true }, { actorUid: ACTOR, actorRole: 'ADMIN' });
  });

  afterAll(async () => {
    // Best-effort cleanup; clinical_audit_events is append-only and is intentionally left.
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM radioisotope_administration_records WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM nuclear_medicine_orders WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM radiotherapy_fraction_schedules WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM radiotherapy_plan_refs WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM radiation_safety_evidence WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM radiation_oncology_referrals WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM radiation_coordination_settings WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM oncology_staging_records WHERE tenant_id = $1::uuid`, TENANT);
      await prisma.$executeRawUnsafe(`DELETE FROM oncology_diagnoses WHERE tenant_id = $1::uuid`, TENANT);
      if (patientUid) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, patientUid);
      await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT);
    } catch (err) {
      // swallow cleanup errors — the CI DB is disposable
    }
    await prisma.$disconnect();
  });

  // Count by the deterministic idempotency key so the assertion proves EXACTLY ONE
  // timeline + audit row per write, independent of other tests / append-only accumulation.
  async function timelineByKey(key) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE idempotency_key = $1`,
      key,
    );
    return rows[0].n;
  }
  async function auditByKey(key) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_audit_events WHERE idempotency_key = $1`,
      key,
    );
    return rows[0].n;
  }

  test('referral -> plan -> fraction -> nuclear order -> administration each emit canonical timeline + audit', async () => {
    // Referral, linked to the seeded oncology diagnosis + staging.
    const referral = await createReferral({
      tenantId: TENANT, patient_uid: patientUid, diagnosis_id: diagnosisId, staging_record_id: stagingId,
      intent: 'curative', modality: 'external_beam', reason: 'Stage III NPC — definitive RT',
    }, { actorUid: ACTOR, actorRole: 'RADIATION_ONCOLOGIST' });
    expect(referral.id).toBeGreaterThan(0);
    expect(referral.canonical_timeline_event_id).toBeTruthy();
    expect(await timelineByKey(`radiation_oncology_referrals:${referral.id}:created`)).toBe(1);
    expect(await auditByKey(`radiation_oncology_referrals:${referral.id}:audit:created`)).toBe(1);

    // Advance referral (diagnosis link satisfies the fail-closed guard).
    await transitionReferralStatus(referral.id, { tenantId: TENANT, status: 'submitted' }, { actorUid: ACTOR });
    await transitionReferralStatus(referral.id, { tenantId: TENANT, status: 'accepted' }, { actorUid: ACTOR });
    expect(await timelineByKey(`radiation_oncology_referrals:${referral.id}:status:accepted`)).toBe(1);
    expect(await auditByKey(`radiation_oncology_referrals:${referral.id}:audit:status:accepted`)).toBe(1);

    // External plan reference + PACS deep-link reuse.
    const planRef = await createPlanRef(referral.id, {
      tenantId: TENANT, external_plan_system: 'Eclipse', external_plan_id: 'PLAN-NPC-1',
      technique: 'VMAT', planned_fraction_count: 33, total_dose_gy_summary: 70,
      image_study_instance_uid: '1.2.840.113619.2.55.3',
    }, { actorUid: ACTOR });
    expect(planRef.viewer_url).toContain('1.2.840.113619.2.55.3');
    expect(await timelineByKey(`radiotherapy_plan_refs:${planRef.id}:referenced`)).toBe(1);
    await transitionPlanStatus(planRef.id, { tenantId: TENANT, plan_status: 'approved' }, { actorUid: ACTOR });
    expect(await timelineByKey(`radiotherapy_plan_refs:${planRef.id}:status:approved`)).toBe(1);

    // Fraction schedule -> delivered (needs external treatment ref).
    const fraction = await scheduleFraction(planRef.id, { tenantId: TENANT, fraction_number: 1 }, { actorUid: ACTOR });
    await transitionFractionStatus(fraction.id, {
      tenantId: TENANT, status: 'scheduled',
    }, { actorUid: ACTOR });
    await transitionFractionStatus(fraction.id, {
      tenantId: TENANT, status: 'delivered', external_treatment_ref: 'RT-DELIV-1',
    }, { actorUid: ACTOR });
    expect(await timelineByKey(`radiotherapy_fraction_schedules:${fraction.id}:status:delivered`)).toBe(1);

    // Nuclear-medicine order + radioisotope administration.
    const order = await createNuclearOrder({
      tenantId: TENANT, patient_uid: patientUid, referral_id: referral.id, order_kind: 'therapy',
      study_type: 'Radioiodine therapy', radiopharmaceutical_ref: 'I-131',
    }, { actorUid: ACTOR });
    await transitionNuclearOrderStatus(order.id, { tenantId: TENANT, status: 'ordered' }, { actorUid: ACTOR });
    await transitionNuclearOrderStatus(order.id, { tenantId: TENANT, status: 'scheduled' }, { actorUid: ACTOR });
    await transitionNuclearOrderStatus(order.id, { tenantId: TENANT, status: 'prepared' }, { actorUid: ACTOR });
    const admin = await recordRadioisotopeAdministration(order.id, {
      tenantId: TENANT, administered_activity_summary: '3.7 GBq (owner-supplied)', administered_activity_mbq: 3700,
      route: 'oral', aerb_evidence_owner: 'Owner-supplied AERB record',
    }, { actorUid: ACTOR, actorRole: 'NUCLEAR_MEDICINE_PHYSICIAN' });
    expect(admin.id).toBeGreaterThan(0);
    // Owner-supplied activity is stored verbatim — never computed by the product.
    expect(admin.administered_activity_mbq).toBe(3700);
    expect(await timelineByKey(`radioisotope_administration_records:${admin.id}:administered`)).toBe(1);
    expect(await auditByKey(`radioisotope_administration_records:${admin.id}:audit:administered`)).toBe(1);
  });

  test('required-external-reference guardrails FAIL CLOSED', async () => {
    const referral = await createReferral({
      tenantId: TENANT, patient_uid: patientUid, diagnosis_id: diagnosisId, modality: 'external_beam',
    }, { actorUid: ACTOR });
    // Plan without an external reference cannot be approved.
    const planRef = await createPlanRef(referral.id, { tenantId: TENANT }, { actorUid: ACTOR });
    await expect(
      transitionPlanStatus(planRef.id, { tenantId: TENANT, plan_status: 'approved' }, { actorUid: ACTOR }),
    ).rejects.toMatchObject({ code: 'RADIOTHERAPY_PLAN_REFERENCE_REQUIRED' });

    // Fraction cannot be delivered without an external treatment reference.
    const fraction = await scheduleFraction(planRef.id, { tenantId: TENANT, fraction_number: 1 }, { actorUid: ACTOR });
    await transitionFractionStatus(fraction.id, { tenantId: TENANT, status: 'scheduled' }, { actorUid: ACTOR });
    await expect(
      transitionFractionStatus(fraction.id, { tenantId: TENANT, status: 'delivered' }, { actorUid: ACTOR }),
    ).rejects.toMatchObject({ code: 'RADIOTHERAPY_FRACTION_TREATMENT_REF_REQUIRED' });

    // Nuclear order cannot advance without an isotope reference.
    const order = await createNuclearOrder({
      tenantId: TENANT, patient_uid: patientUid, study_type: 'PET-CT',
    }, { actorUid: ACTOR });
    await expect(
      transitionNuclearOrderStatus(order.id, { tenantId: TENANT, status: 'ordered' }, { actorUid: ACTOR }),
    ).rejects.toMatchObject({ code: 'NUCLEAR_MEDICINE_ISOTOPE_REF_REQUIRED' });
  });

  test('the product STORES external references and does NOT calculate plans or drive delivery', async () => {
    const referral = await createReferral({
      tenantId: TENANT, patient_uid: patientUid, diagnosis_id: diagnosisId, modality: 'external_beam',
    }, { actorUid: ACTOR });
    const planRef = await createPlanRef(referral.id, {
      tenantId: TENANT, external_plan_system: 'RayStation', external_plan_id: 'RS-9',
      planned_fraction_count: 25, total_dose_gy_summary: 50,
    }, { actorUid: ACTOR });
    // The stored values are exactly the owner-supplied inputs (no derivation/arithmetic).
    const stored = await prisma.$queryRawUnsafe(
      `SELECT external_plan_system, external_plan_id, planned_fraction_count, total_dose_gy_summary
         FROM radiotherapy_plan_refs WHERE id = $1::bigint AND tenant_id = $2::uuid`,
      planRef.id, TENANT,
    );
    expect(stored[0].external_plan_system).toBe('RayStation');
    expect(stored[0].external_plan_id).toBe('RS-9');
    expect(Number(stored[0].planned_fraction_count)).toBe(25);
    expect(Number(stored[0].total_dose_gy_summary)).toBe(50);
  });

  test('radiation safety evidence uses a register/audit trail and NEVER a patient timeline event', async () => {
    const before = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE tenant_id = $1::uuid AND source_table = 'radiation_safety_evidence'`,
      TENANT,
    );
    const evidence = await recordSafetyEvidence({
      tenantId: TENANT, evidence_type: 'equipment_qa', equipment_ref: 'LINAC-1',
      evidence_owner: 'Owner RSO', source_name: 'Owner QA log', source_version: 'v1',
    }, { actorUid: ACTOR, actorRole: 'RADIATION_SAFETY_OFFICER' });
    expect(evidence.id).toBeGreaterThan(0);
    expect(evidence.clinical_audit_event_id).toBeTruthy();
    expect(await auditByKey(`radiation_safety_evidence:${evidence.id}:audit:recorded`)).toBe(1);
    const after = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE tenant_id = $1::uuid AND source_table = 'radiation_safety_evidence'`,
      TENANT,
    );
    // Equipment/QA evidence is a register/audit subject — no patient timeline rows are created.
    expect(after[0].n).toBe(before[0].n);
    expect(after[0].n).toBe(0);
  });

  test('mutations fail closed when the tenant has the suite disabled', async () => {
    const otherTenant = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'NL13 P4 Disabled Tenant', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      otherTenant, `nl13-p4-disabled-${stamp}`,
    );
    await expect(
      createReferral({ tenantId: otherTenant, patient_uid: patientUid, modality: 'external_beam' }, { actorUid: ACTOR }),
    ).rejects.toMatchObject({ code: 'RADIATION_COORDINATION_DISABLED' });
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, otherTenant);
  });
});
