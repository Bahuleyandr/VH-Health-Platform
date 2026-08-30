// BE-H1 (review 2026-08-09) — deep regression: a medication order that
// commits while MAR scheduling fails must leave DURABLE detectors, not just
// a log line.
//
// createOrder commits the order, then the post-commit hook
// dispatchOrderIntegrations expands the schedule; C-L3 made expandSchedule
// throw MAR_DURATION_EXCEEDS_WINDOW for over-window durations, so a
// duration_days beyond the MAR window is a deterministic way to make MAR
// scheduling fail AFTER the order stands. The escalation contract:
//   * the order still exists (post-commit — it must stand),
//   * zero scheduled doses exist for it,
//   * a clinical_audit_events row exists with action_status 'failed' and the
//     deterministic idempotency key clinical_orders:<id>:mar_schedule_failed,
//   * notification_outbox alert rows exist with source_event_key
//     clinical_orders:<id>:mar_schedule_failed:alert — one per CONCRETE
//     duty-doctor/doctor-tier recipient (fix R2: the outbox has no topic
//     delivery, so the old single recipientId:null broadcast row reached
//     nobody; queueClinicalAlertFanout resolves recipients at enqueue time).
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured.

import { randomUUID } from 'crypto';

import prisma from '../lib/prisma.js';
import { createOrder } from '../services/emr/orderEntryService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { DOCTOR_TIERS } from '../utils/roleHelpers.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = DEFAULT_TENANT_ID;
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const ENCOUNTER_ID = randomUUID();
const CATALOG_NAME = `Escalatol-${randomUUID().slice(0, 8)}`;
const WARD_NAME = `MAR Escalation Ward ${randomUUID().slice(0, 8)}`;
let catalogId;

let phoneSequence = 0;
function nextPhone() {
  phoneSequence += 1;
  return `+9187${String(Date.now()).slice(-7)}${phoneSequence}`;
}

async function seedUser(uid, role, name) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW()) RETURNING id`,
    uid, nextPhone(), name, role, TENANT,
  );
  return rows[0].id;
}

// The escalation runs on an un-awaited post-commit promise chain (the MAR
// dispatch is deliberately not awaited for medication orders), so poll
// briefly instead of asserting immediately.
async function pollForRows(sql, params, { attempts = 40, delayMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    if (rows.length) return rows;
    await new Promise((resolve) => { setTimeout(resolve, delayMs); });
  }
  return [];
}

async function cleanup() {
  const orderIds = await prisma.$queryRawUnsafe(
    `SELECT id FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => []);
  for (const { id } of orderIds) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM notification_outbox WHERE source_event_key LIKE $1`, `clinical_orders:${id}:%`,
    ).catch(() => {});
  }
  for (const table of ['tasks', 'workflow_sla_instances']) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
        TENANT,
        PATIENT_UID
      )
      .catch(() => {});
  }
  for (const table of [
    'ward_indent_inventory_allocations',
    'ward_indent_events',
    'ward_indent_items'
  ]) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM ${table}
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT id FROM ward_indents
             WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          )`,
        TENANT,
        PATIENT_UID
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM ward_indents WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM beds WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM wards WHERE tenant_id = $1::uuid AND name = $2`,
      TENANT,
      WARD_NAME
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog WHERE tenant_id = $1::uuid AND name = $2`,
      TENANT,
      CATALOG_NAME
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      DOCTOR_UID
    )
    .catch(() => {});
}

