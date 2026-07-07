// Roadmap D5 — infection-control workbench deep round-trip.
//
// Seeds an index patient (admitted, active infection case), a ward-overlap
// contact, micro culture data, and a foreign-tenant infection case, then
// asserts the isolation board / contact tracing / antibiogram endpoints and
// the D5 isolation flag on the patient command board. Cleanup removes ONLY
// rows seeded here — clinical_audit_events is append-only and never touched.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { createBedCleaningRequest } from '../services/staff/housekeepingTaskDispatchService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const OTHER_TENANT_ID = 'c5555555-5555-4555-8555-555555555001';
const OTHER_PATIENT_UID = 'c5555555-5555-4555-8555-555555555002';
const STAFF_UID = '550e8400-e29b-41d4-a716-446655440000';

let indexUid;
let contactUid;
let singletonUid;
let orderId;
let indexAdmissionId;
let bedId;
let infectionCaseId;
let contactInfectionCaseId;
let isolationOrderId;
let outbreakId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_request_recipients
      WHERE request_id IN (
        SELECT id FROM housekeeping_requests
         WHERE description ILIKE '%D5TEST%'
            OR location_text ILIKE '%D5TEST%'
      )`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_request_updates
      WHERE request_id IN (
        SELECT id FROM housekeeping_requests
         WHERE description ILIKE '%D5TEST%'
            OR location_text ILIKE '%D5TEST%'
      )`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM housekeeping_requests
      WHERE description ILIKE '%D5TEST%'
         OR location_text ILIKE '%D5TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM hand_hygiene_moments WHERE audit_id IN (SELECT id FROM hand_hygiene_audits WHERE ward = 'D5TEST Ward')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM hand_hygiene_audits WHERE ward = 'D5TEST Ward'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM outbreak_episode_cases WHERE infection_case_id IN (SELECT id FROM infection_cases WHERE organism LIKE 'D5TEST%')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM outbreak_episodes WHERE organism LIKE 'D5TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM hai_cases WHERE infection_case_id IN (SELECT id FROM infection_cases WHERE organism LIKE 'D5TEST%')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM device_presence_logs WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE 'D5TEST%')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM isolation_order_checklist_items WHERE isolation_order_id IN (SELECT id FROM isolation_orders WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE 'D5TEST%'))`).catch(() => {});
  await prisma.$executeRawUnsafe(`UPDATE isolation_orders SET terminal_clean_request_id = NULL WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE 'D5TEST%')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM isolation_orders WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE 'D5TEST%')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM nabh_indicator_snapshots WHERE details->>'source' = 'infection_control_workbench'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE ward_name = 'D5TEST Ward' OR bed_number LIKE 'D5-%'`).catch(() => {});
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
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'D5TEST IC Officer', 'ADMIN', true, NOW())
       ON CONFLICT (uid)
       DO UPDATE SET is_active = true, updated_at = NOW()`,
      STAFF_UID,
      `+9199900${suffix}`,
    );
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
    const c = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'D5TEST Singleton', 'PATIENT', true, NOW()) RETURNING uid`,
      `+9199924${suffix}`,
    );
    singletonUid = c[0].uid;

    const bed = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (bed_number, status, patient_uid, ward_name, floor, updated_at)
       VALUES ('D5-01', 'occupied', $1::uuid, 'D5TEST Ward', 5, NOW())
       RETURNING id`,
      indexUid,
    );
    bedId = Number(bed[0].id);

    // Index admitted 2026-04-01 (still in) in D5TEST Ward; contact overlaps
    // 04-03 -> 04-05 in the same ward.
    const admissions = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions (patient_uid, allergies, status, ward, bed_id, bed_number, admitted_at, discharged_at, created_at, updated_at)
       VALUES ($1::uuid, '{}', 'admitted',   'D5TEST Ward', $3::int, 'D5-01', '2026-04-01', NULL,        NOW(), NOW()),
              ($2::uuid, '{}', 'discharged', 'D5TEST Ward', NULL,    'D5-02', '2026-04-03', '2026-04-05', NOW(), NOW())
       RETURNING id, patient_uid`,
      indexUid,
      contactUid,
      bedId,
    );
    indexAdmissionId = Number(admissions.find((row) => row.patient_uid === indexUid).id);

    const infectionCase = await prisma.$queryRawUnsafe(
      `INSERT INTO infection_cases (patient_uid, organism, infection_site, detection_date, isolation_required, isolation_type, status, reported_by)
       VALUES ($1::uuid, 'D5TEST E. coli', 'urinary', '2026-04-04', true, 'contact', 'active', $1::uuid)
       RETURNING id`,
      indexUid,
    );
    infectionCaseId = Number(infectionCase[0].id);
    const contactCase = await prisma.$queryRawUnsafe(
      `INSERT INTO infection_cases (patient_uid, organism, infection_site, detection_date, isolation_required, isolation_type, status, reported_by)
       VALUES ($1::uuid, 'D5TEST E. coli', 'urinary', '2026-04-05', false, NULL, 'active', $1::uuid)
       RETURNING id`,
      contactUid,
    );
    contactInfectionCaseId = Number(contactCase[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO infection_cases (patient_uid, organism, infection_site, detection_date, isolation_required, isolation_type, status, reported_by)
       VALUES ($1::uuid, 'D5TEST Singleton', 'respiratory', '2026-04-05', false, NULL, 'active', $1::uuid)`,
      singletonUid,
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

  test('isolation orders add checklist work and command-board flags', async () => {
    const create = await authClient('INFECTION_CONTROL_OFFICER')
      .post('/api/v1/infection-control/isolation-orders')
      .send({
        patient_uid: indexUid,
        admission_id: indexAdmissionId,
        infection_case_id: infectionCaseId,
        precaution_type: 'contact',
        reason: 'D5TEST contact isolation order',
      });
    expect(create.status).toBe(201);
    isolationOrderId = create.body.data.order.id;
    expect(create.body.data.order.precaution_type).toBe('contact');
    expect(create.body.data.order.checklist_items.length).toBeGreaterThanOrEqual(3);

    const board = await authClient('INFECTION_CONTROL_OFFICER')
      .get('/api/v1/infection-control/isolation-board')
      .query({ ward: 'D5TEST Ward' });
    expect(board.status).toBe(200);
    expect(board.body.data.cases.some((row) => String(row.isolation_order_id) === String(isolationOrderId))).toBe(true);

    const commandBoard = await authClient('ADMIN')
      .get('/api/v1/emr/command-board')
      .query({ patient_uid: indexUid });
    const entry = (commandBoard.body.data.rows || []).find((row) => row.patient_uid === indexUid);
    expect(entry.isolation.required).toBe(true);
    expect(entry.isolation.types).toContain('contact');
    expect(entry.isolation.active_order_count).toBeGreaterThanOrEqual(1);
  });

  test('terminal isolation clean is stamped through housekeeping dispatch', async () => {
    expect(isolationOrderId).toBeDefined();
    const dispatch = await createBedCleaningRequest({
      bedId,
      requesterUid: STAFF_UID,
      trigger: 'final_discharge',
      urgency: 'high',
      admissionId: indexAdmissionId,
      patientUid: indexUid,
      description: 'D5TEST final discharge hook.',
    });
    expect(dispatch.request.id).toBeDefined();

    const stamped = await prisma.$queryRawUnsafe(
      `SELECT terminal_clean_request_id, terminal_clean_requested_at
         FROM isolation_orders
        WHERE id = $1::bigint`,
      isolationOrderId,
    );
    expect(Number(stamped[0].terminal_clean_request_id)).toBe(Number(dispatch.request.id));
    expect(stamped[0].terminal_clean_requested_at).toBeTruthy();

    const explicit = await authClient('INFECTION_CONTROL_OFFICER')
      .post(`/api/v1/infection-control/isolation-orders/${isolationOrderId}/terminal-clean`)
      .send({});
    expect(explicit.status).toBe(200);
    expect(explicit.body.data.isolation_order.terminal_clean_request_id).toBeTruthy();
  });

  test('device denominators, HAI attribution, and NABH snapshot use HAI tables', async () => {
    const device = await authClient('INFECTION_CONTROL_OFFICER')
      .post('/api/v1/infection-control/device-presence')
      .send({
        admission_id: indexAdmissionId,
        device_type: 'urinary_catheter',
        device_label: 'D5TEST Foley',
        started_at: '2026-04-01T00:00:00.000Z',
        stopped_at: '2026-04-06T00:00:00.000Z',
      });
    expect(device.status).toBe(201);

    const hai = await authClient('INFECTION_CONTROL_OFFICER')
      .post('/api/v1/infection-control/hai-cases')
      .send({
        infection_case_id: infectionCaseId,
        admission_id: indexAdmissionId,
        hai_type: 'CAUTI',
        device_type: 'urinary_catheter',
        onset_date: '2026-04-04',
        notes: 'D5TEST attributable CAUTI',
      });
    expect(hai.status).toBe(201);
    expect(hai.body.data.hai_case.hai_type).toBe('CAUTI');

    const rates = await authClient('QUALITY_OFFICER')
      .get('/api/v1/infection-control/hai-rates')
      .query({ from: '2026-04-01', to: '2026-04-06' });
    expect(rates.status).toBe(200);
    const cauti = rates.body.data.rates.find((row) => row.hai_type === 'CAUTI');
    expect(cauti).toBeDefined();
    expect(cauti.numerator).toBe(1);
    expect(Number(cauti.device_days)).toBeGreaterThanOrEqual(5);
    expect(Number(cauti.rate_per_1000_device_days)).toBeGreaterThan(0);

    const snapshot = await authClient('QUALITY_OFFICER')
      .post('/api/v1/infection-control/hai-rates/snapshot')
      .send({ from: '2026-04-01', to: '2026-04-06' });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data.snapshot_indicator_code).toBe('hai_device_rate_per_1000_device_days');

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT visible_to_patient
         FROM clinical_timeline_events
        WHERE source_table = 'hai_cases'
          AND source_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      String(hai.body.data.hai_case.id),
    );
    expect(timeline[0]?.visible_to_patient).toBe(false);
  });

  test('outbreak clusters, line lists, epi curve, and patient-hidden timeline work', async () => {
    const suggestions = await authClient('INFECTION_CONTROL_OFFICER')
      .get('/api/v1/infection-control/outbreaks/cluster-suggestions')
      .query({ from: '2026-04-01', to: '2026-04-07' });
    expect(suggestions.status).toBe(200);
    expect(suggestions.body.data.suggestions.some((row) => row.organism === 'D5TEST E. coli')).toBe(true);
    expect(suggestions.body.data.suggestions.some((row) => row.organism === 'D5TEST Singleton')).toBe(false);

    const outbreak = await authClient('INFECTION_CONTROL_OFFICER')
      .post('/api/v1/infection-control/outbreaks')
      .send({
        episode_code: `D5TEST-${Date.now()}`,
        organism: 'D5TEST E. coli',
        ward: 'D5TEST Ward',
        status: 'suspected',
        line_list_notes: 'D5TEST line list',
      });
    expect(outbreak.status).toBe(201);
    outbreakId = outbreak.body.data.outbreak.id;

    const link = await authClient('INFECTION_CONTROL_OFFICER')
      .post(`/api/v1/infection-control/outbreaks/${outbreakId}/cases`)
      .send({
        infection_case_id: infectionCaseId,
        admission_id: indexAdmissionId,
        case_status: 'confirmed',
      });
    expect(link.status).toBe(201);

    const secondLink = await authClient('INFECTION_CONTROL_OFFICER')
      .post(`/api/v1/infection-control/outbreaks/${outbreakId}/cases`)
      .send({
        infection_case_id: contactInfectionCaseId,
        case_status: 'suspected',
      });
    expect(secondLink.status).toBe(201);

    const curve = await authClient('INFECTION_CONTROL_OFFICER')
      .get(`/api/v1/infection-control/outbreaks/${outbreakId}/epi-curve`);
    expect(curve.status).toBe(200);
    expect(curve.body.data.points.reduce((sum, row) => sum + Number(row.cases), 0)).toBeGreaterThanOrEqual(2);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT visible_to_patient
         FROM clinical_timeline_events
        WHERE source_table = 'outbreak_episode_cases'
          AND source_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      String(link.body.data.link.id),
    );
    expect(timeline[0]?.visible_to_patient).toBe(false);
  });

  test('hand-hygiene audits persist moment compliance', async () => {
    const audit = await authClient('INFECTION_CONTROL_OFFICER')
      .post('/api/v1/infection-control/hand-hygiene-audits')
      .send({
        audit_date: '2026-04-06',
        ward: 'D5TEST Ward',
        unit: 'ICU',
        session_label: 'D5TEST morning',
        moments: [
          { moment_code: 'before_patient_contact', opportunity_count: 5, compliant_count: 4 },
          { moment_code: 'after_body_fluid', opportunity_count: 5, compliant_count: 3 },
        ],
      });
    expect(audit.status).toBe(201);
    expect(Number(audit.body.data.audit.total_moments)).toBe(10);
    expect(Number(audit.body.data.audit.compliant_moments)).toBe(7);
    expect(Number(audit.body.data.audit.compliance_pct)).toBe(70);

    const list = await authClient('QUALITY_OFFICER')
      .get('/api/v1/infection-control/hand-hygiene-audits')
      .query({ from: '2026-04-01', to: '2026-04-07', ward: 'D5TEST Ward' });
    expect(list.status).toBe(200);
    expect(list.body.data.audits.some((row) => row.session_label === 'D5TEST morning')).toBe(true);
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
