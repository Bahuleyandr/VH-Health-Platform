// NL-6/N6-12 mortuary custody chain deep walk.
//
// Covers death certification substrate reuse plus the new custody-only slice:
// certify -> receive -> store(slot) -> release, medicolegal release block,
// append-only custody chain, slot occupancy consistency, and unclaimed-body
// escalation through the existing workflow SLA/task engine.

import prisma, { setTenantTx } from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import {
  createDeathRecord,
  transition,
  recordBodyRelease,
  recordPoliceClearance,
  createMortuarySlot,
  listMortuarySlots,
  recordBodyReceive,
  recordBodyStorage,
  recordMortuaryBodyRelease,
  getBodyCustodyChain,
  mortuaryBoard,
  _internal,
} from '../services/clinical/deathCertificationService.js';
import { runEscalationSweep } from '../services/workflow/escalationEngineService.js';
import { acknowledgeTask, transitionTask } from '../services/workflow/taskService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const RUN = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_UID = `c6120000-0000-4000-8000-${RUN.padStart(12, '0')}`;
const ACTOR_UID = '550e8400-e29b-41d4-a716-446655440000';
const PHONE = `+9196612${RUN}`;
const SLOT_CODE = `MORTTEST-${RUN}`;
const FAIL_TASK_FUNCTION = `vh_test_fail_mortuary_task_${RUN}`;
const FAIL_TASK_TRIGGER = `vh_test_fail_mortuary_task_trigger_${RUN}`;

let deathRecordId = null;
let slotId = null;

async function cleanup() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${FAIL_TASK_TRIGGER}" ON tasks`).catch(() => {});
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FAIL_TASK_FUNCTION}"()`).catch(() => {});
  const deathIds = await prisma.$queryRawUnsafe(
    `SELECT id FROM death_records WHERE tenant_id = $1::uuid AND notes LIKE 'MORTTEST%'`,
    DEFAULT_TENANT_ID,
  ).catch(() => []);
  const ids = deathIds.map((row) => Number(row.id)).filter(Boolean);
  for (const id of ids) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM task_comments WHERE task_id IN (
         SELECT id FROM tasks
          WHERE tenant_id = $1::uuid
            AND related_resource_type = 'death_record'
            AND related_resource_id = $2
       )`,
      DEFAULT_TENANT_ID,
      String(id),
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'death_record'
          AND related_resource_id = $2`,
      DEFAULT_TENANT_ID,
      String(id),
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND rule_code = $2
          AND source_table = 'death_records'
          AND source_id = $3`,
      DEFAULT_TENANT_ID,
      _internal.UNCLAIMED_SLA_KEY,
      String(id),
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `UPDATE mortuary_slots
        SET status = 'available',
            current_death_record_id = NULL,
            occupied_since = NULL
      WHERE tenant_id = $1::uuid AND slot_code LIKE 'MORTTEST%'`,
    DEFAULT_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM body_custody_events
      WHERE tenant_id = $1::uuid
        AND death_record_id IN (SELECT id FROM death_records WHERE notes LIKE 'MORTTEST%')`,
    DEFAULT_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM mortuary_slots WHERE tenant_id = $1::uuid AND slot_code LIKE 'MORTTEST%'`,
    DEFAULT_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM mortality_reviews
      WHERE tenant_id = $1::uuid
        AND death_record_id IN (SELECT id FROM death_records WHERE notes LIKE 'MORTTEST%')`,
    DEFAULT_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM death_records WHERE tenant_id = $1::uuid AND notes LIKE 'MORTTEST%'`,
    DEFAULT_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
    DEFAULT_TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
}

async function readSlot() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, current_death_record_id
       FROM mortuary_slots
      WHERE tenant_id = $1::uuid AND slot_code = $2
      LIMIT 1`,
    DEFAULT_TENANT_ID,
    SLOT_CODE,
  );
  return rows[0] || null;
}

