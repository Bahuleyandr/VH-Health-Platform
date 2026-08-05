import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  authorizeColdChainRecoveryResume,
  canonicalCommandFingerprint,
  enqueueColdChainRecoveryItem,
  processNextItemTx,
  registerColdChainRecoveryOffset,
} from '../services/integrations/externalInterfaceRecoveryService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const POLICY = Object.freeze({
  policyVersion: 'c-d8-v1',
  policySignature: `synthetic-${SUFFIX}`,
  retentionPolicy: 'cold-chain-730d',
  retentionUntil: '2029-07-31T00:00:00.000Z',
});

let facilityId;
let locationId;
let deviceId;
let unitId;

async function counts() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::integer FROM cold_chain_readings
         WHERE tenant_id = $1::uuid) AS readings,
       (SELECT COUNT(*)::integer FROM tasks
         WHERE tenant_id = $1::uuid
           AND related_resource_type = 'cold_chain_readings') AS tasks,
       (SELECT COUNT(*)::integer FROM cold_chain_excursions
         WHERE tenant_id = $1::uuid) AS excursions,
       (SELECT COUNT(*)::integer FROM workflow_sla_instances
         WHERE tenant_id = $1::uuid) AS slas,
       (SELECT COUNT(*)::integer FROM care_pathway_transition_events
         WHERE tenant_id = $1::uuid) AS transitions`,
    TENANT_ID,
  );
  return rows[0];
}

function command(position, tempC = 10) {
  return {
    source_reading_id: `reading-${position}`,
    unit_id: unitId,
    device_registry_id: deviceId,
    temp_c: tempC,
    humidity_pct: 45,
    battery_pct: 88,
    recorded_at: `2026-07-31T00:${String(position % 60).padStart(2, '0')}:00.000Z`,
    metadata: { source: 'synthetic-c6-1' },
  };
}

async function registerOffset({
  partition,
  initialPosition = 100,
  initialToken = 'token-100',
  retainedFromPosition = 100,
  retainedFromToken = 'token-100',
} = {}) {
  const offset = await registerColdChainRecoveryOffset({
    tenantId: TENANT_ID,
    facilityId,
    sourcePartition: partition,
    initialPosition,
    initialToken,
    retainedFromPosition,
    retainedFromToken,
    ...POLICY,
  });
  return offset;
}

describeIfDb('external-interface recovery substrate and I10 adapter', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1 I10 tenant')`,
      TENANT_ID,
      `c61-i10-${SUFFIX}`,
    );
    const facilities = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, timezone)
       VALUES ($1::uuid, $2::text, 'C6.1 I10 facility', 'Asia/Kolkata')
       RETURNING id`,
      TENANT_ID,
      `C61-I10-${SUFFIX}`,
    );
    facilityId = facilities[0].id;
    const locations = await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
       (tenant_id, facility_id, location_code, display_name, location_kind)
       VALUES ($1::uuid, $2::integer, $3::text, 'C6.1 cold room', 'pharmacy')
       RETURNING id`,
      TENANT_ID,
      facilityId,
      `COLD-${SUFFIX}`,
    );
    locationId = locations[0].id;
    const devices = await prisma.$queryRawUnsafe(
      `INSERT INTO device_registry
         (tenant_id, device_code, display_name, kind, protocol, status,
          location_id)
       VALUES
         ($1::uuid, $2::text, 'C6.1 sensor', 'fridge_sensor',
          'http-json', 'active', $3::integer)
       RETURNING id`,
      TENANT_ID,
      `C61-SENSOR-${SUFFIX}`,
      locationId,
    );
    deviceId = devices[0].id;
    const units = await prisma.$queryRawUnsafe(
      `INSERT INTO cold_chain_units
         (tenant_id, facility_id, unit_code, display_name, kind, department,
          location_id, device_registry_id, min_temp_c, max_temp_c,
          excursion_grace_minutes, alert_roles, status, retention_days)
       VALUES
         ($1::uuid, $2::integer, $3::text, 'C6.1 refrigerator', 'fridge',
          'pharmacy', $4::integer, $5::integer, 2, 8, 15,
          ARRAY['PHARMACY_STAFF']::text[], 'active', 730)
       RETURNING id`,
      TENANT_ID,
      facilityId,
      `C61-UNIT-${SUFFIX}`,
      locationId,
      deviceId,
    );
    unitId = units[0].id;
  });

  afterAll(async () => {
    await setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM cold_chain_readings WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pathway_projector_inbox
          WHERE tenant_id = $1::uuid AND scope_kind = 'external_interface'`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid AND scope_kind = 'external_interface'`,
        TENANT_ID,
      );
    }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM cold_chain_units WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM device_registry WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM facility_locations WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM facilities WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$disconnect();
  }, 60_000);

  it('fingerprints canonical command content independently of property order', () => {
    expect(canonicalCommandFingerprint({ z: 1, nested: { b: 2, a: 1 } }))
      .toBe(canonicalCommandFingerprint({ nested: { a: 1, b: 2 }, z: 1 }));
  });

  it('refuses a premature item without committing it as head-of-line work', async () => {
    const offset = await registerOffset({
      partition: `facility:${facilityId}:unit:${unitId}:sensor:${deviceId}:premature`,
    });
    const item = command(101, 5);
    await expect(enqueueColdChainRecoveryItem({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      sourcePosition: 101,
      sourceToken: 'premature-token-101',
      predecessorToken: 'token-100',
      duplicateKey: item.source_reading_id,
      occurredAt: item.recorded_at,
      command: item,
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_OFFSET_NOT_REPLAYING' });
    const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      offset.offset_id,
    ));
    expect(rows[0].count).toBe(0);
  });

  it('resumes contiguously, creates only reading plus pending review, and deduplicates retry', async () => {
    const offset = await registerOffset({
      partition: `facility:${facilityId}:unit:${unitId}:sensor:${deviceId}:primary`,
    });
    await authorizeColdChainRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      resumeCutoffPosition: 102,
      resumeCutoffToken: 'token-102',
    });
    const before = await counts();

    for (const position of [101, 102]) {
      const item = command(position, position === 101 ? 10 : 5);
      await enqueueColdChainRecoveryItem({
        tenantId: TENANT_ID,
        offsetId: offset.offset_id,
        sourcePosition: position,
        sourceToken: `token-${position}`,
        predecessorToken: `token-${position - 1}`,
        duplicateKey: item.source_reading_id,
        occurredAt: item.recorded_at,
        command: item,
      });
      const outcome = await processNextItemTx({
        tenantId: TENANT_ID,
        offsetId: offset.offset_id,
        sourcePosition: position,
        sourceToken: `token-${position}`,
        predecessorToken: `token-${position - 1}`,
        duplicateKey: item.source_reading_id,
        command: item,
      });
      expect(outcome).toMatchObject({
        status: 'handled',
        outcome_code: 'cold_chain_reading_pending_review',
        cursor: {
          high_water_position: String(position),
          high_water_token: `token-${position}`,
          recovery_state: position === 102 ? 'ready' : 'replaying',
        },
      });
      if (position === 101) {
        const duplicate = await enqueueColdChainRecoveryItem({
          tenantId: TENANT_ID,
          offsetId: offset.offset_id,
          sourcePosition: 101,
          sourceToken: 'token-101',
          predecessorToken: 'token-100',
          duplicateKey: item.source_reading_id,
          occurredAt: item.recorded_at,
          command: item,
        });
        expect(duplicate).toMatchObject({
          duplicate: true,
          status: 'handled',
          outcome_code: 'cold_chain_reading_pending_review',
        });
      }
    }

    const after = await counts();
    expect(after).toEqual({
      readings: before.readings + 2,
      tasks: before.tasks + 2,
      excursions: before.excursions,
      slas: before.slas,
      transitions: before.transitions,
    });

    expect(await counts()).toEqual(after);
  }, 60_000);

  it('fails closed on conflicting duplicate evidence', async () => {
    const offset = await registerOffset({
      partition: `facility:${facilityId}:unit:${unitId}:sensor:${deviceId}:conflict`,
    });
    await authorizeColdChainRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      resumeCutoffPosition: 101,
      resumeCutoffToken: 'conflict-token-101',
    });
    const first = command(101, 5);
    await enqueueColdChainRecoveryItem({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      sourcePosition: 101,
      sourceToken: 'conflict-token-101',
      predecessorToken: 'token-100',
      duplicateKey: first.source_reading_id,
      occurredAt: first.recorded_at,
      command: first,
    });
    await expect(enqueueColdChainRecoveryItem({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      sourcePosition: 101,
      sourceToken: 'conflict-token-101',
      predecessorToken: 'token-100',
      duplicateKey: first.source_reading_id,
      occurredAt: first.recorded_at,
      command: { ...first, temp_c: 20 },
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_IDENTITY_CONFLICT' });
    const state = await setTenantTx(TENANT_ID, (tx) => tx.$queryRawUnsafe(
      `SELECT recovery_state, reconciliation_reason
         FROM event_consumer_offsets
        WHERE offset_id = $1::uuid`,
      offset.offset_id,
    ));
    expect(state[0]).toMatchObject({
      recovery_state: 'reconciliation_required_source_gap',
      reconciliation_reason: 'duplicate_or_position_fingerprint_conflict',
    });
  });

  it('rejects a missing marker and never infers zero, head, or replay-all', async () => {
    const offset = await registerOffset({
      partition: `facility:${facilityId}:unit:${unitId}:sensor:${deviceId}:missing`,
      initialPosition: null,
      initialToken: null,
      retainedFromPosition: null,
      retainedFromToken: null,
    });
    expect(offset).toMatchObject({
      recovery_state: 'reconciliation_required_missing_marker',
      high_water_position: null,
      high_water_token: null,
    });
    const item = command(1, 5);
    await expect(authorizeColdChainRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      resumeCutoffPosition: 1,
      resumeCutoffToken: 'token-1',
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_RESUME_NOT_ELIGIBLE' });
    await expect(enqueueColdChainRecoveryItem({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      sourcePosition: 1,
      sourceToken: 'token-1',
      predecessorToken: 'token-0',
      duplicateKey: item.source_reading_id,
      occurredAt: item.recorded_at,
      command: item,
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_OFFSET_NOT_REPLAYING' });
  });

  it('freezes the partition at a retention gap before applying the domain fact', async () => {
    const offset = await registerOffset({
      partition: `facility:${facilityId}:unit:${unitId}:sensor:${deviceId}:retention`,
      initialPosition: 10,
      initialToken: 'retention-token-10',
      retainedFromPosition: 12,
      retainedFromToken: 'retention-token-12',
    });
    await authorizeColdChainRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      resumeCutoffPosition: 12,
      resumeCutoffToken: 'retention-token-12',
    });
    const item = {
      ...command(11, 10),
      source_reading_id: 'retention-reading-11',
    };
    await enqueueColdChainRecoveryItem({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      sourcePosition: 11,
      sourceToken: 'retention-token-11',
      predecessorToken: 'retention-token-10',
      duplicateKey: item.source_reading_id,
      occurredAt: item.recorded_at,
      command: item,
    });
    const before = await counts();
    expect(await processNextItemTx({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      sourcePosition: 11,
      sourceToken: 'retention-token-11',
      predecessorToken: 'retention-token-10',
      duplicateKey: item.source_reading_id,
      command: item,
    })).toMatchObject({ held: true, reason: 'retention_gap' });
    expect(await counts()).toEqual(before);
  });
});
