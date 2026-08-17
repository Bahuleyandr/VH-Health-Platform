// General facility asset register (migration 704).
//
// Covers: tenant-scoped CRUD with explicit-predicate scoping (CI runs with
// the RLS flag off, so cross-tenant denial must come from the service's own
// tenant_id predicates), per-tenant asset-tag uniqueness (same tag OK across
// tenants), the guarded status machine (disposal requires reason + actor,
// disposed terminal), same-transaction event appends (and DB-level rollback
// of the master mutation when the event insert fails), and audit survival
// (events outlive a hard-deleted asset via SET NULL + snapshots).

import { randomUUID } from 'node:crypto';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const {
  createFacilityAsset,
  getFacilityAsset,
  listFacilityAssetCustodians,
  listFacilityAssets,
  listFacilityAssetEvents,
  recordFacilityAssetMaintenance,
  transitionFacilityAssetStatus,
  updateFacilityAsset,
} = await import('../services/facility/facilityAssetService.js');

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const ADMIN_UID = randomUUID();
const CUSTODIAN_UID = randomUUID();
const OTHER_CUSTODIAN_UID = randomUUID();
const PATIENT_UID = randomUUID();
const INACTIVE_STAFF_UID = randomUUID();

async function cleanupTenant(tenantId) {
  await prisma.$executeRawUnsafe(`DELETE FROM facility_asset_events WHERE tenant_id = $1::uuid`, tenantId).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM facility_assets WHERE tenant_id = $1::uuid`, tenantId).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = $1::uuid`, tenantId).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId).catch(() => {});
}

async function cleanup() {
  await cleanupTenant(TENANT_ID);
  await cleanupTenant(OTHER_TENANT_ID);
}

