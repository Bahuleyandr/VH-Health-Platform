import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_UID = '22222222-2222-4222-8222-222222222201';
const PATIENT_UID = '22222222-2222-4222-8222-222222222202';
const SECOND_PATIENT_UID = '22222222-2222-4222-8222-222222222203';
const OTHER_PATIENT_UID = '22222222-2222-4222-8222-222222222204';
const ENCOUNTER_ID = '22222222-2222-4222-8222-222222222205';
const SECOND_ENCOUNTER_ID = '22222222-2222-4222-8222-222222222206';
const OTHER_ENCOUNTER_ID = '22222222-2222-4222-8222-222222222207';

function authed(role, uid) {
  const token = generateTestToken(role, { uid, id: 9201 });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function expectStatus(response, expected, label) {
  if (response.statusCode !== expected) {
    throw new Error(`${label} expected ${expected}, received ${response.statusCode}: ${JSON.stringify(response.body)}`);
  }
}

describe('admin forecast routes', () => {
  const admin = authed('ADMIN', ADMIN_UID);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'forecast-other', 'Forecast Other Tenant', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      OTHER_TENANT_ID
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs
       WHERE action IN (
         'CLINICAL_AI_BED_FORECAST_GENERATED',
         'CLINICAL_AI_PHARMACY_STOCKOUT_FORECAST_GENERATED'
       )`
    );
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_bed_forecasts WHERE tenant_id IN ($1::uuid, $2::uuid)`, DEFAULT_TENANT_ID, OTHER_TENANT_ID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_pharmacy_forecasts WHERE tenant_id IN ($1::uuid, $2::uuid)`, DEFAULT_TENANT_ID, OTHER_TENANT_ID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE order_number LIKE 'FORECAST-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      SECOND_PATIENT_UID,
      OTHER_PATIENT_UID
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      ADMIN_UID,
      PATIENT_UID,
      SECOND_PATIENT_UID,
      OTHER_PATIENT_UID
    ).catch(() => {});

    await prisma.$executeRawUnsafe(
      `UPDATE clinical_ai_modules
       SET enabled = true
       WHERE module_key IN ('bed_discharge_forecast', 'pharmacy_stockout_predictor')`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, gender, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, '9292000001', 'Forecast Admin', 'ADMIN', 'female', true, $5::uuid, NOW()),
         ($2::uuid, '9292000002', 'Forecast Patient A', 'PATIENT', 'female', true, $5::uuid, NOW()),
         ($3::uuid, '9292000003', 'Forecast Patient B', 'PATIENT', 'male', true, $5::uuid, NOW()),
         ($4::uuid, '9292000004', 'Other Tenant Patient', 'PATIENT', 'male', true, $6::uuid, NOW())`,
      ADMIN_UID,
      PATIENT_UID,
      SECOND_PATIENT_UID,
      OTHER_PATIENT_UID,
      DEFAULT_TENANT_ID,
      OTHER_TENANT_ID
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, encounter_id, admitting_doctor, attending_doctor, status,
          admission_type, priority, chief_complaint, admitting_diagnosis,
          ward, bed_number, code_status, admitted_at, expected_los_days, created_by, created_at)
       VALUES
         ($1::uuid, $4::uuid, $5::uuid, $5::uuid, 'admitted',
          'planned', 'routine', 'Forecast A', 'Observation',
          'WARD-FC', 'FC-01', 'full_code', NOW() - INTERVAL '2 days', 3, $5::uuid, NOW() - INTERVAL '2 days'),
         ($2::uuid, $6::uuid, $5::uuid, $5::uuid, 'admitted',
          'planned', 'routine', 'Forecast B', 'Observation',
          'WARD-FC', 'FC-02', 'full_code', NOW() - INTERVAL '1 day', 5, $5::uuid, NOW() - INTERVAL '1 day'),
         ($3::uuid, $7::uuid, $5::uuid, $5::uuid, 'admitted',
          'planned', 'routine', 'Other tenant forecast', 'Observation',
          'WARD-FC', 'FC-99', 'full_code', NOW() - INTERVAL '3 days', 3, $5::uuid, NOW() - INTERVAL '3 days')`,
      PATIENT_UID,
      SECOND_PATIENT_UID,
      OTHER_PATIENT_UID,
      ENCOUNTER_ID,
      ADMIN_UID,
      SECOND_ENCOUNTER_ID,
      OTHER_ENCOUNTER_ID
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, encounter_id, patient_uid, order_type, priority, details, status, ordered_by, created_at)
       SELECT 'FORECAST-DEFAULT-' || gs, $1::uuid, $2::uuid, 'medication', 'routine',
              jsonb_build_object('medication_name', 'Ceftriaxone'), 'ordered', $3::uuid, NOW() - INTERVAL '1 day'
       FROM generate_series(1, 6) AS gs`,
      ENCOUNTER_ID,
      PATIENT_UID,
      ADMIN_UID
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, encounter_id, patient_uid, order_type, priority, details, status, ordered_by, created_at)
       SELECT 'FORECAST-OTHER-' || gs, $1::uuid, $2::uuid, 'medication', 'routine',
              jsonb_build_object('medication_name', 'OtherTenantDrug'), 'ordered', $3::uuid, NOW() - INTERVAL '1 day'
      FROM generate_series(1, 25) AS gs`,
      OTHER_ENCOUNTER_ID,
      OTHER_PATIENT_UID,
      ADMIN_UID
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE clinical_ai_modules
       SET enabled = false
       WHERE module_key IN ('bed_discharge_forecast', 'pharmacy_stockout_predictor')`
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs
       WHERE action IN (
         'CLINICAL_AI_BED_FORECAST_GENERATED',
         'CLINICAL_AI_PHARMACY_STOCKOUT_FORECAST_GENERATED'
       )`
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_bed_forecasts WHERE tenant_id IN ($1::uuid, $2::uuid)`, DEFAULT_TENANT_ID, OTHER_TENANT_ID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_pharmacy_forecasts WHERE tenant_id IN ($1::uuid, $2::uuid)`, DEFAULT_TENANT_ID, OTHER_TENANT_ID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE order_number LIKE 'FORECAST-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      SECOND_PATIENT_UID,
      OTHER_PATIENT_UID
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      ADMIN_UID,
      PATIENT_UID,
      SECOND_PATIENT_UID,
      OTHER_PATIENT_UID
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, OTHER_TENANT_ID).catch(() => {});
  });

  it('generates tenant-scoped bed and pharmacy forecasts with audit logs', async () => {
    const beds = await admin.get('/api/v1/admin/forecast/beds?ward=WARD-FC&window_hours=24');
    expectStatus(beds, 200, 'bed forecast');
    expect(beds.body.data.admitted_count).toBe(2);
    expect(beds.body.data.patients.map((patient) => patient.patient_uid)).not.toContain(OTHER_PATIENT_UID);
    expect(beds.body.data.likely_discharges_48h).toBeGreaterThanOrEqual(1);

    const pharmacy = await admin.get('/api/v1/admin/forecast/pharmacy-stockouts?days=14');
    expectStatus(pharmacy, 200, 'pharmacy forecast');
    expect(pharmacy.body.data.high_usage_meds.some((item) => item.medication_name === 'Ceftriaxone')).toBe(true);
    expect(pharmacy.body.data.high_usage_meds.some((item) => item.medication_name === 'OtherTenantDrug')).toBe(false);
    expect(pharmacy.body.data.stockout_risks.length).toBe(1);

    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action, resource, resource_id, metadata
       FROM audit_logs
       WHERE action IN (
         'CLINICAL_AI_BED_FORECAST_GENERATED',
         'CLINICAL_AI_PHARMACY_STOCKOUT_FORECAST_GENERATED'
       )
       ORDER BY created_at DESC`
    );
    const actions = auditRows.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_BED_FORECAST_GENERATED');
    expect(actions).toContain('CLINICAL_AI_PHARMACY_STOCKOUT_FORECAST_GENERATED');
    expect(auditRows.every((row) => row.resource === 'clinical_ai')).toBe(true);
  });
});