d('BE-H1 — MAR scheduling failure on a committed medication order escalates durably', () => {
  beforeAll(async () => {
    await cleanup();
    await seedUser(PATIENT_UID, 'PATIENT', 'MAR Escalation Patient');
    await seedUser(DOCTOR_UID, 'DOCTOR', 'MAR Escalation Doctor');
    const facilities = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM facilities
        WHERE tenant_id = $1::uuid
          AND facility_code = 'SEED-MAIN'
          AND status = 'active'
        ORDER BY id`,
      TENANT,
    );
    if (facilities.length !== 1) {
      throw new Error('BE-H1 MAR escalation fixture requires exactly one active SEED-MAIN facility');
    }
    const facilityId = Number(facilities[0].id);
    const wardId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO wards
         (tenant_id, facility_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $3::int, $2, 1, NOW(), NOW()) RETURNING id`,
          TENANT,
          WARD_NAME,
          facilityId,
        )
      )[0].id
    );
    const bedId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3, $4, 'occupied', $5::uuid,
               NOW(), NOW()) RETURNING id`,
          TENANT,
          wardId,
          WARD_NAME,
          `MAR-ESC-${String(Date.now()).slice(-8)}`,
          PATIENT_UID
        )
      )[0].id
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, admitting_doctor, attending_doctor,
          bed_id, ward, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
               $5::int, $6, 'admitted', NOW(), NOW())`,
      TENANT,
      PATIENT_UID,
      ENCOUNTER_ID,
      DOCTOR_UID,
      bedId,
      WARD_NAME
    );
    const composition = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1, $2, ARRAY['escalatol']::text[], 'curated')
       RETURNING id`,
      `mar_escalation_${randomUUID()}`,
      CATALOG_NAME,
    );
    const catalog = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, generic_name, is_active, composition_id,
          composition_confidence, composition_source, strength, strength_key,
          strength_components, form, form_key, route, release_key, updated_at)
       VALUES ($1::uuid, $2, 'escalatol', TRUE, $3::int,
               'high', 'curated', '500mg', '500mg', $4::jsonb,
               'tablet', 'tablet', 'oral', 'ir', NOW())
       RETURNING id`,
      TENANT,
      CATALOG_NAME,
      Number(composition[0].id),
      JSON.stringify([{ ingredient: 'escalatol', value: 500, unit: 'mg' }]),
    );
    catalogId = Number(catalog[0].id);
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('order commits, zero MAR doses, and BOTH durable detectors exist', async () => {
    const { order } = await createOrder({
      tenantId: TENANT,
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: ENCOUNTER_ID,
      priority: 'routine',
      ordered_by: DOCTOR_UID,
      details: {
        medication_name: CATALOG_NAME,
        catalog_id: catalogId,
        quantity_requested: 10,
        unit: 'tablet',
        dose: '500mg',
        route: 'oral',
        frequency: 'BD',
        // Deterministically beyond every MAR scheduling window -> C-L3 throw
        // in the post-commit hook, i.e. order committed + zero doses.
        duration_days: 4000,
      },
    });

    expect(order?.id).toBeTruthy();

    // Durable detector #1 — the failed clinical audit row.
    const auditRows = await pollForRows(
      `SELECT action, action_status, resource_table, resource_id, metadata
         FROM clinical_audit_events
        WHERE idempotency_key = $1`,
      [`clinical_orders:${order.id}:mar_schedule_failed`],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'mar_scheduling_failed',
      action_status: 'failed',
      resource_table: 'clinical_orders',
      resource_id: String(order.id),
    });
    expect(auditRows[0].metadata).toMatchObject({
      failure_stage: 'mar_schedule',
      error_code: 'MAR_DURATION_EXCEEDS_WINDOW',
    });

    // Durable detector #2 — the staff alert in the notification outbox.
    // Fanned out at enqueue time to CONCRETE duty-doctor/doctor-tier
    // recipients (queueClinicalAlertFanout): one PENDING row per resolved
    // recipient, all sharing the deterministic source_event_key. The poll can
    // observe a partial fan-out mid-insert, so assert shape + audience, not
    // an exact count.
    const outboxRows = await pollForRows(
      `SELECT status, channel, title, payload, recipient_id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND source_event_key = $2`,
      [TENANT, `clinical_orders:${order.id}:mar_schedule_failed:alert`],
    );
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    for (const row of outboxRows) {
      expect(row.status).toBe('PENDING');
      expect(row.title).toMatch(/no scheduled mar doses/i);
    }
    // Every row targets a real, distinct recipient — no recipient-less
    // broadcast rows survive (they reached nobody).
    const recipientIds = outboxRows.map((row) => row.recipient_id);
    expect(recipientIds.every((id) => id !== null && String(id).trim() !== '')).toBe(true);
    expect(new Set(recipientIds.map(String)).size).toBe(recipientIds.length);
    // And the audience is the tenant's active doctor-tier staff (exact
    // DUTY_DOCTOR preferred, doctor-tier family fallback — both subsets of
    // DOCTOR_TIERS).
    const doctorRows = await prisma.$queryRawUnsafe(
      `SELECT uid FROM users
        WHERE tenant_id = $1::uuid AND is_active = TRUE AND role = ANY($2::text[])`,
      TENANT, DOCTOR_TIERS,
    );
    const doctorIds = new Set(doctorRows.map((row) => String(row.uid)));
    expect(recipientIds.every((id) => doctorIds.has(String(id)))).toBe(true);

    // The failure really did leave zero scheduled doses for this order.
    const marRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM medication_administrations WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(marRows).toHaveLength(0);

    // And the order row itself stands (post-commit hook must not undo it).
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM clinical_orders WHERE id = $1::int`,
      order.id,
    );
    expect(orderRows).toHaveLength(1);
  }, 30_000);
});
