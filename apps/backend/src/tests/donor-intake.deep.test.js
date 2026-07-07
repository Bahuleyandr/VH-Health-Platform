// NL-6 N6-2 BB-A donor intake deep test.
//
// Donor-subject lifecycle: register donor, screen to auto-deferral,
// reactivate, screen eligible, capture immutable consent, collect a donation
// with barcode evidence and an adverse reaction. Donor writes must stay out of
// the patient-keyed canonical clinical timeline.

import prisma from '../lib/prisma.js';
import { authClient, generateTestToken, API_KEY } from './testClient.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-00000000d062';
const RUN = String(Date.now() % 100000).padStart(5, '0');

function tenantClient(role, tenantId) {
  const token = generateTestToken(role, {
    uid: 'd0620000-0000-4000-8000-000000000001',
    id: 1,
    tenant_id: tenantId,
  });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM donor_consents
      WHERE donor_id IN (SELECT id FROM donors WHERE full_name LIKE 'D062TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM donation_events
      WHERE donor_id IN (SELECT id FROM donors WHERE full_name LIKE 'D062TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM donor_deferrals
      WHERE donor_id IN (SELECT id FROM donors WHERE full_name LIKE 'D062TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM donor_screenings
      WHERE donor_id IN (SELECT id FROM donors WHERE full_name LIKE 'D062TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM donors WHERE full_name LIKE 'D062TEST%'`).catch(() => {});
}

d('Blood-bank donor intake cycle', () => {
  let donorId;
  let deferralId;
  let eligibleScreeningId;
  let consentId;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'D062 Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
      `d062-tenant-b-${RUN}`,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('registers donor and requires override for a near duplicate', async () => {
    const res = await authClient('BLOOD_BANK_TECHNICIAN')
      .post('/api/v1/blood-bank/donors')
      .send({
        full_name: `D062TEST Donor ${RUN}`,
        phone: `99910${RUN}`,
        gender: 'female',
        date_of_birth: '1991-03-14',
        blood_group: 'O+',
        address: 'N6-2 donor fixture',
      });
    expect(res.status).toBe(201);
    donorId = Number(res.body.data.donor.id);
    expect(res.body.data.donor.blood_group).toBe('O+');

    const duplicate = await authClient('BLOOD_BANK_TECHNICIAN')
      .post('/api/v1/blood-bank/donors')
      .send({
        full_name: `D062TEST Donor ${RUN}`,
        phone: `99910${RUN}`,
        date_of_birth: '1991-03-14',
        blood_group: 'O+',
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.details.code || duplicate.body.details.matches).toBeTruthy();
  });

  test('screens to an automatic temporary deferral', async () => {
    const res = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/donors/${donorId}/screenings`)
      .send({
        questionnaire: { recent_fever: true },
        vitals: {
          weight_kg: 42,
          hemoglobin_g_dl: 11.6,
          systolic_bp: 118,
          diastolic_bp: 74,
          temperature_c: 36.9,
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.screening.verdict).toBe('deferred_temporary');
    expect(res.body.data.deferral.reason_code).toBe('LOW_WEIGHT');
    deferralId = Number(res.body.data.deferral.id);

    const donorRows = await prisma.$queryRawUnsafe(
      `SELECT status, eligibility_status FROM donors WHERE id = $1::int`,
      donorId,
    );
    expect(donorRows[0]).toMatchObject({
      status: 'deferred_temporary',
      eligibility_status: 'deferred_temporary',
    });
  });

  test('reactivates the deferral and then records an eligible screening', async () => {
    const reactivate = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/donors/${donorId}/deferrals/${deferralId}/reactivate`)
      .send({ reactivation_reason: 'Repeat evaluation cleared temporary fever and low weight concern' });
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.data.status).toBe('reactivated');

    const eligible = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/donors/${donorId}/screenings`)
      .send({
        questionnaire: {},
        vitals: {
          weight_kg: 62,
          hemoglobin_g_dl: 13.2,
          systolic_bp: 116,
          diastolic_bp: 72,
          temperature_c: 36.7,
        },
      });
    expect(eligible.status).toBe(201);
    expect(eligible.body.data.screening.verdict).toBe('eligible');
    eligibleScreeningId = Number(eligible.body.data.screening.id);
  });

  test('captures immutable consent and blocks direct mutation', async () => {
    const consent = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/donors/${donorId}/consents`)
      .send({
        consent_statement: 'I consent to voluntary blood donation and screening.',
        signer_name: `D062TEST Donor ${RUN}`,
        consent_payload: { language: 'en-IN', witnessed: true },
      });
    expect(consent.status).toBe(201);
    consentId = Number(consent.body.data.id);
    expect(consent.body.data.sha256_hash).toMatch(/^[0-9a-f]{64}$/);

    await expect(prisma.$executeRawUnsafe(
      `UPDATE donor_consents SET signer_name = 'Changed' WHERE id = $1::int`,
      consentId,
    )).rejects.toThrow(/immutable/);
  });

  test('collects donation with barcode evidence and adverse donor reaction', async () => {
    const res = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/donors/${donorId}/donations`)
      .send({
        screening_id: eligibleScreeningId,
        donation_barcode: `D062-${RUN}-BARCODE`,
        collection_kind: 'in_house',
        volume_ml: 450,
        pre_vitals: { bp: '116/72', pulse: 76 },
        post_vitals: { bp: '112/70', pulse: 82 },
        adverse_reaction: true,
        adverse_reaction_type: 'vasovagal',
        adverse_reaction_severity: 'mild',
        adverse_reaction_notes: 'Light-headed after collection; recovered supine.',
        adverse_reaction_intervention: 'Oral fluids and observation.',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.donation_barcode).toBe(`D062-${RUN}-BARCODE`);
    expect(res.body.data.adverse_reaction).toBe(true);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, eligibility_status, last_donated_at FROM donors WHERE id = $1::int`,
      donorId,
    );
    expect(rows[0].eligibility_status).toBe('collected');
    expect(rows[0].last_donated_at).toBeTruthy();
  });

  test('keeps donor-subject writes out of clinical_timeline_events', async () => {
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type
         FROM clinical_timeline_events
        WHERE source_table IN ('donors', 'donor_screenings', 'donor_deferrals', 'donation_events', 'donor_consents')`,
    );
    expect(timeline).toHaveLength(0);

    const audits = await prisma.$queryRawUnsafe(
      `SELECT action
         FROM audit_logs
        WHERE resource = 'donors'
          AND resource_id = $1::text
        ORDER BY created_at ASC`,
      String(donorId),
    );
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining([
      'BLOOD_DONOR_REGISTERED',
      'BLOOD_DONOR_DEFERRED',
      'BLOOD_DONOR_DEFERRAL_REACTIVATED',
      'BLOOD_DONOR_SCREENED_ELIGIBLE',
      'BLOOD_DONOR_CONSENT_CAPTURED',
      'BLOOD_DONATION_COLLECTED_WITH_REACTION',
    ]));
  });

  test('donor list is tenant scoped', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO donors (tenant_id, full_name, phone, blood_group, registered_by)
       VALUES ($1::uuid, 'D062TEST Tenant B Donor', '+919999999999', 'A+', $2::uuid)`,
      TENANT_B,
      'd0620000-0000-4000-8000-000000000002',
    );

    const defaultList = await authClient('BLOOD_BANK_TECHNICIAN')
      .get('/api/v1/blood-bank/donors')
      .query({ q: 'D062TEST' });
    expect(defaultList.status).toBe(200);
    expect(defaultList.body.data.some((donor) => donor.full_name === 'D062TEST Tenant B Donor')).toBe(false);

    const tenantBList = await tenantClient('BLOOD_BANK_TECHNICIAN', TENANT_B)
      .get('/api/v1/blood-bank/donors')
      .query({ q: 'D062TEST' });
    expect(tenantBList.status).toBe(200);
    expect(tenantBList.body.data.some((donor) => donor.full_name === 'D062TEST Tenant B Donor')).toBe(true);
  });
});
