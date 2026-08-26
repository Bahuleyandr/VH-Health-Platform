import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const FORCED_FAILURE = 'forced lab-panel canonical audit failure';
const fault = { failCanonicalAudit: false, hit: false };
const notificationObservations = [];

const actualPrismaModule = await import('../lib/prisma.js');
const faultingTransactions = new WeakSet();

function faultingTx(tx) {
  const proxy = new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$queryRawUnsafe') {
        return async (sql, ...params) => {
          if (
            fault.failCanonicalAudit
            && /INSERT\s+INTO\s+clinical_audit_events/i.test(String(sql))
          ) {
            fault.hit = true;
            throw new Error(FORCED_FAILURE);
          }
          return target.$queryRawUnsafe(sql, ...params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  faultingTransactions.add(proxy);
  return proxy;
}

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  setTenantTx: (tenantId, fn, options) => actualPrismaModule.setTenantTx(
    tenantId,
    (tx) => fn(faultingTx(tx)),
    options,
  ),
  isTenantTransactionClient: (client) => (
    faultingTransactions.has(client)
    || actualPrismaModule.isTenantTransactionClient(client)
  ),
}));

jest.unstable_mockModule('../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: async (args) => {
    const bindings = await actualPrismaModule.default.$queryRawUnsafe(
      `SELECT alert.id AS alert_id,
              alert.acknowledgement_task_id,
              task.id AS task_id,
              task.workflow_sla_instance_id,
              sla.id AS sla_id
         FROM lab_critical_alerts AS alert
         JOIN tasks AS task
           ON task.tenant_id = alert.tenant_id
          AND task.id = alert.acknowledgement_task_id
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE alert.tenant_id = $1::uuid
          AND alert.id = $2::int`,
      args.tenantId,
      Number(args.relatedId),
    );
    notificationObservations.push({ args, binding: bindings[0] || null });
    return { sent: bindings.length };
  },
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const { recordLabPanel } = await import('../services/lab/labPanelService.js');
const { materializeLabCriticalAlertGeneration } = await import(
  '../services/lab/labCriticalAlertService.js'
);
const {
  activateLabThresholdPolicyBundle,
  addLabThresholdCatalogEntry,
  approveLabThresholdPolicyBundle,
  createLabThresholdPolicyBundle,
  replaceLabThresholdPolicyRules,
  submitLabThresholdPolicyBundle,
} = await import('../services/lab/labThresholdGovernanceService.js');
const { signOffResults } = await import('../services/lab/labResultsService.js');
const { default: labPanelRoutes } = await import('../routes/lab/labPanelRoutes.js');

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const INACTIVE_PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const LAB_TECH_UID = randomUUID();
const PATHOLOGIST_UID = randomUUID();
const POLICY_AUTHOR_UID = randomUUID();
const POLICY_ACTIVATOR_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 10);
const TENANT_SLUG = `lab-panel-critical-${SUFFIX}`;
const PATIENT_PHONE = `5${String(parseInt(SUFFIX, 16) % 1_000_000_000).padStart(9, '0')}`;
const INACTIVE_PATIENT_PHONE = `4${String((parseInt(SUFFIX, 16) + 4) % 1_000_000_000).padStart(9, '0')}`;
const DOCTOR_PHONE = `6${String((parseInt(SUFFIX, 16) + 1) % 1_000_000_000).padStart(9, '0')}`;
const LAB_TECH_PHONE = `7${String((parseInt(SUFFIX, 16) + 2) % 1_000_000_000).padStart(9, '0')}`;
const PATHOLOGIST_PHONE = `8${String((parseInt(SUFFIX, 16) + 3) % 1_000_000_000).padStart(9, '0')}`;
const POLICY_AUTHOR_PHONE = `3${String((parseInt(SUFFIX, 16) + 5) % 1_000_000_000).padStart(9, '0')}`;
const POLICY_ACTIVATOR_PHONE = `2${String((parseInt(SUFFIX, 16) + 6) % 1_000_000_000).padStart(9, '0')}`;

const fixture = {};

async function cleanup() {
  const tenantDeletes = [
    'DELETE FROM notification_outbox WHERE tenant_id = $1::uuid',
    'DELETE FROM notifications WHERE tenant_id = $1::uuid',
    'DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid',
    'DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid',
    'DELETE FROM audit_logs WHERE tenant_id = $1::uuid',
    'DELETE FROM lab_critical_alerts WHERE tenant_id = $1::uuid',
    'DELETE FROM task_comments WHERE tenant_id = $1::uuid',
    'DELETE FROM tasks WHERE tenant_id = $1::uuid',
    'DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid',
    'DELETE FROM lab_pathologist_signoffs WHERE tenant_id = $1::uuid',
    'DELETE FROM lab_results WHERE tenant_id = $1::uuid',
    'DELETE FROM lab_reference_ranges WHERE tenant_id = $1::uuid',
    'DELETE FROM lab_critical_thresholds WHERE tenant_id = $1::uuid',
    'DELETE FROM investigation_bookings WHERE tenant_id = $1::uuid',
    'DELETE FROM investigations WHERE tenant_id = $1::uuid',
    'DELETE FROM idempotency_keys WHERE tenant_id = $1::uuid',
    'DELETE FROM users WHERE tenant_id = $1::uuid',
  ];
  for (const sql of tenantDeletes) {
    await prisma.$executeRawUnsafe(sql, TENANT_ID).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    'DELETE FROM tenants WHERE id = $1::uuid',
    TENANT_ID,
  ).catch(() => {});
}

