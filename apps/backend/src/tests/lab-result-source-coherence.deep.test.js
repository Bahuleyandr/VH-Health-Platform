import { createHash } from 'node:crypto';

import prisma from '../lib/prisma.js';
import { recordResultManual, signOffResults } from '../services/lab/labResultsService.js';

const DB_CONFIGURED = !!(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_A_UID = `c4a00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_B_UID = `c4b00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const TECH_UID = `c4c00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATHOLOGIST_UID = `c4d00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const ALL_UIDS = [PATIENT_A_UID, PATIENT_B_UID, TECH_UID, PATHOLOGIST_UID];

const investigationIds = [];
const bookingIds = [];
const resultIds = [];
let patientAId;
let patientBId;
let techId;
let coherentResultId;
let coherentBookingId;
let commandSequence = 0;

function recordManual(input) {
  commandSequence += 1;
  return recordResultManual({
    ...input,
    idempotencyKey: `source-coherence-${SUFFIX}-${commandSequence}`,
    requestBodySha256: createHash('sha256')
      .update(JSON.stringify(input.result))
      .digest('hex'),
  });
}

async function insertUser(uid, phone, name, role) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, NOW())
     RETURNING id`,
    uid,
    TENANT,
    phone,
    name,
    role,
  );
  return Number(rows[0].id);
}

async function insertInvestigation(patientId, patientUid, phone, testName) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, patient_id, patient_uid, phone, test_name, status, updated_at)
     VALUES ($1::uuid, $2::int, $3::uuid, $4, $5, 'REQUESTED', NOW())
     RETURNING id`,
    TENANT,
    patientId,
    patientUid,
    phone,
    testName,
  );
  investigationIds.push(Number(rows[0].id));
  return Number(rows[0].id);
}

async function insertBooking(patientId, investigationId) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigation_bookings
       (tenant_id, patient_id, investigation_id, selected_tests, actual_tests, status, updated_at)
     VALUES ($1::uuid, $2::int, $3::int, '{}'::int[], '{}'::int[], 'BOOKED', NOW())
     RETURNING id`,
    TENANT,
    patientId,
    investigationId,
  );
  bookingIds.push(String(rows[0].id));
  return Number(rows[0].id);
}

async function countResultsFor(investigationId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND investigation_id = $2::int`,
    TENANT,
    investigationId,
  );
  return rows[0].count;
}

async function investigationStatus(investigationId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status
       FROM investigations
      WHERE tenant_id = $1::uuid
        AND id = $2::int`,
    TENANT,
    investigationId,
  );
  return rows[0]?.status;
}

async function commandCountForActor() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM lab_result_ingest_commands
      WHERE tenant_id = $1::uuid
        AND actor_uid = $2::uuid
        AND command_key LIKE $3`,
    TENANT,
    TECH_UID,
    `source-coherence-${SUFFIX}-%`,
  );
  return rows[0].count;
}

