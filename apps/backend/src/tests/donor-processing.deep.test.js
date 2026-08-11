// NL-6 N6-3 BB-B donor processing deep test.
//
// Covers TTI approval, reactive cascade to permanent deferral + sibling-unit
// quarantine, component genealogy, traceability, register export format-pending
// evidence, tenant isolation, and the donor-to-transfusion path through the
// existing closed loop.

import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { API_KEY, authClient, generateTestToken } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-00000000d063';
const RUN = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_PHONE = `+9199930${String(Date.now() % 10000).padStart(4, '0')}`;

function tenantClient(role, tenantId) {
  const token = generateTestToken(role, {
    uid: 'd0630000-0000-4000-8000-000000000001',
    id: 1,
    tenant_id: tenantId,
  });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `UPDATE donation_events SET last_tti_test_id = NULL WHERE donation_code LIKE 'N63TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM blood_unit_discard_events
      WHERE unit_id IN (SELECT id FROM blood_units WHERE unit_number LIKE 'N63TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `UPDATE blood_units
        SET parent_unit_id = NULL, component_preparation_id = NULL
      WHERE unit_number LIKE 'N63TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM blood_requests WHERE clinical_indication LIKE 'N63TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM blood_units WHERE unit_number LIKE 'N63TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM component_preparations WHERE preparation_code LIKE 'N63TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tti_tests
      WHERE donation_event_id IN (SELECT id FROM donation_events WHERE donation_code LIKE 'N63TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM donation_events
      WHERE donor_id IN (SELECT id FROM donors WHERE full_name LIKE 'N63TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM donor_deferrals
      WHERE donor_id IN (SELECT id FROM donors WHERE full_name LIKE 'N63TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM donor_screenings
      WHERE donor_id IN (SELECT id FROM donors WHERE full_name LIKE 'N63TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM donor_camps WHERE name LIKE 'N63TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM donors WHERE full_name LIKE 'N63TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'N63TEST Patient'`).catch(() => {});
}

async function createEligibleDonation(label, bloodGroup = 'O+') {
  const donor = await authClient('BLOOD_BANK_TECHNICIAN')
    .post('/api/v1/blood-bank/donors')
    .send({
      full_name: `N63TEST ${label} ${RUN}`,
      phone: `99930${RUN}${label.length}`,
      gender: 'male',
      date_of_birth: '1990-01-01',
      blood_group: bloodGroup,
      address: 'N6-3 donor processing fixture',
    });
  expect(donor.status).toBe(201);
  const donorId = Number(donor.body.data.donor.id);

  const screening = await authClient('BLOOD_BANK_TECHNICIAN')
    .post(`/api/v1/blood-bank/donors/${donorId}/screenings`)
    .send({
      questionnaire: {},
      vitals: {
        weight_kg: 70,
        hemoglobin_g_dl: 14.2,
        systolic_bp: 116,
        diastolic_bp: 72,
        temperature_c: 36.8,
      },
    });
  expect(screening.status).toBe(201);

  const donation = await authClient('BLOOD_BANK_TECHNICIAN')
    .post(`/api/v1/blood-bank/donors/${donorId}/donations`)
    .send({
      screening_id: Number(screening.body.data.screening.id),
      donation_code: `N63TEST-${label}-${RUN}`,
      donation_barcode: `N63TEST-${label}-${RUN}-BAR`,
      collection_kind: 'in_house',
      volume_ml: 450,
      pre_vitals: { bp: '116/72' },
      post_vitals: { bp: '112/70' },
    });
  expect(donation.status).toBe(201);
  return { donorId, donationId: Number(donation.body.data.id) };
}

d('Blood-bank donor processing cycle', () => {
  let reactiveDonationId;
  let reactiveDonorId;
  let quarantinedUnitId;
  let passDonationId;
  let passUnitId;
  let patientUid;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'N63 Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
      `n63-tenant-b-${RUN}`,
    );
    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, blood_group, updated_at)
       VALUES ($1, 'N63TEST Patient', 'PATIENT', true, 'O+', NOW())
       RETURNING uid`,
      PATIENT_PHONE,
    );
    patientUid = patient[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('prepares sibling components while TTI is pending, then reactive TTI permanently defers donor and quarantines units', async () => {
    const fixture = await createEligibleDonation('Reactive');
    reactiveDonorId = fixture.donorId;
    reactiveDonationId = fixture.donationId;

    const prepared = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/donations/${reactiveDonationId}/components`)
      .send({
        preparation_code: `N63TEST-PREP-REACTIVE-${RUN}`,
        parent_unit_number: `N63TEST-REACTIVE-WB-${RUN}`,
        components: [
          { component: 'prbc', unit_number: `N63TEST-REACTIVE-PRBC-${RUN}`, volume_ml: 250 },
          { component: 'ffp', unit_number: `N63TEST-REACTIVE-FFP-${RUN}`, volume_ml: 160 },
        ],
      });
    expect(prepared.status).toBe(201);
    expect(prepared.body.data.units.every((unit) => unit.status === 'quarantined')).toBe(true);
    quarantinedUnitId = Number(prepared.body.data.units[0].id);

    const tti = await authClient('PATHOLOGIST')
      .post(`/api/v1/blood-bank/donations/${reactiveDonationId}/tti-tests`)
      .send({
        results: {
          hiv: 'non_reactive',
          hbsag: 'reactive',
          hcv: 'non_reactive',
          syphilis: 'non_reactive',
          malaria: 'non_reactive',
        },
      });
    expect(tti.status).toBe(201);
    expect(tti.body.data.tti_test.overall_result).toBe('reactive');
    expect(tti.body.data.cascade.donor_deferred).toBe(true);

    const donor = await prisma.$queryRawUnsafe(
      `SELECT status, eligibility_status FROM donors WHERE id = $1::int`,
      reactiveDonorId,
    );
    expect(donor[0]).toMatchObject({ status: 'deferred_permanent', eligibility_status: 'deferred_permanent' });

    const units = await prisma.$queryRawUnsafe(
      `SELECT status, quarantine_reason
         FROM blood_units
        WHERE donation_event_id = $1::int
        ORDER BY unit_number`,
      reactiveDonationId,
    );
    expect(units).toHaveLength(3);
    expect(units.every((unit) => unit.status === 'quarantined')).toBe(true);
    expect(units.every((unit) => String(unit.quarantine_reason).includes('Reactive TTI'))).toBe(true);
  });

  test('traceability exposes donor, donation, sibling components and human discard confirmation', async () => {
    const trace = await authClient('BLOOD_BANK_TECHNICIAN')
      .get('/api/v1/blood-bank/units/traceability')
      .query({ unit_id: quarantinedUnitId });
    expect(trace.status).toBe(200);
    expect(trace.body.data.donor.id).toBe(reactiveDonorId);
    expect(trace.body.data.siblings.length).toBeGreaterThanOrEqual(1);
    expect(trace.body.data.tti_tests[0].overall_result).toBe('reactive');

    const discard = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/units/${quarantinedUnitId}/discard-confirmation`)
      .send({ reason: 'Confirmed reactive TTI discard after pathologist review' });
    expect(discard.status).toBe(200);
    expect(discard.body.data.unit.status).toBe('discarded');
  });

  test('non-reactive TTI releases prepared components into the existing transfusion loop', async () => {
    const fixture = await createEligibleDonation('Pass');
    passDonationId = fixture.donationId;

    const tti = await authClient('PATHOLOGIST')
      .post(`/api/v1/blood-bank/donations/${passDonationId}/tti-tests`)
      .send({
        results: {
          hiv: 'non_reactive',
          hbsag: 'non_reactive',
          hcv: 'non_reactive',
          syphilis: 'non_reactive',
          malaria: 'non_reactive',
        },
      });
    expect(tti.status).toBe(201);

    const prepared = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/donations/${passDonationId}/components`)
      .send({
        preparation_code: `N63TEST-PREP-PASS-${RUN}`,
        parent_unit_number: `N63TEST-PASS-WB-${RUN}`,
        components: [
          { component: 'prbc', unit_number: `N63TEST-PASS-PRBC-${RUN}`, volume_ml: 250 },
        ],
      });
    expect(prepared.status).toBe(201);
    expect(prepared.body.data.units[0].status).toBe('available');
    passUnitId = Number(prepared.body.data.units[0].id);

    const req = await authClient('DOCTOR')
      .post('/api/v1/blood-bank/request')
      .set('Idempotency-Key', `n63-request-${RUN}`)
      .send({
        patient_uid: patientUid,
        blood_group: 'O+',
        component: 'prbc',
        units: 1,
        urgency: 'urgent',
        clinical_indication: 'N63TEST donor-to-transfusion loop',
      });
    expect(req.status).toBe(201);
    const requestId = Number(req.body.data.id);

    const crossmatch = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/${requestId}/crossmatch-unit`)
      .send({ unit_id: passUnitId, result: 'compatible' });
    expect(crossmatch.status).toBe(200);

    const issue = await authClient('BLOOD_BANK_TECHNICIAN')
      .put(`/api/v1/blood-bank/${requestId}/issue`)
      .send({});
    expect(issue.status).toBe(200);

    const first = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/verify-bedside`)
      .send({
        verifier_role: 'first',
        scanned_unit_number: `N63TEST-PASS-PRBC-${RUN}`,
        scanned_patient_uid: patientUid,
      });
    expect(first.status).toBe(200);

    const { recordBedsideVerification } = await import('../services/bloodbank/transfusionSafetyService.js');
    await recordBedsideVerification(requestId, {
      verifierRole: 'second',
      scannedUnitNumber: `N63TEST-PASS-PRBC-${RUN}`,
      scannedPatientUid: patientUid,
    }, {
      tenantId: DEFAULT_TENANT_ID,
      actorUid: 'd0630000-2222-4000-8000-000000000002',
      actorRole: 'NURSING_INCHARGE',
    });

    const start = await authClient('NURSING_STAFF').post(`/api/v1/blood-bank/${requestId}/start-transfusion`).send({});
    expect(start.status).toBe(200);
    const complete = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/complete-transfusion`)
      .send({ notes: 'N63TEST uneventful transfusion' });
    expect(complete.status).toBe(200);

    const trace = await authClient('BLOOD_BANK_TECHNICIAN')
      .get('/api/v1/blood-bank/units/traceability')
      .query({ unit_id: passUnitId });
    expect(trace.status).toBe(200);
    expect(trace.body.data.transfusion.request_id).toBe(requestId);
    expect(trace.body.data.unit.status).toBe('transfused');
  });

  test('register exports are available and flagged format pending', async () => {
    const ttiRegister = await authClient('BLOOD_BANK_TECHNICIAN')
      .get('/api/v1/blood-bank/registers/tti')
      .query({ format: 'json' });
    expect(ttiRegister.status).toBe(200);
    expect(ttiRegister.body.data.format_pending).toBe(true);
    expect(ttiRegister.body.data.rows.some((row) => String(row.donation_code).includes('N63TEST'))).toBe(true);

    const pdf = await authClient('BLOOD_BANK_TECHNICIAN')
      .get('/api/v1/blood-bank/registers/discard')
      .query({ format: 'pdf' });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  test('unit traceability is tenant scoped', async () => {
    const tenantBDonor = await prisma.$queryRawUnsafe(
      `INSERT INTO donors (tenant_id, full_name, phone, blood_group, registered_by)
       VALUES ($1::uuid, 'N63TEST Tenant B Donor', '+919999888877', 'A+', $2::uuid)
       RETURNING id, donor_uid`,
      TENANT_B,
      'd0630000-0000-4000-8000-000000000002',
    );
    const tenantBDonation = await prisma.$queryRawUnsafe(
      `INSERT INTO donation_events
         (tenant_id, donor_id, donation_code, donation_barcode, collection_kind, volume_ml, tti_status)
       VALUES ($1::uuid, $2::int, $3, $4, 'in_house', 450, 'non_reactive')
       RETURNING id`,
      TENANT_B,
      Number(tenantBDonor[0].id),
      `N63TEST-TENANT-B-${RUN}`,
      `N63TEST-TENANT-B-${RUN}-BAR`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO blood_units
         (tenant_id, unit_number, blood_group, component, status, expiry_date, donor_id, donation_event_id, donor_ref)
       VALUES ($1::uuid, $2, 'A+', 'prbc', 'available', '2027-01-01', $3::int, $4::int, $5)`,
      TENANT_B,
      `N63TEST-TENANT-B-UNIT-${RUN}`,
      Number(tenantBDonor[0].id),
      Number(tenantBDonation[0].id),
      String(tenantBDonor[0].donor_uid),
    );

    const defaultTenant = await authClient('BLOOD_BANK_TECHNICIAN')
      .get('/api/v1/blood-bank/units/traceability')
      .query({ unit_number: `N63TEST-TENANT-B-UNIT-${RUN}` });
    expect(defaultTenant.status).toBe(404);

    const tenantB = await tenantClient('BLOOD_BANK_TECHNICIAN', TENANT_B)
      .get('/api/v1/blood-bank/units/traceability')
      .query({ unit_number: `N63TEST-TENANT-B-UNIT-${RUN}` });
    expect(tenantB.status).toBe(200);
    expect(tenantB.body.data.donor.full_name).toBe('N63TEST Tenant B Donor');
  });
});