async function createInvestigation({
  code,
  requestedBy = DOCTOR_UID,
  withBooking = false,
  investigationStatus = 'COLLECTED',
  bookingStatus = 'COLLECTED',
  patientUid = PATIENT_UID,
  patientId = fixture.patientId,
  patientPhone = PATIENT_PHONE,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, phone, patient_id, patient_uid, test_name, test_type,
        test_code, status, requested_by, requested_at, updated_at)
     VALUES ($1::uuid, $2, $3::int, $4::uuid, $5, 'LAB', $6, $8,
             $7::uuid, NOW(), NOW())
     RETURNING id`,
    TENANT_ID,
    patientPhone,
    patientId,
    patientUid,
    `${code} panel order`,
    code,
    requestedBy,
    investigationStatus,
  );
  const investigationId = rows[0].id;
  let bookingId = null;
  if (withBooking) {
    const bookings = await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_bookings
         (tenant_id, patient_id, patient_name, patient_phone, investigation_id,
          test_name, selected_tests, actual_tests, status, updated_at)
       VALUES ($1::uuid, $2::int, 'Panel critical patient', $3, $4::int,
               $5, '{}'::int[], '{}'::int[], $6, NOW())
       RETURNING id`,
      TENANT_ID,
      patientId,
      patientPhone,
      investigationId,
      `${code} panel order`,
      bookingStatus,
    );
    bookingId = Number(bookings[0].id);
  }
  return { investigationId, bookingId };
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, 'Lab panel critical-path tenant')`,
    TENANT_ID,
    TENANT_SLUG,
  );
  const users = await prisma.$queryRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, gender, birthday, role, is_active, status,
        is_deleted, tenant_id, updated_at)
     VALUES
       ($1::uuid, $2, 'Panel critical patient', 'F', DATE '1990-01-01',
        'PATIENT', TRUE, 'active', FALSE, $13::uuid, NOW()),
       ($3::uuid, $4, 'Panel ordering doctor', NULL, NULL,
        'DOCTOR', TRUE, 'active', FALSE, $13::uuid, NOW()),
       ($5::uuid, $6, 'Panel lab technician', NULL, NULL,
        'LAB_STAFF', TRUE, 'active', FALSE, $13::uuid, NOW()),
       ($7::uuid, $8, 'Panel pathologist', NULL, NULL,
        'PATHOLOGIST', TRUE, 'active', FALSE, $13::uuid, NOW()),
       ($9::uuid, $10, 'Panel policy author', NULL, NULL,
        'ADMIN', TRUE, 'active', FALSE, $13::uuid, NOW()),
       ($11::uuid, $12, 'Panel policy activator', NULL, NULL,
        'SUPER_ADMIN', TRUE, 'active', FALSE, $13::uuid, NOW())
     RETURNING id, uid`,
    PATIENT_UID,
    PATIENT_PHONE,
    DOCTOR_UID,
    DOCTOR_PHONE,
    LAB_TECH_UID,
    LAB_TECH_PHONE,
    PATHOLOGIST_UID,
    PATHOLOGIST_PHONE,
    POLICY_AUTHOR_UID,
    POLICY_AUTHOR_PHONE,
    POLICY_ACTIVATOR_UID,
    POLICY_ACTIVATOR_PHONE,
    TENANT_ID,
  );
  fixture.patientId = users.find((user) => user.uid === PATIENT_UID).id;
  const inactiveUsers = await prisma.$queryRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, gender, birthday, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'Inactive panel patient', 'F', DATE '1990-01-01',
             'PATIENT', FALSE, $3::uuid, NOW())
     RETURNING id`,
    INACTIVE_PATIENT_UID,
    INACTIVE_PATIENT_PHONE,
    TENANT_ID,
  );
  fixture.inactivePatientId = inactiveUsers[0].id;

  const sources = await Promise.all([
    createInvestigation({ code: 'K_ATOMIC', withBooking: true }),
    createInvestigation({ code: 'K_FALLBACK', requestedBy: null }),
    createInvestigation({ code: 'K_SIGNOFF' }),
    createInvestigation({ code: 'K_REPLAY' }),
    createInvestigation({ code: 'K_CONCURRENT' }),
    createInvestigation({ code: 'K_BOUNDARY' }),
    createInvestigation({ code: 'K_BOUNDARY_LOW' }),
    createInvestigation({ code: 'K_POLICY_MISMATCH' }),
    createInvestigation({ code: 'K_MISSING_POLICY' }),
    createInvestigation({ code: 'K_UNIT_MISMATCH' }),
    createInvestigation({ code: 'K_TERMINAL_INVESTIGATION', investigationStatus: 'COMPLETED' }),
    createInvestigation({ code: 'K_TERMINAL_BOOKING', withBooking: true, bookingStatus: 'CANCELLED' }),
    createInvestigation({
      code: 'K_INACTIVE_PATIENT',
      patientUid: INACTIVE_PATIENT_UID,
      patientId: fixture.inactivePatientId,
      patientPhone: INACTIVE_PATIENT_PHONE,
    }),
  ]);
  [
    fixture.atomic,
    fixture.fallback,
    fixture.signoff,
    fixture.replay,
    fixture.concurrent,
    fixture.boundary,
    fixture.boundaryLow,
    fixture.policyMismatch,
    fixture.missingPolicy,
    fixture.unitMismatch,
    fixture.terminalInvestigation,
    fixture.terminalBooking,
    fixture.inactivePatient,
  ] = sources;

  await prisma.$executeRawUnsafe(
    `INSERT INTO lab_reference_ranges
       (tenant_id, test_code, test_name, unit, range_low, range_high,
        critical_low, critical_high, is_active, source)
     SELECT $1::uuid, code, code || ' potassium', 'mmol/L', 3.5, 5.0,
            2.5, 6.5, TRUE, 'test'
       FROM unnest($2::text[]) AS code`,
    TENANT_ID,
    [
      'K_ATOMIC',
      'K_FALLBACK',
      'K_SIGNOFF',
      'K_REPLAY',
      'K_CONCURRENT',
      'K_BOUNDARY',
      'K_BOUNDARY_LOW',
      'K_POLICY_MISMATCH',
      'K_MISSING_POLICY',
      'K_UNIT_MISMATCH',
    ],
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO lab_critical_thresholds
       (tenant_id, test_code, test_name, unit, critical_low, critical_high,
        applies_to, is_active, source)
     SELECT $1::uuid,
            code,
            code || ' canonical potassium',
            CASE WHEN code = 'K_UNIT_MISMATCH' THEN 'mEq/L' ELSE 'mmol/L' END,
            2.5,
            CASE WHEN code = 'K_POLICY_MISMATCH' THEN 7.0 ELSE 6.5 END,
            'all',
            TRUE,
            'test'
       FROM unnest($2::text[]) AS code`,
    TENANT_ID,
    [
      'K_ATOMIC',
      'K_FALLBACK',
      'K_SIGNOFF',
      'K_REPLAY',
      'K_CONCURRENT',
      'K_BOUNDARY',
      'K_BOUNDARY_LOW',
      'K_POLICY_MISMATCH',
      'K_UNIT_MISMATCH',
    ],
  );

  const facilities = await prisma.$queryRawUnsafe(
    `INSERT INTO facilities
       (tenant_id, facility_code, display_name, status, is_default, created_by)
     VALUES ($1::uuid, $2, 'Panel governance facility', 'active', TRUE, $3::uuid)
     RETURNING id`,
    TENANT_ID,
    `panel-governance-${SUFFIX}`,
    POLICY_AUTHOR_UID,
  );
  fixture.facilityId = Number(facilities[0].id);

  const governedCodes = [
    'K_ATOMIC',
    'K_FALLBACK',
    'K_SIGNOFF',
    'K_REPLAY',
    'K_CONCURRENT',
    'K_BOUNDARY',
    'K_BOUNDARY_LOW',
    'K_POLICY_MISMATCH',
    'K_UNIT_MISMATCH',
  ];
  const catalogEntries = new Map();
  for (const code of governedCodes) {
    const catalog = await addLabThresholdCatalogEntry({
      tenantId: TENANT_ID,
      facilityId: fixture.facilityId,
      actorUid: POLICY_AUTHOR_UID,
      actorRole: 'ADMIN',
      entry: {
        test_code: code,
        test_name: `${code} governed potassium`,
        specimen_type: 'any',
        evaluation_mode: 'numeric_threshold',
        unit: code === 'K_UNIT_MISMATCH' ? 'mEq/L' : 'mmol/L',
        criticality_required: true,
      },
      metadata: { test_fixture: 'lab-panel-critical-path' },
    });
    catalogEntries.set(code, catalog.entry.id);
  }

  const bundle = await createLabThresholdPolicyBundle({
    tenantId: TENANT_ID,
    facilityId: fixture.facilityId,
    actorUid: POLICY_AUTHOR_UID,
    actorRole: 'ADMIN',
    metadata: { test_fixture: 'lab-panel-critical-path' },
  });
  await replaceLabThresholdPolicyRules({
    tenantId: TENANT_ID,
    bundleId: bundle.id,
    actorUid: POLICY_AUTHOR_UID,
    actorRole: 'ADMIN',
    rules: governedCodes.map((code) => ({
      catalog_entry_id: catalogEntries.get(code),
      reference_low: 3.5,
      reference_high: 5,
      critical_low: 2.5,
      critical_high: 6.5,
    })),
  });
  await submitLabThresholdPolicyBundle({
    tenantId: TENANT_ID,
    bundleId: bundle.id,
    actorUid: POLICY_AUTHOR_UID,
    actorRole: 'ADMIN',
    sourceReference: 'signed-panel-critical-path-test-policy',
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
  });
  await approveLabThresholdPolicyBundle({
    tenantId: TENANT_ID,
    bundleId: bundle.id,
    actorUid: PATHOLOGIST_UID,
    actorRole: 'PATHOLOGIST',
    reason: 'Independent clinical approval for the panel critical-path fixture.',
    evidenceReference: 'panel-critical-path-test-evidence',
    evidenceSha256: 'e'.repeat(64),
  });
  const activated = await activateLabThresholdPolicyBundle({
    tenantId: TENANT_ID,
    bundleId: bundle.id,
    actorUid: POLICY_ACTIVATOR_UID,
    actorRole: 'SUPER_ADMIN',
    reason: 'Test-only activation after independent clinical approval.',
  });
  fixture.policyBundleId = activated.bundle.id;
  fixture.catalogEntries = catalogEntries;
}