async function eventTypes(tenantId, assetId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT event_type FROM facility_asset_events
      WHERE tenant_id = $1::uuid AND asset_id = $2::int
      ORDER BY id ASC`,
    tenantId,
    assetId,
  );
  return rows.map((r) => r.event_type);
}

d('Facility asset register (migration 704)', () => {
  beforeAll(async () => {
    await cleanup();
    for (const [id, name] of [[TENANT_ID, 'Asset Register Tenant'], [OTHER_TENANT_ID, 'Asset Register Other']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, settings) VALUES ($1::uuid, $2::text, $3::text, '{}'::jsonb)`,
        id,
        `assets-${id.slice(0, 8)}`,
        name,
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Tenant custodian', 'MAINTENANCE', TRUE, NOW()),
              ($3::uuid, $4::uuid, 'Other tenant custodian', 'MAINTENANCE', TRUE, NOW()),
              ($5::uuid, $2::uuid, 'Patient account', 'PATIENT', TRUE, NOW()),
              ($6::uuid, $2::uuid, 'Inactive staff', 'MAINTENANCE', FALSE, NOW())`,
      CUSTODIAN_UID,
      TENANT_ID,
      OTHER_CUSTODIAN_UID,
      OTHER_TENANT_ID,
      PATIENT_UID,
      INACTIVE_STAFF_UID,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  let assetId;

  it('creates an asset with a created event in the same transaction', async () => {
    const created = await createFacilityAsset(TENANT_ID, {
      assetTag: '  GEN-02 ',
      name: 'Diesel generator <b>125 kVA</b>',
      category: 'generator',
      locationDepartment: 'Plant room',
      locationRoom: 'B-04',
      vendor: 'Kirloskar',
      purchaseDate: '2024-01-15',
      purchaseCost: 1250000.5,
      warrantyUntil: '2027-01-15',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });
    assetId = created.id;
    expect(created).toMatchObject({
      assetTag: 'GEN-02',
      name: 'Diesel generator 125 kVA', // stripHtml applied
      category: 'generator',
      condition: 'good',
      status: 'active',
      purchaseCost: 1250000.5,
      createdBy: ADMIN_UID,
      version: 1,
    });
    expect(await eventTypes(TENANT_ID, assetId)).toEqual(['created']);
  });

  it('enforces per-tenant tag uniqueness while allowing the same tag across tenants', async () => {
    await expect(createFacilityAsset(TENANT_ID, {
      assetTag: 'GEN-02', name: 'Duplicate tag', category: 'generator',
    }, { actorUid: ADMIN_UID })).rejects.toMatchObject({
      statusCode: 409,
      code: 'FACILITY_ASSET_TAG_EXISTS',
    });
    const crossTenant = await createFacilityAsset(OTHER_TENANT_ID, {
      assetTag: 'GEN-02', name: 'Other hospital generator', category: 'generator',
    }, { actorUid: null });
    expect(crossTenant.assetTag).toBe('GEN-02');
  });

  it('scopes reads and writes by tenant (explicit predicates, not RLS)', async () => {
    await expect(getFacilityAsset(OTHER_TENANT_ID, assetId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'FACILITY_ASSET_NOT_FOUND',
    });
    await expect(updateFacilityAsset(OTHER_TENANT_ID, assetId, { name: 'Hijack', expectedVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 404, code: 'FACILITY_ASSET_NOT_FOUND' });
    await expect(transitionFacilityAssetStatus(OTHER_TENANT_ID, assetId, {
      toStatus: 'condemned',
    }, { actorUid: ADMIN_UID })).rejects.toMatchObject({ statusCode: 404 });

    const list = await listFacilityAssets(OTHER_TENANT_ID, {});
    expect(list.assets.map((a) => a.id)).not.toContain(assetId);
  });

  it('records moves, custodian assignment and condition changes as typed events', async () => {
    const before = await getFacilityAsset(TENANT_ID, assetId);
    const updated = await updateFacilityAsset(TENANT_ID, assetId, {
      expectedVersion: before.version,
      locationDepartment: 'Basement plant room',
      custodianUid: CUSTODIAN_UID,
      condition: 'fair',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });
    expect(updated).toMatchObject({
      locationDepartment: 'Basement plant room',
      custodianUid: CUSTODIAN_UID,
      condition: 'fair',
      version: before.version + 1,
    });
    expect(await eventTypes(TENANT_ID, assetId)).toEqual([
      'created', 'moved', 'custodian_assigned', 'condition_changed',
    ]);
    const events = await listFacilityAssetEvents(TENANT_ID, assetId, { limit: 10 });
    const moved = events.events.find((e) => e.eventType === 'moved');
    expect(moved.details.from_location.department).toBe('Plant room');
    expect(moved.details.to_location.department).toBe('Basement plant room');
  });

  it('rejects cross-tenant custodians in the service and composite FK backstop', async () => {
    const before = await getFacilityAsset(TENANT_ID, assetId);
    await expect(updateFacilityAsset(TENANT_ID, assetId, {
      expectedVersion: before.version,
      custodianUid: OTHER_CUSTODIAN_UID,
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'FACILITY_ASSET_CUSTODIAN_INVALID',
    });

    await expect(prisma.$executeRawUnsafe(
      `UPDATE facility_assets
          SET custodian_uid = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      assetId,
      OTHER_CUSTODIAN_UID,
    )).rejects.toThrow(/fk_facility_assets_custodian|foreign key constraint/i);
  });

  it('lists and accepts only active non-patient tenant custodians', async () => {
    const picker = await listFacilityAssetCustodians(TENANT_ID, {});
    expect(picker.custodians).toEqual(expect.arrayContaining([
      expect.objectContaining({ uid: CUSTODIAN_UID, role: 'MAINTENANCE' }),
    ]));
    expect(picker.custodians.map((row) => row.uid)).not.toContain(PATIENT_UID);
    expect(picker.custodians.map((row) => row.uid)).not.toContain(INACTIVE_STAFF_UID);
    expect(picker.custodians.map((row) => row.uid)).not.toContain(OTHER_CUSTODIAN_UID);

    const before = await getFacilityAsset(TENANT_ID, assetId);
    await expect(updateFacilityAsset(TENANT_ID, assetId, {
      expectedVersion: before.version,
      custodianUid: PATIENT_UID,
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'FACILITY_ASSET_CUSTODIAN_INVALID',
    });
  });

  it('rejects a stale full-form edit without overwriting the winning update', async () => {
    const staleAsset = await createFacilityAsset(TENANT_ID, {
      assetTag: 'STALE-01', name: 'Stale-session asset', category: 'other',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });
    const firstSession = await getFacilityAsset(TENANT_ID, staleAsset.id);
    const secondSession = await getFacilityAsset(TENANT_ID, staleAsset.id);
    const winner = await updateFacilityAsset(TENANT_ID, staleAsset.id, {
      expectedVersion: firstSession.version,
      vendor: 'Winning vendor',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });

    await expect(updateFacilityAsset(TENANT_ID, staleAsset.id, {
      expectedVersion: secondSession.version,
      vendor: 'Stale vendor',
      name: 'Stale full form',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'FACILITY_ASSET_STALE_WRITE',
      details: {
        expectedVersion: secondSession.version,
        currentVersion: winner.version,
      },
    });

    const after = await getFacilityAsset(TENANT_ID, staleAsset.id);
    expect(after).toMatchObject({
      name: firstSession.name,
      vendor: 'Winning vendor',
      version: winner.version,
    });
  });

  it('clears every nullable master field when PATCH explicitly sends null', async () => {
    const nullableAsset = await createFacilityAsset(TENANT_ID, {
      assetTag: 'CLEAR-01',
      name: 'Clearable asset',
      category: 'other',
      description: 'Temporary description',
      locationDepartment: 'Stores',
      locationRoom: 'S-01',
      custodianUid: CUSTODIAN_UID,
      vendor: 'Temporary vendor',
      purchaseDate: '2025-01-02',
      purchaseCost: 1234.5,
      warrantyUntil: '2027-01-02',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });

    const cleared = await updateFacilityAsset(TENANT_ID, nullableAsset.id, {
      expectedVersion: nullableAsset.version,
      description: null,
      locationDepartment: null,
      locationRoom: null,
      custodianUid: null,
      vendor: null,
      purchaseDate: null,
      purchaseCost: null,
      warrantyUntil: null,
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });

    expect(cleared).toMatchObject({
      description: null,
      locationDepartment: null,
      locationRoom: null,
      custodianUid: null,
      vendor: null,
      purchaseDate: null,
      purchaseCost: null,
      warrantyUntil: null,
      version: nullableAsset.version + 1,
    });
    expect(await eventTypes(TENANT_ID, nullableAsset.id)).toEqual([
      'created', 'moved', 'custodian_assigned', 'updated',
    ]);
  });

  it('walks the repair lifecycle: repair_opened → maintenance → repair_closed', async () => {
    const repairing = await transitionFacilityAssetStatus(TENANT_ID, assetId, {
      toStatus: 'under_repair', notes: 'Coolant leak',
    }, { actorUid: ADMIN_UID, actorRole: 'MAINTENANCE' });
    expect(repairing.status).toBe('under_repair');

    const maintenance = await recordFacilityAssetMaintenance(TENANT_ID, assetId, {
      notes: 'Replaced coolant hose', cost: 4500, vendor: 'Kirloskar Service',
    }, { actorUid: ADMIN_UID, actorRole: 'MAINTENANCE' });
    expect(maintenance.event).toMatchObject({ eventType: 'maintenance' });
    expect(maintenance.event.details).toMatchObject({ cost: 4500, vendor: 'Kirloskar Service' });

    const active = await transitionFacilityAssetStatus(TENANT_ID, assetId, {
      toStatus: 'active',
    }, { actorUid: ADMIN_UID, actorRole: 'MAINTENANCE' });
    expect(active.status).toBe('active');
    expect(await eventTypes(TENANT_ID, assetId)).toEqual([
      'created', 'moved', 'custodian_assigned', 'condition_changed',
      'repair_opened', 'maintenance', 'repair_closed',
    ]);
  });

  it('requires reason + actor for disposal, stamps the evidence, and makes disposed terminal', async () => {
    await expect(transitionFacilityAssetStatus(TENANT_ID, assetId, {
      toStatus: 'disposed',
    }, { actorUid: ADMIN_UID })).rejects.toMatchObject({
      statusCode: 422,
      code: 'FACILITY_ASSET_DISPOSAL_REASON_REQUIRED',
    });

    const condemned = await transitionFacilityAssetStatus(TENANT_ID, assetId, {
      toStatus: 'condemned', reason: 'Failed safety audit',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });
    expect(condemned.status).toBe('condemned');
    // condemned only moves forward to disposed.
    await expect(transitionFacilityAssetStatus(TENANT_ID, assetId, {
      toStatus: 'active',
    }, { actorUid: ADMIN_UID })).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });

    const disposed = await transitionFacilityAssetStatus(TENANT_ID, assetId, {
      toStatus: 'disposed', reason: 'Condemned and scrapped',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });
    expect(disposed).toMatchObject({
      status: 'disposed',
      disposalReason: 'Condemned and scrapped',
      disposedBy: ADMIN_UID,
    });
    expect(disposed.disposedAt).toBeTruthy();

    // Terminal: nothing leaves disposed, and edits/maintenance are refused.
    await expect(transitionFacilityAssetStatus(TENANT_ID, assetId, {
      toStatus: 'active',
    }, { actorUid: ADMIN_UID })).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      details: { from: 'disposed', allowed: [] },
    });
    await expect(updateFacilityAsset(TENANT_ID, assetId, {
      name: 'Zombie edit', expectedVersion: disposed.version,
    }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FACILITY_ASSET_DISPOSED' });
    await expect(recordFacilityAssetMaintenance(TENANT_ID, assetId, { notes: 'Too late' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FACILITY_ASSET_DISPOSED' });

    expect(await eventTypes(TENANT_ID, assetId)).toEqual([
      'created', 'moved', 'custodian_assigned', 'condition_changed',
      'repair_opened', 'maintenance', 'repair_closed', 'condemned', 'disposed',
    ]);
  });

  it('pins the DB layer: disposal evidence CHECK and master/event same-tx rollback', async () => {
    // The 704 two-directional CHECK rejects disposed-without-evidence at the
    // DB even if service code regressed.
    await expect(prisma.$executeRawUnsafe(
      `UPDATE facility_assets SET status = 'disposed'
        WHERE tenant_id = $1::uuid AND asset_tag = 'GEN-02'`,
      OTHER_TENANT_ID,
    )).rejects.toThrow(/chk_facility_asset_disposal_evidence|check constraint/i);

    // Same-transaction atomicity of the exact statement pair the service
    // issues: when the event INSERT fails (here: a status event without
    // to_status, violating chk_facility_asset_event_transition), the master
    // UPDATE in the same transaction rolls back with it.
    const other = await listFacilityAssets(OTHER_TENANT_ID, {});
    const otherId = other.assets[0].id;
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE facility_assets SET name = 'Should roll back'
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        OTHER_TENANT_ID,
        otherId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO facility_asset_events
           (tenant_id, asset_id, asset_tag_snapshot, asset_name_snapshot, event_type)
         VALUES ($1::uuid, $2::int, 'GEN-02', 'Other hospital generator', 'status_changed')`,
        OTHER_TENANT_ID,
        otherId,
      );
    })).rejects.toThrow(/chk_facility_asset_event_transition|check constraint/i);
    const after = await getFacilityAsset(OTHER_TENANT_ID, otherId);
    expect(after.name).toBe('Other hospital generator'); // master update rolled back
  });

  it('keeps the event trail with snapshots after a hard delete (audit survival)', async () => {
    const doomed = await createFacilityAsset(TENANT_ID, {
      assetTag: 'CHAIR-99', name: 'Visitor chair', category: 'furniture',
    }, { actorUid: ADMIN_UID, actorRole: 'ADMIN' });
    await prisma.$executeRawUnsafe(
      `DELETE FROM facility_assets WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      doomed.id,
    );
    const rows = await prisma.$queryRawUnsafe(
      `SELECT asset_id, asset_tag_snapshot, asset_name_snapshot, event_type
         FROM facility_asset_events
        WHERE tenant_id = $1::uuid AND asset_tag_snapshot = 'CHAIR-99'`,
      TENANT_ID,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      asset_id: null, // ON DELETE SET NULL
      asset_tag_snapshot: 'CHAIR-99',
      asset_name_snapshot: 'Visitor chair',
      event_type: 'created',
    });
  });

  it('filters the register by status, category and search', async () => {
    const byStatus = await listFacilityAssets(TENANT_ID, { status: 'disposed' });
    expect(byStatus.assets.map((a) => a.id)).toEqual([assetId]);
    const byCategory = await listFacilityAssets(TENANT_ID, { category: 'furniture' });
    expect(byCategory.assets).toHaveLength(0); // CHAIR-99 was hard-deleted
    const bySearch = await listFacilityAssets(TENANT_ID, { q: 'gen-02' });
    expect(bySearch.assets.map((a) => a.id)).toEqual([assetId]);
    const byLocation = await listFacilityAssets(TENANT_ID, { q: 'basement plant' });
    expect(byLocation.assets.map((a) => a.id)).toEqual([assetId]);
    await expect(listFacilityAssets(TENANT_ID, { status: 'melted' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'FACILITY_ASSET_INVALID',
    });
  });
});
