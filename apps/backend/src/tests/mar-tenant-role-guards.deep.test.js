import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

describeIfDb('MAR due-list tenant and clinical-role closure', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const nurseA = randomUUID();
  const nurseB = randomUUID();
  const pharmacyInchargeA = randomUUID();
  const nursingInchargeA = randomUUID();
  const ipInchargeA = randomUUID();
  const doctorA = randomUUID();
  const patientA = randomUUID();
  const patientB = randomUUID();
  const run = `${process.pid}-${Date.now()}`;
  let nurseAId;
  let pharmacyInchargeAId;
  let nursingInchargeAId;
  let ipInchargeAId;
  let medicationAdministrationAId;
  let medicationAdministrationIcuHoldId;

  function client(role, uid, tenantId, id = 1) {
    const token = generateTestToken(role, { uid, id, tenant_id: tenantId });
    return {
      get: (path) => request(app)
        .get(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`),
      post: (path, idempotencyKey) => request(app)
        .post(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`)
        .set('idempotency-key', idempotencyKey),
    };
  }

  beforeAll(async () => {
    for (const [tenantId, suffix] of [[tenantA, 'a'], [tenantB, 'b']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
         VALUES ($1::uuid, $2::text, $3::text, 'IN', 'active', NOW(), NOW())`,
        tenantId,
        `mar-role-${run}-${suffix}`,
        `MAR role tenant ${suffix}`,
      );
    }
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (tenant_id, uid, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'MAR Nurse A', 'NURSING_STAFF', TRUE, 'active', NOW()),
         ($1::uuid, $3::uuid, 'MAR Patient A', 'PATIENT', TRUE, 'active', NOW()),
         ($1::uuid, $4::uuid, 'MAR Pharmacy Incharge A', 'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $5::uuid, 'MAR Nursing Incharge A', 'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $6::uuid, 'MAR IP Incharge A', 'IP_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $7::uuid, 'MAR Doctor A', 'DOCTOR', TRUE, 'active', NOW()),
         ($8::uuid, $9::uuid, 'MAR Nurse B', 'NURSING_STAFF', TRUE, 'active', NOW()),
         ($8::uuid, $10::uuid, 'MAR Patient B', 'PATIENT', TRUE, 'active', NOW())
       RETURNING id, uid::text`,
      tenantA,
      nurseA,
      patientA,
      pharmacyInchargeA,
      nursingInchargeA,
      ipInchargeA,
      doctorA,
      tenantB,
      nurseB,
      patientB,
    );
    nurseAId = Number(users.find((row) => row.uid === nurseA).id);
    pharmacyInchargeAId = Number(users.find((row) => row.uid === pharmacyInchargeA).id);
    nursingInchargeAId = Number(users.find((row) => row.uid === nursingInchargeA).id);
    ipInchargeAId = Number(users.find((row) => row.uid === ipInchargeA).id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, admitted_at, ward, bed_number,
          created_by, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'admitted', NOW(), 'MAR Role Ward', $3::text,
          $4::uuid, NOW(), NOW())`,
      tenantA,
      patientA,
      `MAR-ROLE-${run}`,
      nurseA,
    );
    const clinicalOrderAId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, status,
          ordered_by, details, route, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'ordered',
               $4::uuid, $5::jsonb, 'oral', NOW())
       RETURNING id`,
      tenantA,
      `MAR-ROLE-${run}`.slice(0, 80),
      patientA,
      doctorA,
      JSON.stringify({ medication_name: `MAR-TENANT-A-DUE-${run}`, dose: '1 tablet', route: 'oral' }),
    ))[0].id);
    const administrations = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route, scheduled_time, status,
          clinical_order_id)
       VALUES
         ($1::uuid, $2::uuid, $3::text, '1 tablet', 'oral',
          NOW() - INTERVAL '30 minutes', 'scheduled', $5::integer),
         ($1::uuid, $2::uuid, $4::text, '1 tablet', 'oral',
          NOW() + INTERVAL '30 minutes', 'scheduled', $5::integer),
         ($6::uuid, $7::uuid, $8::text, '1 tablet', 'oral',
          NOW() - INTERVAL '30 minutes', 'scheduled', NULL),
         ($6::uuid, $7::uuid, $9::text, '1 tablet', 'oral',
          NOW() + INTERVAL '30 minutes', 'scheduled', NULL)
       RETURNING id, tenant_id::text, medication_name`,
      tenantA,
      patientA,
      `MAR-TENANT-A-OVERDUE-${run}`,
      `MAR-TENANT-A-DUE-${run}`,
      clinicalOrderAId,
      tenantB,
      patientB,
      `MAR-TENANT-B-OVERDUE-${run}`,
      `MAR-TENANT-B-DUE-${run}`,
    );
    medicationAdministrationAId = Number(administrations.find(
      (row) => row.medication_name === `MAR-TENANT-A-OVERDUE-${run}`,
    ).id);
    medicationAdministrationIcuHoldId = Number(administrations.find(
      (row) => row.medication_name === `MAR-TENANT-A-DUE-${run}`,
    ).id);
  });

  afterAll(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      for (const tenantId of [tenantA, tenantB]) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_tenant_id', $1::text, TRUE)`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `DO $cleanup$
           DECLARE
             relation_record RECORD;
           BEGIN
             FOR relation_record IN
               SELECT table_info.table_name
                 FROM information_schema.tables table_info
                 JOIN information_schema.columns column_info
                   ON column_info.table_schema = table_info.table_schema
                  AND column_info.table_name = table_info.table_name
                WHERE table_info.table_schema = 'public'
                  AND table_info.table_type = 'BASE TABLE'
                  AND column_info.column_name = 'tenant_id'
                ORDER BY table_info.table_name
             LOOP
               EXECUTE format(
                 'DELETE FROM public.%I WHERE tenant_id::text = $1',
                 relation_record.table_name
               ) USING current_setting('app.current_tenant_id');
             END LOOP;
           END
           $cleanup$`,
        );
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
        tenantA,
        tenantB,
      );
    }, { timeout: 30_000 });
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test.each(['NURSING_STAFF', 'ICU_STAFF'])(
    '%s due and overdue queries return only the authenticated tenant',
    async (role) => {
    const nursing = client(role, nurseA, tenantA, nurseAId);
    const overdue = await nursing.get('/api/v1/clinical/mar/overdue');
    expect(overdue.status).toBe(200);
    expect(overdue.body.data.map((row) => row.medication_name)).toEqual([
      `MAR-TENANT-A-OVERDUE-${run}`,
    ]);

    const due = await nursing.get('/api/v1/clinical/mar/due?past_minutes=120&future_minutes=120');
    expect(due.status).toBe(200);
    const names = due.body.data.map((row) => row.medication_name);
    expect(names).toEqual(expect.arrayContaining([
      `MAR-TENANT-A-OVERDUE-${run}`,
      `MAR-TENANT-A-DUE-${run}`,
    ]));
    expect(names.some((name) => name.includes('TENANT-B'))).toBe(false);
    },
  );

  test.each([
    ['PATIENT', patientA],
    ['PHARMACY_STAFF', nurseA],
    ['ADMIN', nurseA],
    ['SUPER_ADMIN', nurseA],
  ])('%s cannot enumerate inpatient due or overdue medication lists', async (role, uid) => {
    const unauthorized = client(role, uid, tenantA, nurseAId);
    expect((await unauthorized.get('/api/v1/clinical/mar/due')).status).toBe(403);
    expect((await unauthorized.get('/api/v1/clinical/mar/overdue')).status).toBe(403);
  });

  test('ICU_STAFF can hold a MAR dose through admission scope without losing audit identity', async () => {
    const icu = client('ICU_STAFF', nurseA, tenantA, nurseAId);
    const response = await icu
      .post(
        `/api/v1/clinical/mar/${medicationAdministrationIcuHoldId}/hold`,
        `mar-role-icu-hold-${run}`,
      )
      .send({ reason: 'ICU bedside clinical hold pending prescriber review' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('held');

    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT actor_role, access_decision, access_source
         FROM patient_access_audit_log
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND route LIKE '%/clinical/mar/%/hold'
        ORDER BY id DESC
        LIMIT 1`,
      tenantA,
      patientA,
    );
    expect(auditRows[0]).toMatchObject({
      actor_role: 'ICU_STAFF',
      access_decision: 'allow',
      access_source: 'admission',
    });
  });

  test.each([
    ['PHARMACY_INCHARGE', pharmacyInchargeA, () => pharmacyInchargeAId, '/api/v1/clinical'],
    ['NURSING_INCHARGE', nursingInchargeA, () => nursingInchargeAId, '/api/v1/emr'],
    ['IP_INCHARGE', ipInchargeA, () => ipInchargeAId, '/api/v1/nursing'],
  ])('%s reaches MAR supply reconciliation after role, capability, and admission checks', async (
    role,
    uid,
    idOf,
    prefix,
  ) => {
    const actor = client(role, uid, tenantA, idOf());
    const response = await actor
      .post(
        `${prefix}/mar/${medicationAdministrationAId}/supply-overrides/9223372036854775000/reconcile`,
        `mar-role-reconcile-${role.toLowerCase()}-${run}`,
      )
      .send({
        allocations: [{ inventory_allocation_id: '9223372036854775807', quantity: 1 }],
      });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('MAR supply override consumption not found');
    expect(response.body.code).not.toBe('PATIENT_ACCESS_DENIED');
  });

  test.each([
    ['PHARMACY_STAFF', true],
    ['NURSING_STAFF', true],
    ['IP_STAFF_NURSE', true],
    ['ICU_STAFF', true],
    ['DOCTOR', true],
    ['PATIENT', false],
    ['CNO', true],
    ['STORES_PURCHASE_INCHARGE', false],
  ])('%s cannot claim MAR supply reconciliation authority', async (role, reachesRouteFence) => {
    const unauthorized = client(role, nurseA, tenantA, nurseAId);
    const response = await unauthorized
      .post(
        `/api/v1/clinical/mar/${medicationAdministrationAId}/supply-overrides/9223372036854775000/reconcile`,
        `mar-role-denied-${role.toLowerCase()}-${run}`,
      )
      .send({
        allocations: [{ inventory_allocation_id: '9223372036854775807', quantity: 1 }],
      });

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
    if (reachesRouteFence) {
      expect(response.body.message)
        .toMatch(/Only pharmacy, nursing, or administrative in-charge roles/);
    }
  });

  test.each(['ADMIN', 'SUPER_ADMIN'])(
    '%s remains fail-closed without a patient relationship or break-glass session',
    async (role) => {
      const administrative = client(role, nurseA, tenantA, nurseAId);
      const response = await administrative
        .post(
          `/api/v1/clinical/mar/${medicationAdministrationAId}/supply-overrides/9223372036854775000/reconcile`,
          `mar-role-admin-denied-${role.toLowerCase()}-${run}`,
        )
        .send({
          allocations: [{ inventory_allocation_id: '9223372036854775807', quantity: 1 }],
        });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PATIENT_ACCESS_DENIED');
    },
  );
});