function panelArgs(code, source, overrides = {}) {
  const args = {
    tenantId: TENANT_ID,
    panelCode: 'RFT',
    patientUid: PATIENT_UID,
    investigationId: source.investigationId,
    bookingId: source.bookingId,
    performedByUid: LAB_TECH_UID,
    performedByRole: 'LAB_STAFF',
    performedByLab: 'Atomicity bench',
    analytes: [{
      test_code: code,
      test_name: `${code} potassium`,
      value_numeric: 7.2,
      value_text: '7.2',
      unit: 'mmol/L',
    }],
    ...overrides,
  };
  return {
    ...args,
    idempotencyKey: args.idempotencyKey
      || `deep-panel:${code}:${source.investigationId}`,
    requestBodySha256: args.requestBodySha256
      || createHash('sha256').update(JSON.stringify({
        code,
        bookingId: source.bookingId,
        investigationId: source.investigationId,
        analytes: args.analytes,
      })).digest('hex'),
  };
}

function panelBody(code, source, overrides = {}) {
  const args = panelArgs(code, source, overrides);
  const {
    tenantId: _tenantId,
    performedByUid: _performedByUid,
    performedByRole: _performedByRole,
    idempotencyKey: _idempotencyKey,
    requestBodySha256: _requestBodySha256,
    httpIdempotencyClaimId: _httpIdempotencyClaimId,
    requestId: _requestId,
    ...body
  } = args;
  if (body.bookingId == null) delete body.bookingId;
  return body;
}