async function loadSignoffEvidence(signoffId, resultIdsForNotification) {
  const signoffs = await prisma.$queryRawUnsafe(
    `SELECT id, booking_id, patient_uid, result_ids
       FROM lab_pathologist_signoffs
      WHERE tenant_id = $1::uuid
        AND id = $2::int`,
    TENANT,
    signoffId,
  );
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT payload
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND source_table = 'lab_pathologist_signoffs'
        AND source_id = $2
        AND event_type = 'lab.result_signed_off'
      ORDER BY id DESC
      LIMIT 1`,
    TENANT,
    String(signoffId),
  );
  const notifications = await prisma.$queryRawUnsafe(
    `SELECT data
       FROM notifications
      WHERE uid = $1::uuid
        AND type = 'lab_result_ready'
        AND data->'result_ids' = to_jsonb($2::int[])
      ORDER BY id DESC
      LIMIT 1`,
    PATIENT_A_UID,
    resultIdsForNotification,
  );
  return {
    signoff: signoffs[0],
    timeline: timeline[0],
    notification: notifications[0],
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
      WHERE type IN ('lab_result_ready', 'lab_result_corrected')
        AND recipient_id IN (
          SELECT id::text FROM users WHERE uid = ANY($1::uuid[])
        )`,
    ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM notifications WHERE uid = ANY($1::uuid[])`,
    ALL_UIDS,
  ).catch(() => {});
  for (const resultId of resultIds) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_pathologist_signoffs WHERE $1::int = ANY(result_ids)`,
      resultId,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])
        AND source_table IN ('lab_results', 'lab_pathologist_signoffs')`,
    TENANT,
    [PATIENT_A_UID, PATIENT_B_UID],
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results
      WHERE tenant_id = $1::uuid
        AND patient_uid = ANY($2::uuid[])`,
    TENANT,
    [PATIENT_A_UID, PATIENT_B_UID],
  ).catch(() => {});
  if (bookingIds.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigation_booking_history WHERE booking_id = ANY($1::bigint[])`,
      bookingIds,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigation_bookings WHERE id = ANY($1::bigint[])`,
      bookingIds,
    ).catch(() => {});
  }
  if (investigationIds.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE id = ANY($1::int[])`,
      investigationIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
    ALL_UIDS,
  ).catch(() => {});
}

d('Manual lab-result source coherence', () => {
  beforeAll(async () => {
    await cleanup();
    patientAId = await insertUser(
      PATIENT_A_UID,
      `+91981${SUFFIX}`,
      'Coherence Patient A',
      'PATIENT',
    );
    patientBId = await insertUser(
      PATIENT_B_UID,
      `+91982${SUFFIX}`,
      'Coherence Patient B',
      'PATIENT',
    );
    techId = await insertUser(
      TECH_UID,
      `+91983${SUFFIX}`,
      'Coherence Lab Tech',
      'LAB_TECHNICIAN',
    );
    await insertUser(
      PATHOLOGIST_UID,
      `+91984${SUFFIX}`,
      'Coherence Pathologist',
      'PATHOLOGIST',
    );
  }, 30000);

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('rejects patient A with patient B investigation before result or order mutation', async () => {
    const investigationId = await insertInvestigation(
      patientBId,
      PATIENT_B_UID,
      `982${SUFFIX}`,
      'Coherence mismatch investigation',
    );

    await expect(recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: PATIENT_A_UID,
        investigation_id: investigationId,
        test_code: `COHINV${SUFFIX}`,
        test_name: 'Investigation mismatch test',
        value_text: '4.1',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
      message: 'Lab result source does not match the patient or investigation',
    });

    expect(await countResultsFor(investigationId)).toBe(0);
    expect(await investigationStatus(investigationId)).toBe('REQUESTED');
  });

  it('rejects an investigation whose stored patient id and patient uid disagree', async () => {
    const investigationId = await insertInvestigation(
      patientBId,
      PATIENT_A_UID,
      `981${SUFFIX}`,
      'Internally incoherent investigation',
    );
    const commandsBefore = await commandCountForActor();

    await expect(recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: PATIENT_A_UID,
        investigation_id: investigationId,
        test_code: `COHPID${SUFFIX}`,
        test_name: 'Investigation patient-id coherence test',
        value_text: '4.1',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });

    expect(await countResultsFor(investigationId)).toBe(0);
    expect(await investigationStatus(investigationId)).toBe('REQUESTED');
    expect(await commandCountForActor()).toBe(commandsBefore);
  });

  it('rejects a staff UID presented as the patient on a direct investigation with zero writes', async () => {
    const investigationId = await insertInvestigation(
      techId,
      TECH_UID,
      `983${SUFFIX}`,
      'Staff identity direct investigation',
    );
    const commandsBefore = await commandCountForActor();

    await expect(recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: TECH_UID,
        investigation_id: investigationId,
        test_code: `COHSTAFFD${SUFFIX}`,
        test_name: 'Staff identity direct test',
        value_text: '4.1',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });

    expect(await countResultsFor(investigationId)).toBe(0);
    expect(await investigationStatus(investigationId)).toBe('REQUESTED');
    expect(await commandCountForActor()).toBe(commandsBefore);
  });

  it('rejects a booking whose linked user is staff rather than a patient with zero writes', async () => {
    const investigationId = await insertInvestigation(
      techId,
      TECH_UID,
      `983${SUFFIX}`,
      'Staff identity booking investigation',
    );
    const bookingId = await insertBooking(techId, investigationId);
    const commandsBefore = await commandCountForActor();

    await expect(recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: TECH_UID,
        booking_id: bookingId,
        investigation_id: investigationId,
        test_code: `COHSTAFFB${SUFFIX}`,
        test_name: 'Staff identity booking test',
        value_text: '4.2',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });

    expect(await countResultsFor(investigationId)).toBe(0);
    expect(await investigationStatus(investigationId)).toBe('REQUESTED');
    expect(await commandCountForActor()).toBe(commandsBefore);
  });

  it('rejects a completed investigation and rolls back its ingest command claim', async () => {
    const investigationId = await insertInvestigation(
      patientAId,
      PATIENT_A_UID,
      `981${SUFFIX}`,
      'Terminal investigation',
    );
    await prisma.$executeRawUnsafe(
      `UPDATE investigations
          SET status = 'COMPLETED', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      investigationId,
    );
    const commandsBefore = await commandCountForActor();

    await expect(recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: PATIENT_A_UID,
        investigation_id: investigationId,
        test_code: `COHTERMI${SUFFIX}`,
        test_name: 'Terminal investigation test',
        value_text: '4.3',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });

    expect(await countResultsFor(investigationId)).toBe(0);
    expect(await investigationStatus(investigationId)).toBe('COMPLETED');
    expect(await commandCountForActor()).toBe(commandsBefore);
  });

  it('rejects a cancelled booking and rolls back its ingest command claim', async () => {
    const investigationId = await insertInvestigation(
      patientAId,
      PATIENT_A_UID,
      `981${SUFFIX}`,
      'Terminal booking investigation',
    );
    const bookingId = await insertBooking(patientAId, investigationId);
    await prisma.$executeRawUnsafe(
      `UPDATE investigation_bookings
          SET status = 'CANCELLED', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT,
      bookingId,
    );
    const commandsBefore = await commandCountForActor();

    await expect(recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: PATIENT_A_UID,
        booking_id: bookingId,
        investigation_id: investigationId,
        test_code: `COHTERMB${SUFFIX}`,
        test_name: 'Terminal booking test',
        value_text: '4.4',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });

    expect(await countResultsFor(investigationId)).toBe(0);
    expect(await investigationStatus(investigationId)).toBe('REQUESTED');
    expect(await commandCountForActor()).toBe(commandsBefore);
  });

  it('rejects a booking owned by patient B even when it points to patient A investigation', async () => {
    const investigationId = await insertInvestigation(
      patientAId,
      PATIENT_A_UID,
      `981${SUFFIX}`,
      'Coherence booking mismatch',
    );
    const bookingId = await insertBooking(patientBId, investigationId);

    await expect(recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: PATIENT_A_UID,
        booking_id: bookingId,
        test_code: `COHBKG${SUFFIX}`,
        test_name: 'Booking mismatch test',
        value_text: '4.2',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
      message: 'Lab result source does not match the patient or investigation',
    });

    expect(await countResultsFor(investigationId)).toBe(0);
    expect(await investigationStatus(investigationId)).toBe('REQUESTED');
  });

  it('records a result when booking, investigation, and patient are coherent', async () => {
    const investigationId = await insertInvestigation(
      patientAId,
      PATIENT_A_UID,
      `981${SUFFIX}`,
      'Coherent source',
    );
    const bookingId = await insertBooking(patientAId, investigationId);

    const output = await recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: PATIENT_A_UID,
        booking_id: bookingId,
        investigation_id: investigationId,
        patient_name: 'Forged Patient Name',
        test_code: `COHOK${SUFFIX}`,
        test_name: 'Coherent source test',
        value_text: '4.3',
      },
    });
    resultIds.push(Number(output.result.id));
    coherentResultId = Number(output.result.id);
    coherentBookingId = bookingId;

    expect(output.result.patient_uid).toBe(PATIENT_A_UID);
    expect(output.result.patient_name).toBe('Coherence Patient A');
    expect(Number(output.result.investigation_id)).toBe(investigationId);
    expect(Number(output.result.booking_id)).toBe(bookingId);
    expect(await countResultsFor(investigationId)).toBe(1);
    expect(await investigationStatus(investigationId)).toBe('IN_PROGRESS');
  });

  it('derives a homogeneous booking for durable sign-off evidence without a premature notification', async () => {
    const signoff = await signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [coherentResultId],
      decision: 'verified',
    });
    const evidence = await loadSignoffEvidence(signoff.id, [coherentResultId]);

    expect(Number(signoff.booking_id)).toBe(coherentBookingId);
    expect(Number(evidence.signoff.booking_id)).toBe(coherentBookingId);
    expect(evidence.timeline.payload.booking_id).toBe(coherentBookingId);
    expect(evidence.notification).toBeUndefined();
  });

  it('rejects a cross-episode batch with or without a booking assertion', async () => {
    const investigationA = await insertInvestigation(
      patientAId,
      PATIENT_A_UID,
      `981${SUFFIX}`,
      'Mixed source A',
    );
    const investigationB = await insertInvestigation(
      patientAId,
      PATIENT_A_UID,
      `981${SUFFIX}`,
      'Mixed source B',
    );
    const bookingA = await insertBooking(patientAId, investigationA);
    const bookingB = await insertBooking(patientAId, investigationB);
    const first = await recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: PATIENT_A_UID,
        booking_id: bookingA,
        investigation_id: investigationA,
        test_code: `COHMIXA${SUFFIX}`,
        test_name: 'Mixed booking A',
        value_text: '4.4',
      },
    });
    const second = await recordManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        patient_uid: PATIENT_A_UID,
        booking_id: bookingB,
        investigation_id: investigationB,
        test_code: `COHMIXB${SUFFIX}`,
        test_name: 'Mixed booking B',
        value_text: '4.5',
      },
    });
    const mixedResultIds = [Number(first.result.id), Number(second.result.id)];
    resultIds.push(...mixedResultIds);

    await expect(signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: mixedResultIds,
      booking_id: bookingA,
      decision: 'verified',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_MULTI_EPISODE_BATCH',
    });

    const before = await prisma.$queryRawUnsafe(
      `SELECT signed_off_at FROM lab_results WHERE id = ANY($1::int[]) ORDER BY id`,
      mixedResultIds,
    );
    expect(before.every((row) => row.signed_off_at == null)).toBe(true);

    await expect(signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: mixedResultIds,
      decision: 'verified',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_MULTI_EPISODE_BATCH',
    });
  });
});
