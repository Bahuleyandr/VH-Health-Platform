/**
 * E2E Integration Flow Tests
 * registration → booking → investigation → pharmacy → billing
 *
 * These tests exercise full vertical slices of the API, chaining
 * outputs from one step as inputs to the next. Every step asserts its
 * exact expected status — the earlier "status-or-500" sets let the whole
 * journey silently no-op when step 1 failed.
 */

import { authClient } from './testClient.js';
import { setTenantTx } from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const admin = authClient('ADMIN');

// Shared state — populated as each step runs
const flow = {
  patientPhone: `9${Date.now().toString().slice(-9)}`, // unique phone per run
  patientUid: null,
  appointmentId: null,
  investigationId: null,
  invoiceId: null,
};

// ─── Step 1: User Registration ───────────────────────────────────────────────

describe('E2E Flow — Step 1: Patient Registration', () => {
  it('should register a new patient', async () => {
    const res = await admin.post('/api/v1/users/profile').send({
      phone: flow.patientPhone,
      name: 'E2E Test Patient',
      gender: 'MALE',
      role: 'PATIENT',
    });
    expect(res.statusCode).toBe(200);
    const user = res.body?.data?.user;
    expect(user?.uid).toBeDefined();
    flow.patientUid = user.uid;
  });

  it('should look up patient by phone', async () => {
    const res = await admin.get(`/api/v1/users/${flow.patientPhone}`);
    expect(res.statusCode).toBe(200);
  });
});

// ─── Step 2: Appointment Booking ─────────────────────────────────────────────