async function readCounts(investigationId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::int
          FROM lab_results AS result
         WHERE result.tenant_id = $1::uuid
           AND result.investigation_id = $2::int) AS result_count,
       (SELECT COUNT(*)::int
          FROM lab_critical_alerts AS alert
          JOIN lab_results AS result
            ON result.tenant_id = alert.tenant_id
           AND result.id = alert.result_id
         WHERE result.tenant_id = $1::uuid
           AND result.investigation_id = $2::int) AS alert_count,
       (SELECT COUNT(*)::int
          FROM tasks AS task
         WHERE task.tenant_id = $1::uuid
           AND task.related_resource_type = 'lab_result'
           AND task.related_resource_id IN (
             SELECT result.id::text FROM lab_results AS result
              WHERE result.tenant_id = $1::uuid
                AND result.investigation_id = $2::int
           )) AS task_count,
       (SELECT COUNT(*)::int
          FROM workflow_sla_instances AS sla
         WHERE sla.tenant_id = $1::uuid
           AND sla.source_table = 'lab_result'
           AND sla.source_id IN (
             SELECT result.id::text FROM lab_results AS result
              WHERE result.tenant_id = $1::uuid
                AND result.investigation_id = $2::int
           )) AS sla_count,
        (SELECT COUNT(*)::int
           FROM clinical_timeline_events AS timeline
          WHERE timeline.tenant_id = $1::uuid
            AND timeline.source_table = 'lab_results'
            AND timeline.source_id IN (
              SELECT result.id::text FROM lab_results AS result
               WHERE result.tenant_id = $1::uuid
                 AND result.investigation_id = $2::int
            )) AS timeline_count,
        (SELECT COUNT(*)::int
           FROM clinical_audit_events AS audit
          WHERE audit.tenant_id = $1::uuid
            AND audit.resource_table = 'lab_results'
            AND audit.resource_id IN (
              SELECT result.id::text FROM lab_results AS result
               WHERE result.tenant_id = $1::uuid
                 AND result.investigation_id = $2::int
            )) AS audit_count`,
    TENANT_ID,
    investigationId,
  );
  return rows[0];
}

async function readThresholdException(investigationId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT exception_row.lifecycle_status,
            exception_row.unmatched_reason,
            exception_row.occurrence_count,
            task.status AS task_status,
            task.priority AS task_priority,
            task.assigned_to_role,
            result.criticality_status,
            result.threshold_policy_bundle_id,
            result.threshold_policy_rule_id,
            result.threshold_catalog_entry_id
       FROM lab_results AS result
       JOIN lab_threshold_unmatched_exceptions AS exception_row
         ON exception_row.tenant_id = result.tenant_id
        AND exception_row.result_id = result.id
       JOIN tasks AS task
         ON task.tenant_id = exception_row.tenant_id
        AND task.id = exception_row.task_id
      WHERE result.tenant_id = $1::uuid
        AND result.investigation_id = $2::int
      ORDER BY exception_row.first_seen_at, exception_row.id`,
    TENANT_ID,
    investigationId,
  );
  return rows;
}

