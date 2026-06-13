// Roadmap D5 — infection-control workbench deep round-trip.
//
// Seeds an index patient (admitted, active infection case), a ward-overlap
// contact, micro culture data, and a foreign-tenant infection case, then
// asserts the isolation board / contact tracing / antibiogram endpoints and
// the D5 isolation flag on the patient command board. Cleanup removes ONLY
// rows seeded here — clinical_audit_events is append-only and never touched.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const OTHER_TENANT_ID = 'c5555555-5555-4555-8555-555555555001';
const OTHER_PATIENT_UID = 'c5555555-5555-4555-8555-555555555002';

let indexUid;
let contactUid;
let orderId;

async function cleanup() {
  // micro_orders cascade clears its isolates + their sensitivities.
  await prisma.$executeRawUnsafe(
    `DELETE FROM micro_orders WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE 'D5TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM infection_cases WHERE organism LIKE 'D5TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE ward = 'D5TEST Ward'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name LIKE 'D5TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, OTHER_TENANT_ID).catch(() => {});
}

d('Infection-control workbench — deep round-trip (roadmap D5)', () => {
  beforeAll(async () => {
    await cleanup();
    const suffix = String(Date.now() % 10000).padStart(4, '0');
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'D5TEST Index', 'PATIENT', true, NOW()) RETURNING uid`,
      `+9199922${suffix}`,
    );
    indexUid = a[0].uid;
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'D5TEST Contact', 'PATIENT', true, NOW()) RETURNING uid`,
      `+9199923${suffix}`,
    );
    contactUid = b[0].uid;

    // Index admitted 2026-04-01 (still in) in D5TEST Ward; contact overlaps
    // 04-03 -> 04-05 in the same ward.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (patient_uid, allergies, status, ward, bed_number, admitted_at, discharged_at, created_at, updated_at)
       VALUES ($1::uuid, '{}', 'admitted',   'D5TEST Ward', 'D5-01', '2026-04-01', NULL,        NOW(), NOW()),
              ($2::uuid, '{}', 'discharged', 'D5TEST Ward', 'D5-02', '2026-04-03', '2026-04-05', NOW(), NOW())`,
      indexUid, contactUid,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO infection_cases (patient_uid, organism, infection_site, detection_date, isolation_required, isolation_type, status, reported_by)
       VALUES ($1::uuid, 'D5TEST E. coli', 'urinary', '2026-04-04', true, 'contact', 'active', $1::uuid)`,
      indexUid,
    );

    // A foreign tenant's active case must never reach the default-tenant
    // board (explicit tenant predicates + the new migration-296 RLS).
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile)
       VALUES ($1::uuid, 'd5-isolation-test', 'D5 Isolation Test Tenant', 'IN', 'DPDP')
       ON CONFLICT (id) DO NOTHING`,
      OTHER_TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO infection_cases (tenant_id, patient_uid, organism, infection_site, detection_date, isolation_required, isolation_type, status, reported_by)
       VALUES ($1::uuid, $2::uuid, 'D5TEST OtherTenant Klebsiella', 'wound', '2026-04-04', true, 'contact', 'active', $2::uuid)`,
      OTHER_TENANT_ID,
      OTHER_PATIENT_UID,
    );

    // micro order -> isolate -> sensitivities (result is varchar(2): S/I/R).
    const ord = await prisma.$queryRawUnsafe(
      `INSERT INTO micro_orders (patient_uid, specimen_type) VALUES ($1::uuid, 'urine') RETURNING id`,
      indexUid,
    );
    orderId = Number(ord[0].id);
    const iso = await prisma.$queryRawUnsafe(
      `INSERT INTO micro_isolates (order_id, organism_name, is_esbl) VALUES ($1, 'D5TEST E. coli', true) RETURNING id`,
      orderId,
    );
    const isolateId = Number(iso[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO micro_sensitivities (isolate_id, antibiotic_code, antibiotic_name, result) VALUES
         ($1, 'MER', 'Meropenem', 'S'),
         ($1, 'CIP', 'Ciprofloxacin', 'R'),
         ($1, 'AMK', 'Amikacin', 'I')`,
      isolateId,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('isolation board shows the active case with its live bed', async () => {
    const res = await authClient('INFECTION_CONTROL_OFFICER')
      .get('/api/v1/infection-control/isolation-board')
      .query({ ward: 'D5TEST Ward' });
    expect(res.status).toBe(200);
    const row = res.body.data.cases.find((c) => c.organism === 'D5TEST E. coli');
    expect(row).toBeDefined();
    expect(row.isolation_required).toBe(true);
    expect(row.isolation_type).toBe('contact');
    expect(row.ward).toBe('D5TEST Ward');
    expect(row.bed_number).toBe('D5-01');
  });

  test('isolation board never leaks another tenant’s cases', async () => {
    const res = await authClient('INFECTION_CONTROL_OFFICER')
      .get('/api/v1/infection-control/isolation-board');
    expect(res.status).toBe(200);
    expect(
      res.body.data.cases.some((c) => c.organism === 'D5TEST OtherTenant Klebsiella'),
    ).toBe(false);
  });

  test('command board carries the D5 isolation flag for the bed board', async () => {
    // ADMIN sees the full board; DOCTOR tokens get own-patients scoping and
    // the seeded admission has no attending doctor.
    const res = await authClient('ADMIN')
      .get('/api/v1/emr/command-board')
      .query({ patient_uid: indexUid });
    expect(res.status).toBe(200);
    const entry = (res.body.data.rows || []).find((row) => row.patient_uid === indexUid);
    expect(entry).toBeDefined();
    expect(entry.isolation).toBeDefined();
    expect(entry.isolation.required).toBe(true);
    expect(entry.isolation.types).toContain('contact');
    expect(entry.isolation.active_case_count).toBeGreaterThanOrEqual(1);
    expect(entry.isolation.items.some((c) => c.organism === 'D5TEST E. coli')).toBe(true);
  });

  test('contact tracing finds the ward-overlap patient with overlap hours', async () => {
    const res = await authClient('INFECTION_CONTROL_OFFICER')
      .get('/api/v1/infection-control/contacts')
      .query({ patient_uid: indexUid, from: '2026-04-01', to: '2026-04-06' });
    expect(res.status).toBe(200);
    const contact = res.body.data.contacts.find((c) => c.patient_uid === contactUid);
    expect(contact).toBeDefined();
    expect(contact.ward).toBe('D5TEST Ward');
    expect(Number(contact.overlap_hours)).toBeGreaterThanOrEqual(47); // ~2 days
    // The index patient is never returned as their own contact.
    expect(res.body.data.contacts.some((c) => c.patient_uid === indexUid)).toBe(false);
  });

  test('antibiogram aggregates susceptibility + resistance flags', async () => {
    // ±1-day window so the assertion is not flaky at the UTC/local date
    // boundary: the seed dates micro orders at NOW() (local), while a single
    // UTC-day filter misses them when the run straddles midnight. Assertions
    // key on the specific 'D5TEST E. coli' organism, so a wider window is safe.
    const day = 24 * 60 * 60 * 1000;
    const from = new Date(Date.now() - day).toISOString().slice(0, 10);
    const to = new Date(Date.now() + day).toISOString().slice(0, 10);
    const res = await authClient('QUALITY_OFFICER')
      .get('/api/v1/infection-control/antibiogram')
      .query({ from, to });
    expect(res.status).toBe(200);
    const organism = res.body.data.organisms['D5TEST E. coli'];
    expect(organism).toBeDefined();
    expect(organism.Meropenem.pct_susceptible).toBe(100);
    expect(organism.Ciprofloxacin.pct_susceptible).toBe(0);
    expect(organism.Amikacin.intermediate).toBe(1);
    expect(res.body.data.resistance_flags.esbl).toBeGreaterThanOrEqual(1);
  });

  test('missing required inputs return a clean 400', async () => {
    const res = await authClient('INFECTION_CONTROL_OFFICER')
      .get('/api/v1/infection-control/contacts')
      .query({ patient_uid: indexUid });
    expect(res.status).toBe(400);
  });

  test('patients cannot reach the workbench', async () => {
    const res = await authClient('PATIENT')
      .get('/api/v1/infection-control/isolation-board');
    expect(res.status).toBe(403);
  });
});