async function readUnclaimedTask() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, priority, workflow_sla_instance_id,
            sla_completion_semantics, metadata
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = 'death_record'
        AND related_resource_id = $2
        AND metadata->>'sla_key' = $3
      ORDER BY id DESC
      LIMIT 1`,
    DEFAULT_TENANT_ID,
    String(deathRecordId),
    _internal.UNCLAIMED_SLA_KEY,
  );
  return rows[0] || null;
}

async function setUnclaimedSlaBreachedAt(slaInstanceId, whenIso) {
  await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'breached',
              breached_at = $2::timestamptz,
              due_at = $2::timestamptz,
              updated_at = NOW()
        WHERE id = $1::uuid AND tenant_id = $3::uuid`,
      slaInstanceId,
      whenIso,
      DEFAULT_TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `UPDATE tasks
          SET due_at = $2::timestamptz,
              updated_at = NOW()
        WHERE tenant_id = $3::uuid
          AND workflow_sla_instance_id = $1::uuid
          AND status IN ('open', 'in_progress', 'blocked', 'overdue')`,
      slaInstanceId,
      whenIso,
      DEFAULT_TENANT_ID,
    );
  });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT breached_at
       FROM workflow_sla_instances
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    slaInstanceId,
    DEFAULT_TENANT_ID,
  );
  return new Date(rows[0].breached_at);
}