async function waitForIdempotencyComplete(requestKey) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status
         FROM idempotency_keys
        WHERE tenant_id = $1::uuid
          AND user_uid = $2::uuid
          AND request_key = $3
          AND request_path = '/api/v1/lab/panels'`,
      TENANT_ID,
      LAB_TECH_UID,
      requestKey,
    );
    if (rows[0]?.status === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Idempotency response did not finalise for ${requestKey}`);
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = TENANT_ID;
  req.user = { uid: LAB_TECH_UID, role: 'LAB_STAFF' };
  next();
});
app.use('/api/v1/lab', labPanelRoutes);

d('structured lab-panel critical path', () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  }, 60_000);

  beforeEach(() => {
    fault.failCanonicalAudit = false;
    fault.hit = false;
    notificationObservations.length = 0;
  });

  afterEach(() => {
    fault.failCanonicalAudit = false;
    fault.hit = false;
  });

  afterAll(async () => {
    // Completed ingest commands and their linked results are append-only
    // evidence. This suite runs on an isolated random tenant and must not tear
    // that graph apart merely to tidy a disposable test database.
    await prisma.$disconnect().catch(() => {});
  });

  it('rejects a conflicting booking/investigation assertion before any clinical write', async () => {
    await expect(recordLabPanel(panelArgs('K_ATOMIC', {
      bookingId: fixture.atomic.bookingId,
      investigationId: fixture.fallback.investigationId,
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_PANEL_SOURCE_MISMATCH',
    });

    expect(await readCounts(fixture.atomic.investigationId)).toEqual({
      result_count: 0,
      alert_count: 0,
      task_count: 0,
      sla_count: 0,
      timeline_count: 0,
      audit_count: 0,
    });
    expect(notificationObservations).toHaveLength(0);
  }, 30_000);

  it('records exact low and high critical boundaries as noncritical canonical evidence', async () => {
    const high = await recordLabPanel(panelArgs('K_BOUNDARY', fixture.boundary, {
      analytes: [{
        test_code: 'K_BOUNDARY',
        test_name: 'K_BOUNDARY potassium',
        value_numeric: 6.5,
        value_text: '6.5',
        unit: 'mmol/L',
      }],
    }));
    const low = await recordLabPanel(panelArgs('K_BOUNDARY_LOW', fixture.boundaryLow, {
      analytes: [{
        test_code: 'K_BOUNDARY_LOW',
        test_name: 'K_BOUNDARY_LOW potassium',
        value_numeric: 2.5,
        value_text: '2.5',
        unit: 'mmol/L',
      }],
    }));

    expect(high).toMatchObject({
      criticals_fired: 0,
      results: [expect.objectContaining({ abnormal_flag: 'H', is_critical: false })],
    });
    expect(low).toMatchObject({
      criticals_fired: 0,
      results: [expect.objectContaining({ abnormal_flag: 'L', is_critical: false })],
    });
    expect(await readCounts(fixture.boundary.investigationId)).toEqual({
      result_count: 1,
      alert_count: 0,
      task_count: 0,
      sla_count: 0,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(await readCounts(fixture.boundaryLow.investigationId)).toEqual({
      result_count: 1,
      alert_count: 0,
      task_count: 0,
      sla_count: 0,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(notificationObservations).toHaveLength(0);
  }, 30_000);

  it.each([
    ['terminal investigation', 'terminalInvestigation'],
    ['cancelled booking', 'terminalBooking'],
  ])('rejects a %s source before any clinical write', async (_label, fixtureKey) => {
    const source = fixture[fixtureKey];
    await expect(recordLabPanel(panelArgs('K_TERMINAL', source))).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_PANEL_SOURCE_MISMATCH',
    });
    expect(await readCounts(source.investigationId)).toEqual({
      result_count: 0,
      alert_count: 0,
      task_count: 0,
      sla_count: 0,
      timeline_count: 0,
      audit_count: 0,
    });
  });

  it('rejects an inactive patient source before any clinical write', async () => {
    const source = fixture.inactivePatient;
    await expect(recordLabPanel(panelArgs('K_INACTIVE_PATIENT', source, {
      patientUid: INACTIVE_PATIENT_UID,
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_PANEL_SOURCE_MISMATCH',
    });
    expect(await readCounts(source.investigationId)).toEqual({
      result_count: 0,
      alert_count: 0,
      task_count: 0,
      sla_count: 0,
      timeline_count: 0,
      audit_count: 0,
    });
  });

  it('ignores conflicting unsigned legacy thresholds and uses the active signed bundle', async () => {
    const recorded = await recordLabPanel(panelArgs(
      'K_POLICY_MISMATCH',
      fixture.policyMismatch,
    ));
    expect(recorded).toMatchObject({
      criticals_fired: 1,
      results: [expect.objectContaining({
        criticality_status: 'critical',
        is_critical: true,
        threshold_policy_bundle_id: fixture.policyBundleId,
        threshold_catalog_entry_id: fixture.catalogEntries.get('K_POLICY_MISMATCH'),
      })],
    });
    expect(await readCounts(fixture.policyMismatch.investigationId)).toEqual({
      result_count: 1,
      alert_count: 1,
      task_count: 1,
      sla_count: 1,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(await readThresholdException(fixture.policyMismatch.investigationId)).toEqual([]);
    expect(notificationObservations).toHaveLength(1);
  }, 30_000);

  it('persists a result missing from the governed catalogue and opens its owner task', async () => {
    const recorded = await recordLabPanel(panelArgs('K_MISSING_POLICY', fixture.missingPolicy));
    expect(recorded).toMatchObject({
      criticals_fired: 0,
      results: [expect.objectContaining({
        criticality_status: 'threshold_unavailable',
        is_critical: false,
        threshold_policy_bundle_id: fixture.policyBundleId,
        threshold_policy_rule_id: null,
        threshold_catalog_entry_id: null,
      })],
    });
    expect(await readCounts(fixture.missingPolicy.investigationId)).toEqual({
      result_count: 1,
      alert_count: 0,
      task_count: 0,
      sla_count: 0,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(await readThresholdException(fixture.missingPolicy.investigationId)).toEqual([
      expect.objectContaining({
        lifecycle_status: 'open',
        unmatched_reason: 'no_matching_rule',
        occurrence_count: 1,
        task_status: 'open',
        task_priority: 'high',
        assigned_to_role: 'LAB_INCHARGE',
        criticality_status: 'threshold_unavailable',
      }),
    ]);
    expect(notificationObservations).toHaveLength(0);
  }, 30_000);

  it('persists a unit mismatch without inventing a conversion and opens its owner task', async () => {
    const recorded = await recordLabPanel(panelArgs('K_UNIT_MISMATCH', fixture.unitMismatch));
    expect(recorded).toMatchObject({
      criticals_fired: 0,
      results: [expect.objectContaining({
        criticality_status: 'threshold_unavailable',
        is_critical: false,
        threshold_policy_bundle_id: fixture.policyBundleId,
        threshold_policy_rule_id: null,
        threshold_catalog_entry_id: fixture.catalogEntries.get('K_UNIT_MISMATCH'),
      })],
    });
    expect(await readCounts(fixture.unitMismatch.investigationId)).toEqual({
      result_count: 1,
      alert_count: 0,
      task_count: 0,
      sla_count: 0,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(await readThresholdException(fixture.unitMismatch.investigationId)).toEqual([
      expect.objectContaining({
        lifecycle_status: 'open',
        unmatched_reason: 'unit_mismatch',
        occurrence_count: 1,
        task_status: 'open',
        task_priority: 'high',
        assigned_to_role: 'LAB_INCHARGE',
        criticality_status: 'threshold_unavailable',
        threshold_policy_bundle_id: fixture.policyBundleId,
        threshold_catalog_entry_id: fixture.catalogEntries.get('K_UNIT_MISMATCH'),
      }),
    ]);
    expect(notificationObservations).toHaveLength(0);
  }, 30_000);

  it('rolls back every critical rail on late canonical failure, then binds one exact owner task/SLA', async () => {
    fault.failCanonicalAudit = true;

    await expect(recordLabPanel(panelArgs('K_ATOMIC', fixture.atomic)))
      .rejects.toThrow(FORCED_FAILURE);
    expect(fault.hit).toBe(true);
    expect(await readCounts(fixture.atomic.investigationId)).toEqual({
      result_count: 0,
      alert_count: 0,
      task_count: 0,
      sla_count: 0,
      timeline_count: 0,
      audit_count: 0,
    });
    expect(notificationObservations).toHaveLength(0);

    fault.failCanonicalAudit = false;
    fault.hit = false;
    const recorded = await recordLabPanel(panelArgs('K_ATOMIC', fixture.atomic));
    const resultId = recorded.results[0].id;

    const bindings = await prisma.$queryRawUnsafe(
      `SELECT result.is_critical,
              alert.id AS alert_id,
              alert.acknowledgement_task_id,
              alert.generation_metadata,
              task.id AS task_id,
              task.status AS task_status,
              task.assigned_to_uid,
              task.assigned_to_role,
              task.sla_completion_semantics,
              task.metadata AS task_metadata,
              sla.id AS sla_id,
              sla.rule_code,
              sla.source_table,
              sla.source_id,
              sla.status AS sla_status,
              sla.completed_at
         FROM lab_results AS result
         JOIN lab_critical_alerts AS alert
           ON alert.tenant_id = result.tenant_id
          AND alert.result_id = result.id
          AND alert.superseded_at IS NULL
         JOIN tasks AS task
           ON task.tenant_id = alert.tenant_id
          AND task.id = alert.acknowledgement_task_id
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE result.tenant_id = $1::uuid
          AND result.id = $2::int`,
      TENANT_ID,
      resultId,
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      is_critical: true,
      acknowledgement_task_id: bindings[0].task_id,
      task_status: 'open',
      assigned_to_uid: DOCTOR_UID,
      assigned_to_role: null,
      sla_completion_semantics: 'acknowledgement',
      rule_code: 'critical_result_ack',
      source_table: 'lab_result',
      source_id: String(resultId),
      sla_status: 'active',
      completed_at: null,
    });
    expect(bindings[0].generation_metadata).toMatchObject({
      kind: 'initial_result_generation',
      source: 'lab_panel',
      acknowledgement_task_id: bindings[0].task_id,
      corrected_state: 'critical',
    });
    expect(bindings[0].task_metadata).toMatchObject({
      lab_critical_alert_id: bindings[0].alert_id,
      lab_alert_generation_state: 'critical',
    });
    expect(await readCounts(fixture.atomic.investigationId)).toEqual({
      result_count: 1,
      alert_count: 1,
      task_count: 1,
      sla_count: 1,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(notificationObservations).toHaveLength(1);
    expect(notificationObservations[0].binding).toMatchObject({
      alert_id: bindings[0].alert_id,
      acknowledgement_task_id: bindings[0].task_id,
      task_id: bindings[0].task_id,
      sla_id: bindings[0].sla_id,
    });

    const replay = await actualPrismaModule.setTenantTx(TENANT_ID, (tx) => (
      materializeLabCriticalAlertGeneration({
        tx,
        tenantId: TENANT_ID,
        resultId,
        expectedPatientUid: PATIENT_UID,
        criticality: {
          breached: true,
          matched: true,
          breachedSide: 'high',
          breachedValue: 6.5,
          evaluatedValue: 7.2,
          criticalLow: 2.5,
          criticalHigh: 6.5,
          thresholdUnit: 'mmol/L',
        },
        orderingClinicianUid: DOCTOR_UID,
        source: 'lab_panel',
      })
    ));
    expect(replay).toMatchObject({
      created: false,
      alert: { id: bindings[0].alert_id },
      task: { taskId: bindings[0].task_id, slaInstanceId: bindings[0].sla_id },
    });
    expect(await readCounts(fixture.atomic.investigationId)).toMatchObject({
      result_count: 1,
      alert_count: 1,
      task_count: 1,
      sla_count: 1,
    });
  }, 60_000);

  it('assigns an investigation-only critical panel to DUTY_DOCTOR when no orderer exists', async () => {
    const recorded = await recordLabPanel(panelArgs('K_FALLBACK', fixture.fallback));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT result.booking_id,
              result.investigation_id,
              task.assigned_to_uid,
              task.assigned_to_role
         FROM lab_results AS result
         JOIN lab_critical_alerts AS alert
           ON alert.tenant_id = result.tenant_id
          AND alert.result_id = result.id
         JOIN tasks AS task
           ON task.tenant_id = alert.tenant_id
          AND task.id = alert.acknowledgement_task_id
        WHERE result.tenant_id = $1::uuid
          AND result.id = $2::int`,
      TENANT_ID,
      recorded.results[0].id,
    );
    expect(rows[0]).toMatchObject({
      booking_id: null,
      investigation_id: fixture.fallback.investigationId,
      assigned_to_uid: null,
      assigned_to_role: 'DUTY_DOCTOR',
    });
    expect(notificationObservations[0].args).toMatchObject({
      recipientUids: [],
      recipientRoles: ['DUTY_DOCTOR'],
    });
  }, 30_000);

  it('carries an investigation-only panel through pathologist sign-off', async () => {
    const recorded = await recordLabPanel(panelArgs('K_SIGNOFF', fixture.signoff, {
      analytes: [{
        test_code: 'K_SIGNOFF',
        test_name: 'K_SIGNOFF potassium',
        value_numeric: 4.2,
        value_text: '4.2',
        unit: 'mmol/L',
      }],
    }));
    const resultId = recorded.results[0].id;

    const signoff = await signOffResults({
      tenantId: TENANT_ID,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      signed_off_by_name: 'Panel pathologist',
      signed_off_by_reg: 'PANEL-REG-1',
      result_ids: [resultId],
      decision: 'verified',
      patient_uid: PATIENT_UID,
    });

    expect(signoff).toMatchObject({ patient_uid: PATIENT_UID, booking_id: null });
    const evidence = await prisma.$queryRawUnsafe(
      `SELECT result.investigation_id,
              result.signed_off_by,
              result.signed_off_at,
              signoff.id AS signoff_id,
              (SELECT COUNT(*)::int
                 FROM clinical_timeline_events AS timeline
                WHERE timeline.tenant_id = $1::uuid
                  AND timeline.source_table = 'lab_pathologist_signoffs'
                  AND timeline.source_id = signoff.id::text) AS timeline_count,
              (SELECT COUNT(*)::int
                 FROM clinical_audit_events AS audit
                WHERE audit.tenant_id = $1::uuid
                  AND audit.resource_table = 'lab_pathologist_signoffs'
                  AND audit.resource_id = signoff.id::text) AS audit_count
         FROM lab_results AS result
         JOIN lab_pathologist_signoffs AS signoff
           ON signoff.tenant_id = result.tenant_id
          AND result.id = ANY(signoff.result_ids)
        WHERE result.tenant_id = $1::uuid
          AND result.id = $2::int`,
      TENANT_ID,
      resultId,
    );
    expect(evidence[0]).toMatchObject({
      investigation_id: fixture.signoff.investigationId,
      signed_off_by: PATHOLOGIST_UID,
      signoff_id: signoff.id,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(evidence[0].signed_off_at).toBeTruthy();
  }, 30_000);

  it('replays the exact route response and rejects changed payload under the same key', async () => {
    const key = `lab-panel-replay-${SUFFIX}`;
    const body = panelBody('K_REPLAY', fixture.replay);
    const first = await request(app)
      .post('/api/v1/lab/panels')
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.statusCode).toBe(200);
    await waitForIdempotencyComplete(key);

    const replay = await request(app)
      .post('/api/v1/lab/panels')
      .set('Idempotency-Key', key)
      .send(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(first.body);

    const mismatch = await request(app)
      .post('/api/v1/lab/panels')
      .set('Idempotency-Key', key)
      .send({
        ...body,
        analytes: [{ ...body.analytes[0], value_numeric: 7.8, value_text: '7.8' }],
      });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.body.message).toMatch(/different request body/i);
    expect(await readCounts(fixture.replay.investigationId)).toMatchObject({
      result_count: 1,
      alert_count: 1,
      task_count: 1,
      sla_count: 1,
    });
  }, 30_000);

  it('collapses a concurrent double-submit to one clinical result and one acknowledgement obligation', async () => {
    const key = `lab-panel-concurrent-${SUFFIX}`;
    const body = panelBody('K_CONCURRENT', fixture.concurrent);
    const [left, right] = await Promise.all([
      request(app).post('/api/v1/lab/panels').set('Idempotency-Key', key).send(body),
      request(app).post('/api/v1/lab/panels').set('Idempotency-Key', key).send(body),
    ]);
    const statuses = [left.statusCode, right.statusCode].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    if (left.statusCode === 200 && right.statusCode === 200) {
      expect(right.body).toEqual(left.body);
    }
    await waitForIdempotencyComplete(key);

    const finalReplay = await request(app)
      .post('/api/v1/lab/panels')
      .set('Idempotency-Key', key)
      .send(body);
    expect(finalReplay.statusCode).toBe(200);
    const firstSuccess = left.statusCode === 200 ? left : right;
    expect(finalReplay.body).toEqual(firstSuccess.body);
    expect(await readCounts(fixture.concurrent.investigationId)).toMatchObject({
      result_count: 1,
      alert_count: 1,
      task_count: 1,
      sla_count: 1,
    });
  }, 30_000);
});
