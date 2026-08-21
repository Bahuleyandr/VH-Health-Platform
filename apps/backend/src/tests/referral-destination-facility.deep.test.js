// Structured destination facilities for external referrals (migration 680).
//
// Covers: facility master CRUD (tenant-scoped, duplicate guard, active-flag
// soft delete), external referral linkage validation (internal rejected,
// wrong-tenant rejected, inactive rejected), canonical evidence on linked
// creation, closed-loop external coordination task metadata, the
// destination-facility change transition event, and the read projections
// (audit join + list scalar-subquery facility object).

import { randomUUID } from 'node:crypto';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const {
  createReferralFacility,
  getReferralFacility,
  listReferralFacilities,
  setReferralFacilityActive,
  updateReferralFacility,
} = await import('../services/referral/referralFacilityService.js');
const {
  createClosedLoopReferral,
  setReferralDestinationFacility,
} = await import('../services/referral/referralClosedLoopService.js');
const { default: referralService } = await import('../services/referral/referralService.js');
const { withAuditBypass } = await import('./helpers/auditBypass.js');

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const ADMIN_UID = randomUUID();
const ORIGINATOR_UID = randomUUID();
const users = [
  [PATIENT_UID, 'PATIENT', 'Destination Facility Patient'],
  [ADMIN_UID, 'ADMIN', 'Destination Facility Administrator'],
  [ORIGINATOR_UID, 'DOCTOR', 'Destination Facility Originator'],
];

function phone(index) {
  return `+9195${String(Math.floor(Math.random() * 1e7) + index).padStart(8, '0')}`;
}

function actor(uid, role) {
  return {
    tenantId: TENANT_ID,
    actorUid: uid,
    actorRole: role,
    actorRawRole: role,
    actorRoles: [role],
  };
}