describe('E2E Flow — Step 2: Appointment Booking', () => {
  // The seeded staff block's insertion ORDER is not a contract — it has
  // already shifted once (the seed now creates nursing/pharmacy/lab staff
  // ahead of the doctor), which silently turned a hard-coded doctor_id into
  // a 400 'Doctor not found'. Resolve the canonical users.id of a seeded,
  // active DOCTOR that owns an active doctors profile at run time instead.
  // A bare doctors.id is deliberately NOT used: doctorRefService rejects one
  // that collides with a non-doctor user as AMBIGUOUS_DOCTOR_REF.
  let doctorUserId = null;

  beforeAll(async () => {
    await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT doctor_user.id
           FROM users doctor_user
           JOIN doctors doctor_profile
             ON doctor_profile.user_id = doctor_user.id
            AND doctor_profile.is_active = TRUE
          WHERE doctor_user.tenant_id=$1::uuid AND doctor_user.role='DOCTOR'
            AND doctor_user.is_active = TRUE
          ORDER BY doctor_user.id
          LIMIT 1`,
        DEFAULT_TENANT_ID,
      );
      if (!rows.length) {
        throw new Error(
          'E2E booking fixture requires a seeded active DOCTOR with a doctors profile',
        );
      }
      doctorUserId = Number(rows[0].id);
    });
  });

  it('should book an appointment', async () => {
    const slotSeed = Date.now();
    const appointmentDate = new Date(
      slotSeed + (30 + (slotSeed % 120)) * 86400000,
    ).toISOString().split('T')[0];
    let res;
    for (let attempt = 0; attempt < 12; attempt++) {
      const hour = 9 + Math.floor(attempt / 2);
      const minute = attempt % 2 === 0 ? '00' : '30';
      res = await admin.post('/api/v1/appointments').send({
        phone: flow.patientPhone,
        doctor_id: doctorUserId,
        doctor_name: 'Dr. Test',
        appointment_date: appointmentDate,
        appointment_time: `${String(hour).padStart(2, '0')}:${minute}`,
        reason: 'E2E test consultation',
      });
      if (res.statusCode !== 409) break;
    }
    expect([200, 201]).toContain(res.statusCode);
    const data = res.body?.data ?? res.body;
    if (data?.id) flow.appointmentId = data.id;
  });

  it('should fetch appointments by phone', async () => {
    const res = await admin.get(`/api/v1/appointments/phone/${flow.patientPhone}`);
    expect(res.statusCode).toBe(200);
  });
});

// ─── Step 3: Investigation Order ─────────────────────────────────────────────

describe('E2E Flow — Step 3: Investigation', () => {
  it('should reject investigation without required fields', async () => {
    const res = await admin.post('/api/v1/investigations').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should create investigation order', async () => {
    const res = await admin.post('/api/v1/investigations').send({
      phone: flow.patientPhone,
      test_name: 'Complete Blood Count',
      test_type: 'HAEMATOLOGY',
    });
    expect([200, 201]).toContain(res.statusCode);
    const data = res.body?.data ?? res.body;
    if (data?.id) flow.investigationId = data.id;
  });

  it('should fetch investigations by patient uid', async () => {
    // There is no by-phone list route — /:phone would match /:id and 404.
    const res = await admin.get(`/api/v1/investigations/uid/${flow.patientUid}`);
    expect(res.statusCode).toBe(200);
  });
});

// ─── Step 4: Pharmacy Order ───────────────────────────────────────────────────

describe('E2E Flow — Step 4: Pharmacy Order', () => {
  // The staff queue sits behind resolvePharmacyFacility
  // (services/pharmacy/pharmacyFacilityAuthorityService.js), which enforces the
  // full pharmacy custody model:
  //   1. EXACTLY ONE active is_default facility on the tenant
  //      (uq_facility_default already caps it at one),
  //   2. an actor whose active users row carries a FACILITY_OPERATION_ROLES
  //      role AND an active, unarchived staff row (actor.staff_id must
  //      resolve), and
  //   3. exactly one ACTIVE pharmacy_staff_facility_grants row binding that
  //      actor to that facility.
  // The comprehensive seed deliberately keeps SEED-MAIN NON-default (its
  // medication fixtures name the facility explicitly) and seeds no grants,
  // and the suite-wide fixture ADMIN has a users row but no staff row — so
  // this block provisions custody the way a tenant admin would configure a
  // live tenant, acting as the seeded staff-backed ADMIN, then restores the
  // seed shape for the later jest chunks that share this database.
  let custodian = null;
  let promotedFacilityId = null;
  let seededGrantId = null;

  beforeAll(async () => {
    await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
      // (1) One active default facility. Reuse a pre-existing default when the
      // tenant already has one; otherwise promote the seeded SEED-MAIN row for
      // the duration of this describe block only.
      const defaults = await tx.$queryRawUnsafe(
        `SELECT id
           FROM facilities
          WHERE tenant_id=$1::uuid AND status='active' AND is_default=TRUE
          ORDER BY id
          LIMIT 2`,
        DEFAULT_TENANT_ID,
      );
      let facilityId = defaults.length === 1 ? Number(defaults[0].id) : null;
      if (!facilityId) {
        const promoted = await tx.$queryRawUnsafe(
          `UPDATE facilities
              SET is_default=TRUE, updated_at=NOW()
            WHERE tenant_id=$1::uuid AND facility_code='SEED-MAIN'
              AND status='active'
            RETURNING id`,
          DEFAULT_TENANT_ID,
        );
        if (promoted.length !== 1) {
          throw new Error(
            'E2E pharmacy fixture requires the active seeded SEED-MAIN facility',
          );
        }
        facilityId = Number(promoted[0].id);
        promotedFacilityId = facilityId;
      }

      // (2) The queue actor: the seeded ADMIN that already carries an active
      // staff row (the seed's "Test Admin"). The suite-wide fixture ADMIN has
      // no staff identity, so it can never hold facility custody.
      const actors = await tx.$queryRawUnsafe(
        `SELECT actor.id, actor.uid
           FROM users actor
           JOIN staff
             ON staff.tenant_id=actor.tenant_id AND staff.user_id=actor.uid
            AND staff.is_active=TRUE AND staff.archived=FALSE
          WHERE actor.tenant_id=$1::uuid AND actor.role='ADMIN'
            AND actor.is_active=TRUE AND actor.status='active'
            AND actor.is_deleted=FALSE AND actor.merged_into_uid IS NULL
          ORDER BY actor.id
          LIMIT 1`,
        DEFAULT_TENANT_ID,
      );
      if (!actors.length) {
        throw new Error(
          'E2E pharmacy fixture requires the seeded staff-backed ADMIN user',
        );
      }
      const actorUid = String(actors[0].uid);

      // (3) Exactly one active grant for that (actor, facility) pair —
      // ux_pharmacy_staff_facility_grant_active_753 caps it at one.
      const grants = await tx.$queryRawUnsafe(
        `SELECT id::text AS id
           FROM pharmacy_staff_facility_grants
          WHERE tenant_id=$1::uuid AND staff_uid=$2::uuid AND facility_id=$3::int
            AND status='active' AND revoked_at IS NULL
          LIMIT 1`,
        DEFAULT_TENANT_ID,
        actorUid,
        facilityId,
      );
      if (!grants.length) {
        const inserted = await tx.$queryRawUnsafe(
          `INSERT INTO pharmacy_staff_facility_grants
             (tenant_id, facility_id, staff_uid, status, grant_source,
              grant_reason, granted_by)
           VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'test_fixture',
                   'E2E flow step-4 pharmacy queue custody fixture', $3::uuid)
           RETURNING id::text AS id`,
          DEFAULT_TENANT_ID,
          facilityId,
          actorUid,
        );
        seededGrantId = inserted[0].id;
      }

      custodian = authClient('ADMIN', {
        uid: actorUid,
        id: Number(actors[0].id),
      });
    });
  });

  afterAll(async () => {
    await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
      if (seededGrantId != null) {
        await tx.$executeRawUnsafe(
          `DELETE FROM pharmacy_staff_facility_grants
            WHERE tenant_id=$1::uuid AND id=$2::bigint`,
          DEFAULT_TENANT_ID,
          seededGrantId,
        );
      }
      if (promotedFacilityId != null) {
        await tx.$executeRawUnsafe(
          `UPDATE facilities
              SET is_default=FALSE, updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::int`,
          DEFAULT_TENANT_ID,
          promotedFacilityId,
        );
      }
    });
  });

  it('should reject pharmacy order without required fields', async () => {
    const res = await admin.post('/api/v1/pharmacy-orders/orders/place').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should fetch pharmacy order queue', async () => {
    const res = await custodian.get('/api/v1/pharmacy-orders/orders/queue');
    expect(res.statusCode).toBe(200);
  });
});

// ─── Step 5: Billing — Create Invoice ────────────────────────────────────────

describe('E2E Flow — Step 5: Billing', () => {
  it('should reject invoice without patient_uid', async () => {
    const res = await admin.post('/api/v1/billing/invoice').send({
      total_amount: 500,
    });
    expect(res.statusCode).toBe(400);
  });

  it('should create invoice for the registered patient', async () => {
    expect(flow.patientUid).toBeDefined();
    const res = await admin.post('/api/v1/billing/invoice').send({
      patient_uid: flow.patientUid,
      type: 'consultation',
      items: [{ description: 'Consultation fee', quantity: 1, unit_price: 500, amount: 500 }],
      subtotal: 500,
      total_amount: 500,
      payment_method: 'cash',
    });
    expect([200, 201]).toContain(res.statusCode);
    const data = res.body?.data ?? res.body;
    expect(data?.id).toBeDefined();
    flow.invoiceId = data.id;
  });

  it('should fetch invoices for the patient', async () => {
    const res = await admin.get(`/api/v1/billing/invoices/patient/${flow.patientUid}`);
    expect(res.statusCode).toBe(200);
  });

  it('should record a payment against the invoice', async () => {
    expect(flow.invoiceId).toBeDefined();
    const res = await admin
      .post(`/api/v1/billing/invoice/${flow.invoiceId}/payment`)
      .send({ amount: 500, payment_method: 'cash' });
    expect([200, 201]).toContain(res.statusCode);
  });
});

// ─── Step 6: Revenue Stats ────────────────────────────────────────────────────

describe('E2E Flow — Step 6: Revenue Check', () => {
  it('should reject revenue stats without date range', async () => {
    const res = await admin.get('/api/v1/billing/revenue');
    expect(res.statusCode).toBe(400);
  });

  it('should return revenue stats for today', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await admin.get(
      `/api/v1/billing/revenue?date_from=${today}&date_to=${today}`,
    );
    expect(res.statusCode).toBe(200);
  });
});