d('Mortuary body custody chain (NL-6/N6-12)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'MORTTEST Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID,
      PHONE,
      DEFAULT_TENANT_ID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('certifies the death record, receives and stores the body, and starts the unclaimed timer', async () => {
    const record = await createDeathRecord({
      tenantId: DEFAULT_TENANT_ID,
      patient_uid: PATIENT_UID,
      date_of_death: '2026-07-07',
      time_of_death: '09:30',
      place_of_death: 'inpatient',
      ward_or_unit: 'MORTTEST Ward',
      cause_part_1a: 'Head injury',
      manner_of_death: 'accident',
      is_medicolegal: true,
      police_station: 'MORTTEST PS',
      police_fir_no: `MORT/FIR/${RUN}`,
      notes: `MORTTEST ${RUN}`,
    });
    deathRecordId = Number(record.id);

    const certified = await transition({
      tenantId: DEFAULT_TENANT_ID,
      id: deathRecordId,
      to_status: 'certified',
      certified_by: ACTOR_UID,
      certifier_name: 'Dr Mort Test',
      registration_no: `MMC-${RUN}`,
    });
    expect(certified.status).toBe('certified');
    expect(certified.mccd_serial).toMatch(/^MCCD-/);

    const slot = await createMortuarySlot({
      tenantId: DEFAULT_TENANT_ID,
      slot_code: SLOT_CODE,
      display_name: `Mortuary Test Slot ${RUN}`,
    });
    slotId = Number(slot.id);

    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION "${FAIL_TASK_FUNCTION}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.related_resource_type = 'death_record'
            AND NEW.related_resource_id = '${deathRecordId}' THEN
           RAISE EXCEPTION 'forced mortuary task insert failure';
         END IF;
         RETURN NEW;
       END
       $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${FAIL_TASK_TRIGGER}"
         BEFORE INSERT ON tasks
         FOR EACH ROW EXECUTE FUNCTION "${FAIL_TASK_FUNCTION}"()`,
    );

    try {
      await expect(recordBodyReceive({
        tenantId: DEFAULT_TENANT_ID,
        id: deathRecordId,
        performed_by: ACTOR_UID,
        performed_by_role: 'MEDICAL_RECORDS',
        witness_name: 'Security Witness',
        is_unclaimed: true,
        unclaimed_reason: 'No claimant present at receipt',
        notes: 'MORTTEST forced rollback',
      })).rejects.toThrow(/forced mortuary task insert failure/i);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${FAIL_TASK_TRIGGER}" ON tasks`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FAIL_TASK_FUNCTION}"()`);
    }

    const rolledBack = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM body_custody_events
           WHERE tenant_id = $1::uuid AND death_record_id = $2::int) AS custody_count,
         (SELECT COUNT(*)::int FROM workflow_sla_instances
           WHERE tenant_id = $1::uuid
             AND rule_code = $3
             AND source_table = 'death_records'
             AND source_id = $2::text) AS sla_count,
         (SELECT COUNT(*)::int FROM tasks
           WHERE tenant_id = $1::uuid
             AND related_resource_type = 'death_record'
             AND related_resource_id = $2::text) AS task_count`,
      DEFAULT_TENANT_ID,
      deathRecordId,
      _internal.UNCLAIMED_SLA_KEY,
    );
    expect(rolledBack[0]).toEqual({ custody_count: 0, sla_count: 0, task_count: 0 });

    const receive = await recordBodyReceive({
      tenantId: DEFAULT_TENANT_ID,
      id: deathRecordId,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
      witness_name: 'Security Witness',
      is_unclaimed: true,
      unclaimed_reason: 'No claimant present at receipt',
      notes: 'MORTTEST received',
    });
    expect(receive.event_type).toBe('receive');
    expect(receive.is_unclaimed).toBe(true);

    const stored = await recordBodyStorage({
      tenantId: DEFAULT_TENANT_ID,
      id: deathRecordId,
      slot_id: slotId,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
      witness_name: 'Mortuary Attendant',
      notes: 'MORTTEST stored',
    });
    expect(stored.event_type).toBe('store');
    expect(Number(stored.slot_id)).toBe(slotId);

    const occupied = await readSlot();
    expect(occupied.status).toBe('occupied');
    expect(Number(occupied.current_death_record_id)).toBe(deathRecordId);

    const task = await readUnclaimedTask();
    expect(task).toBeTruthy();
    expect(task.metadata.sla_key).toBe(_internal.UNCLAIMED_SLA_KEY);
  });

  it('keeps custody events append-only and escalates the unclaimed timer through the existing engine', async () => {
    const chain = await getBodyCustodyChain({ tenantId: DEFAULT_TENANT_ID, id: deathRecordId });
    expect(chain.events.map((event) => event.event_type)).toEqual(['receive', 'store']);

    await expect(prisma.$executeRawUnsafe(
      `UPDATE body_custody_events SET notes = 'mutated' WHERE id = $1::bigint`,
      chain.events[0].id,
    )).rejects.toThrow(/append-only/i);

    const task = await readUnclaimedTask();
    const slaId = task.workflow_sla_instance_id;
    expect(slaId).toBeTruthy();
    expect(task.sla_completion_semantics).toBe('domain_evidence');
    const breachSeen = await setUnclaimedSlaBreachedAt(slaId, '2026-07-07T00:00:00.000Z');
    const counters = await runEscalationSweep({ now: new Date(breachSeen.getTime() + 60_000) });
    expect(counters.escalated).toBeGreaterThanOrEqual(1);

    const escalated = await readUnclaimedTask();
    const tiers = Array.isArray(escalated.metadata.escalations)
      ? escalated.metadata.escalations.map((entry) => entry.tier)
      : [];
    expect(tiers).toContain(1);

    const board = await mortuaryBoard({ tenantId: DEFAULT_TENANT_ID });
    expect(board.occupancy.occupied).toBeGreaterThanOrEqual(1);
    expect(board.unclaimed.some((row) => Number(row.death_record_id) === deathRecordId)).toBe(true);
  });

  it('records acknowledgement without completing the domain-evidence SLA', async () => {
    const task = await readUnclaimedTask();
    await expect(transitionTask({
      tenantId: DEFAULT_TENANT_ID,
      id: task.id,
      nextStatus: 'cancelled',
      actorUid: ACTOR_UID,
    })).rejects.toMatchObject({ code: 'TASK_LINKED_SLA_INCOMPLETE' });

    const acknowledged = await acknowledgeTask({
      tenantId: DEFAULT_TENANT_ID,
      id: task.id,
      actorUid: ACTOR_UID,
      actorRoles: ['MEDICAL_RECORDS'],
    });
    expect(acknowledged.status).toBe('in_progress');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      DEFAULT_TENANT_ID,
      task.workflow_sla_instance_id,
    );
    expect(rows[0].completed_at).toBeNull();
    expect(rows[0].metadata?.completion_evidence).toBeUndefined();
  });

  it('blocks medicolegal release until police clearance, then releases and frees the slot', async () => {
    await expect(recordMortuaryBodyRelease({
      tenantId: DEFAULT_TENANT_ID,
      id: deathRecordId,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
      body_released_to_name: 'Relative Mort Test',
      body_released_to_relation: 'brother',
      release_method: 'family',
    })).rejects.toThrow(/police clearance/i);

    await recordPoliceClearance({
      tenantId: DEFAULT_TENANT_ID,
      id: deathRecordId,
      station: 'MORTTEST PS',
      fir_no: `MORT/FIR/${RUN}`,
    });

    await expect(recordBodyRelease({
      tenantId: DEFAULT_TENANT_ID,
      id: deathRecordId,
      body_released_to_name: 'Relative Mort Test',
      body_released_to_relation: 'brother',
      body_release_witnessed_by: ACTOR_UID,
      body_release_method: 'family',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MORTUARY_CUSTODY_RELEASE_REQUIRED',
    });

    const afterLegacyAttempt = await prisma.$queryRawUnsafe(
      `SELECT body_released_at,
              (SELECT COUNT(*)::int
                 FROM body_custody_events event
                WHERE event.tenant_id = death_records.tenant_id
                  AND event.death_record_id = death_records.id
                  AND event.event_type = 'release') AS release_event_count
         FROM death_records
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT_ID,
      deathRecordId,
    );
    expect(afterLegacyAttempt[0]).toEqual({
      body_released_at: null,
      release_event_count: 0,
    });
    expect((await readSlot()).status).toBe('occupied');
    const taskAfterLegacyAttempt = await readUnclaimedTask();
    expect(taskAfterLegacyAttempt.status).toBe('in_progress');
    const slaAfterLegacyAttempt = await prisma.$queryRawUnsafe(
      `SELECT completed_at
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      DEFAULT_TENANT_ID,
      taskAfterLegacyAttempt.workflow_sla_instance_id,
    );
    expect(slaAfterLegacyAttempt[0].completed_at).toBeNull();

    const released = await recordMortuaryBodyRelease({
      tenantId: DEFAULT_TENANT_ID,
      id: deathRecordId,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
      body_released_to_name: 'Relative Mort Test',
      body_released_to_relation: 'brother',
      body_released_to_id_proof: 'AADHAAR-1234',
      witness_name: 'Mortuary Witness',
      release_method: 'family',
    });
    expect(released.death_record.body_released_at).toBeTruthy();
    expect(released.custody_event.event_type).toBe('release');

    const freed = await readSlot();
    expect(freed.status).toBe('available');
    expect(freed.current_death_record_id).toBeNull();

    const task = await readUnclaimedTask();
    expect(task.status).toBe('completed');

    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      DEFAULT_TENANT_ID,
      task.workflow_sla_instance_id,
    );
    expect(slaRows[0].completed_at).toBeTruthy();
    expect(slaRows[0].metadata).toMatchObject({
      completed_via: 'domain_evidence',
      completion_evidence: {
        kind: 'mortuary_body_release',
        resource_type: 'body_custody_event',
        resource_id: String(released.custody_event.id),
      },
    });

    const chain = await getBodyCustodyChain({ tenantId: DEFAULT_TENANT_ID, id: deathRecordId });
    expect(chain.events.map((event) => event.event_type)).toEqual(['receive', 'store', 'release']);
  });
});