async function cleanupTenant(tenantId) {
  await withAuditBypass(prisma, async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM referral_transition_events WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM tasks WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid AND source_table = 'referrals'`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM notifications WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM referrals WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM referral_facilities WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM doctors WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
  }).catch(() => {});
}

async function cleanup() {
  await cleanupTenant(TENANT_ID);
  await cleanupTenant(OTHER_TENANT_ID);
}

d('Referral destination facilities (migration 680)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'Destination Facility Tenant',
               '{"care_pathways":{"referral_request_to_closure":"active"}}'::jsonb)`,
      TENANT_ID,
      `dest-facility-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'Destination Facility Other Tenant', '{}'::jsonb)`,
      OTHER_TENANT_ID,
      `dest-facility-o-${OTHER_TENANT_ID.slice(0, 8)}`,
    );
    for (const [uid, role, name] of users) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users
           (uid, phone, name, role, is_active, status, is_deleted, tenant_id, updated_at)
         VALUES ($1::uuid, $2::text, $3::text, $4::text, TRUE, 'active', FALSE,
                 $5::uuid, NOW())`,
        uid,
        phone(users.findIndex(([candidate]) => candidate === uid) + 1),
        name,
        role,
        TENANT_ID,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  let facilityId;
  let otherTenantFacilityId;
  let inactiveFacilityId;
  let secondFacilityId;

  it('creates, lists, updates, and soft-deletes facility master rows within a tenant', async () => {
    const created = await createReferralFacility(TENANT_ID, {
      name: '  Apollo Speciality <b>Hospital</b>  ',
      facilityType: 'hospital',
      specialties: ['Cardiology', 'cardiology', 'Nephrology'],
      addressLine1: '21 Greams Lane',
      city: 'Chennai',
      state: 'Tamil Nadu',
      pincode: '600006',
      phone: '+91 44 2829 3333',
      email: 'Referrals@Apollo.example',
      contactPerson: 'Referral Desk',
      notes: 'Cashless tie-up',
    }, { actorUid: ADMIN_UID });
    facilityId = created.id;
    expect(created.name).toBe('Apollo Speciality Hospital');
    expect(created.specialties).toEqual(['cardiology', 'nephrology']);
    expect(created.email).toBe('referrals@apollo.example');
    expect(created.active).toBe(true);
    expect(created.createdBy).toBe(ADMIN_UID);

    // Duplicate (case-insensitive name + city) rejected.
    await expect(createReferralFacility(TENANT_ID, {
      name: 'apollo speciality hospital',
      city: 'CHENNAI',
    }, { actorUid: ADMIN_UID })).rejects.toMatchObject({
      statusCode: 409,
      code: 'REFERRAL_FACILITY_DUPLICATE',
    });
    // Same name in a different city is a different facility.
    const second = await createReferralFacility(TENANT_ID, {
      name: 'Apollo Speciality Hospital',
      city: 'Madurai',
      facilityType: 'hospital',
    }, { actorUid: ADMIN_UID });
    secondFacilityId = second.id;

    const updated = await updateReferralFacility(TENANT_ID, facilityId, {
      contactPerson: 'Dr Referral Coordinator',
    }, { actorUid: ADMIN_UID });
    expect(updated.contactPerson).toBe('Dr Referral Coordinator');
    expect(updated.name).toBe('Apollo Speciality Hospital'); // merge keeps existing

    const inactive = await createReferralFacility(TENANT_ID, {
      name: 'Closed Diagnostics',
      facilityType: 'diagnostic',
      city: 'Chennai',
    }, { actorUid: ADMIN_UID });
    inactiveFacilityId = inactive.id;
    const deactivated = await setReferralFacilityActive(
      TENANT_ID, inactiveFacilityId, false, { actorUid: ADMIN_UID },
    );
    expect(deactivated.active).toBe(false);

    const activeOnly = await listReferralFacilities(TENANT_ID, {});
    expect(activeOnly.map((f) => f.id)).not.toContain(inactiveFacilityId);
    const all = await listReferralFacilities(TENANT_ID, { includeInactive: true });
    expect(all.map((f) => f.id)).toContain(inactiveFacilityId);
    const bySpecialty = await listReferralFacilities(TENANT_ID, { q: 'nephro' });
    expect(bySpecialty.map((f) => f.id)).toEqual([facilityId]);

    otherTenantFacilityId = (await createReferralFacility(OTHER_TENANT_ID, {
      name: 'Other Tenant Hospital',
      city: 'Mumbai',
    }, { actorUid: null })).id;
    // Cross-tenant read is a 404.
    await expect(getReferralFacility(TENANT_ID, otherTenantFacilityId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'REFERRAL_FACILITY_NOT_FOUND',
    });
  });

  it('rejects invalid linkage: internal type, wrong tenant, and inactive facility', async () => {
    const base = {
      patient_uid: PATIENT_UID,
      referring_doctor: ORIGINATOR_UID,
      referred_to_department: 'Cardiology',
      reason: 'Needs external cardiology workup',
      urgency: 'routine',
      requester_id: ADMIN_UID,
      tenant_id: TENANT_ID,
      actor_role: 'ADMIN',
    };
    await expect(referralService.createReferral({
      ...base,
      referral_type: 'internal',
      destination_facility_id: facilityId,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'REFERRAL_DESTINATION_FACILITY_EXTERNAL_ONLY',
    });
    await expect(referralService.createReferral({
      ...base,
      referral_type: 'external',
      destination_facility_id: otherTenantFacilityId,
    })).rejects.toMatchObject({
      statusCode: 404,
      code: 'REFERRAL_FACILITY_NOT_FOUND',
    });
    await expect(referralService.createReferral({
      ...base,
      referral_type: 'external',
      destination_facility_id: inactiveFacilityId,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'REFERRAL_FACILITY_INACTIVE',
    });
  });

  let externalReferralId;

  it('persists the linkage on external creation with canonical timeline + audit evidence', async () => {
    const referral = await referralService.createReferral({
      patient_uid: PATIENT_UID,
      referring_doctor: ORIGINATOR_UID,
      referred_to_department: 'Cardiology',
      referral_type: 'external',
      destination_facility_id: facilityId,
      reason: 'Needs external cardiology workup',
      urgency: 'urgent',
      requester_id: ADMIN_UID,
      tenant_id: TENANT_ID,
      actor_role: 'ADMIN',
    });
    externalReferralId = referral.id;
    expect(referral.destination_facility_id).toBe(facilityId);
    expect(referral.destination_facility).toMatchObject({
      id: facilityId,
      name: 'Apollo Speciality Hospital',
      city: 'Chennai',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT destination_facility_id FROM referrals
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID,
      referral.id,
    );
    expect(Number(rows[0].destination_facility_id)).toBe(facilityId);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT payload FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND source_table = 'referrals'
          AND source_id = $2::text AND event_type = 'referral.requested'`,
      TENANT_ID,
      String(referral.id),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].payload).toMatchObject({
      destination_facility_id: facilityId,
      destination_facility_name: 'Apollo Speciality Hospital',
    });
    const audit = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_audit_events
        WHERE tenant_id = $1::uuid AND resource_type = 'referral'
          AND resource_id = $2::text AND action = 'referral.requested'`,
      TENANT_ID,
      String(referral.id),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces the facility in read projections (audit join + list facility object)', async () => {
    const auditView = await referralService.getReferralAudit({ tenantId: TENANT_ID });
    const row = auditView.referrals.find((r) => r.id === externalReferralId);
    expect(row).toMatchObject({
      referral_type: 'external',
      destination_facility_id: facilityId,
      destination_facility_name: 'Apollo Speciality Hospital',
      destination_facility_city: 'Chennai',
    });
    expect(row.destination_facility_phone).toBe('+91 44 2829 3333');

    const outgoing = await referralService.getOutgoingReferrals(ORIGINATOR_UID, {
      tenantId: TENANT_ID,
    });
    const listed = outgoing.referrals.find((r) => r.id === externalReferralId);
    expect(listed.destination_facility).toMatchObject({
      id: facilityId,
      name: 'Apollo Speciality Hospital',
      city: 'Chennai',
    });

    const patientView = await referralService.getPatientReferrals(PATIENT_UID, {
      tenantId: TENANT_ID,
    });
    const patientRow = patientView.referrals.find((r) => r.id === externalReferralId);
    expect(patientRow.destination_facility?.name).toBe('Apollo Speciality Hospital');
  });

  it('records a transition event when the destination facility changes, and replays idempotently', async () => {
    const changed = await setReferralDestinationFacility(externalReferralId, {
      destination_facility_id: secondFacilityId,
      reason: 'Patient prefers Madurai unit',
    }, actor(ORIGINATOR_UID, 'DOCTOR'));
    expect(Number(changed.destination_facility_id)).toBe(secondFacilityId);
    expect(changed.replayed).toBeUndefined();

    const replay = await setReferralDestinationFacility(externalReferralId, {
      destination_facility_id: secondFacilityId,
    }, actor(ORIGINATOR_UID, 'DOCTOR'));
    expect(replay.replayed).toBe(true);

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_payload, canonical_timeline_event_id, canonical_audit_event_id
         FROM referral_transition_events
        WHERE tenant_id = $1::uuid AND referral_id = $2::integer
          AND event_type = 'referral.destination_facility_changed'`,
      TENANT_ID,
      externalReferralId,
    );
    expect(events).toHaveLength(1);
    expect(events[0].event_payload).toMatchObject({
      prior_destination_facility_id: facilityId,
      destination_facility_id: secondFacilityId,
      destination_facility_name: 'Apollo Speciality Hospital',
    });
    expect(events[0].canonical_timeline_event_id).toBeTruthy();
    expect(events[0].canonical_audit_event_id).toBeTruthy();

    // Inactive facility cannot become a destination.
    await expect(setReferralDestinationFacility(externalReferralId, {
      destination_facility_id: inactiveFacilityId,
    }, actor(ORIGINATOR_UID, 'DOCTOR'))).rejects.toMatchObject({
      statusCode: 409,
      code: 'REFERRAL_FACILITY_INACTIVE',
    });
  });

  it('links the facility through the closed-loop external branch: fingerprint, task metadata, transition payload', async () => {
    const request = {
      tenant_id: TENANT_ID,
      patient_uid: PATIENT_UID,
      requester_id: ADMIN_UID,
      referring_doctor: ORIGINATOR_UID,
      referred_to_department: 'Oncology',
      referral_type: 'external',
      destination_facility_id: facilityId,
      reason: 'External oncology opinion',
      urgency: 'routine',
    };
    const created = await createClosedLoopReferral(request, actor(ADMIN_UID, 'ADMIN'));
    expect(Number(created.destination_facility_id)).toBe(facilityId);

    // Same request replays instead of duplicating (facility id participates in
    // the request fingerprint).
    const replay = await createClosedLoopReferral(request, actor(ADMIN_UID, 'ADMIN'));
    expect(replay.replayed).toBe(true);
    expect(Number(replay.id)).toBe(Number(created.id));
    // A different facility is a different request.
    const other = await createClosedLoopReferral({
      ...request,
      destination_facility_id: secondFacilityId,
    }, actor(ADMIN_UID, 'ADMIN'));
    expect(replay.replayed).toBe(true);
    expect(Number(other.id)).not.toBe(Number(created.id));

    const tasks = await prisma.$queryRawUnsafe(
      `SELECT title, metadata FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'external_referral_coordination'
          AND related_resource_id = $2::text`,
      TENANT_ID,
      String(created.id),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('Apollo Speciality Hospital');
    expect(tasks[0].metadata).toMatchObject({
      referral_stage: 'external_coordination',
      destination_facility_id: facilityId,
      destination_facility_name: 'Apollo Speciality Hospital',
      destination_facility_city: 'Chennai',
    });

    const transition = await prisma.$queryRawUnsafe(
      `SELECT event_payload FROM referral_transition_events
        WHERE tenant_id = $1::uuid AND referral_id = $2::integer
          AND event_type = 'referral.requested'`,
      TENANT_ID,
      Number(created.id),
    );
    expect(transition).toHaveLength(1);
    expect(transition[0].event_payload).toMatchObject({
      destination_facility_id: facilityId,
      destination_facility_name: 'Apollo Speciality Hospital',
    });
  });

  it('blocks hard deletion of a facility with referral history (FK RESTRICT) while soft delete stays available', async () => {
    await expect(prisma.$executeRawUnsafe(
      `DELETE FROM referral_facilities WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      facilityId,
    )).rejects.toThrow(/Foreign key constraint/i);
    const softDeleted = await setReferralFacilityActive(
      TENANT_ID, facilityId, false, { actorUid: ADMIN_UID },
    );
    expect(softDeleted.active).toBe(false);
    // Restore for cleanup sanity.
    await setReferralFacilityActive(TENANT_ID, facilityId, true, { actorUid: ADMIN_UID });
  });
});
