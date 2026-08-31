import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

const migration = read('migrations/753_pharmacy_order_inventory_authority.sql');
const facilityAuthority = read('services/pharmacy/pharmacyFacilityAuthorityService.js');
const catalogController = read('controllers/pharmacy/pharmacyOrderController.js');

describe('pharmacy recovery receipt source contracts', () => {
  it('records byte-truthful generic and ward reopen target_after rows in the trigger', () => {
    expect(migration.match(/WHEN event_kind='REOPENED' THEN to_jsonb\(NEW\)/g)).toHaveLength(2);

    const genericTrigger = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION append_pharmacy_authority_recovery_event_753'),
      migration.indexOf('CREATE OR REPLACE FUNCTION reject_pharmacy_authority_recovery_event_mutation_753'),
    );
    const wardTrigger = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION append_ward_alloc_recovery_event_753'),
      migration.indexOf('CREATE TRIGGER trg_ward_alloc_recovery_event_753'),
    );
    for (const trigger of [genericTrigger, wardTrigger]) {
      expect(trigger).toContain("WHEN event_kind='REOPENED' THEN to_jsonb(NEW)");
      expect(trigger).toMatch(/CASE WHEN TG_OP='UPDATE' THEN to_jsonb\(OLD\)[\s\S]*to_jsonb\(NEW\)/);
    }
  });

  it('locks an exact open staff recovery before any facility grant mutation', () => {
    const locker = facilityAuthority.slice(
      facilityAuthority.indexOf('async function lockGrantRecoveryTx'),
      facilityAuthority.indexOf('export function pharmacyFacilityActorFromRequest'),
    );
    expect(locker).toContain("entity_type='staff_facility_grant'");
    expect(locker).toContain("reason_code='STAFF_FACILITY_GRANT_REQUIRED'");
    expect(locker).toContain('AND ($3::bigint IS NULL OR id=$3::bigint)');
    expect(locker).toContain("AND ($3::bigint IS NOT NULL OR status='OPEN')");
    expect(locker).toContain('FOR UPDATE');
    expect(locker).toContain('PHARMACY_FACILITY_GRANT_RECOVERY_INVALID');
    expect(locker).toContain('PHARMACY_FACILITY_GRANT_RECOVERY_NOT_OPEN');

    const grant = facilityAuthority.slice(
      facilityAuthority.indexOf('export async function grantPharmacyFacilityAuthority'),
      facilityAuthority.indexOf('export async function revokePharmacyFacilityAuthority'),
    );
    expect(grant.indexOf('lockGrantRecoveryTx')).toBeGreaterThan(0);
    expect(grant.indexOf('lockGrantRecoveryTx')).toBeLessThan(
      grant.indexOf('FROM pharmacy_staff_facility_grants'),
    );
    expect(grant.indexOf('lockGrantRecoveryTx')).toBeLessThan(
      grant.indexOf('INSERT INTO pharmacy_staff_facility_grants'),
    );
  });

  it('atomically requires exact one-row recovery closure and preserves retry closure', () => {
    const grant = facilityAuthority.slice(
      facilityAuthority.indexOf('export async function grantPharmacyFacilityAuthority'),
      facilityAuthority.indexOf('export async function revokePharmacyFacilityAuthority'),
    );
    expect(grant).toContain('if (active.length && !recovery)');
    expect(grant).toContain("'CLOSE_WITH_EXISTING_EXACT_FACILITY_GRANT'");
    expect(grant).toContain('WHERE tenant_id=$1::uuid AND id=$2::bigint');
    expect(grant).toContain("reason_code='STAFF_FACILITY_GRANT_REQUIRED' AND status='OPEN'");
    expect(grant).toContain('RETURNING id, entity_type, entity_id, reason_code, status, resolved_by');
    expect(grant).toContain('if (resolved.length !== 1)');
    expect(grant).toContain('PHARMACY_FACILITY_GRANT_RECOVERY_STATE_CHANGED');
  });

  it('replays the immutable event snapshot without consulting the live grant row', () => {
    const replay = facilityAuthority.slice(
      facilityAuthority.indexOf('async function replayGrantCommandTx'),
      facilityAuthority.indexOf('function grantReceiptSnapshot'),
    );
    expect(replay).toContain('SELECT event.request_sha256, event.target_after');
    expect(replay).toContain('FROM pharmacy_inventory_authority_recovery_events event');
    expect(replay).toContain("event.target_identity->>'entity_type'='staff_facility_grant'");
    expect(replay).toContain("event.evidence->'target_after' AS target_after");
    expect(replay).not.toContain('JOIN pharmacy_staff_facility_grants');
    expect(replay).toContain('PHARMACY_FACILITY_GRANT_RECEIPT_INCOMPLETE');
    expect(replay).toContain('return targetAfter');
  });

  it('authorizes the current admin before tenant-wide command serialization and replay', () => {
    const currentAdminAuthority = facilityAuthority.slice(
      facilityAuthority.indexOf('async function loadGrantAdminTx'),
      facilityAuthority.indexOf('async function lockGrantCommandTx'),
    );
    expect(currentAdminAuthority).toContain('FROM users');
    expect(currentAdminAuthority).toContain('tenant_id=$1::uuid AND uid=$2::uuid');
    expect(currentAdminAuthority).toContain("is_active=TRUE AND status='active'");
    expect(currentAdminAuthority).toContain('is_deleted=FALSE AND merged_into_uid IS NULL');
    expect(currentAdminAuthority).toContain('FACILITY_GRANT_ADMIN_ROLES.has(canonicalRole)');
    expect(currentAdminAuthority).toContain(
      "canonicalRole !== String(actorRole || '').trim().toUpperCase()",
    );
    expect(currentAdminAuthority).toContain('{ forUpdate: true }');

    const commandLock = facilityAuthority.slice(
      facilityAuthority.indexOf('async function lockGrantCommandTx'),
      facilityAuthority.indexOf('function commandEvidence'),
    );
    expect(commandLock).toContain(
      'pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    );
    expect(commandLock).toContain(
      'pharmacy-facility-grant-command-v1:${tenantId}:${command.commandKeySha256}',
    );
    expect(commandLock).not.toContain('actorUid');

    const grant = facilityAuthority.slice(
      facilityAuthority.indexOf('export async function grantPharmacyFacilityAuthority'),
      facilityAuthority.indexOf('export async function revokePharmacyFacilityAuthority'),
    );
    const revoke = facilityAuthority.slice(
      facilityAuthority.indexOf('export async function revokePharmacyFacilityAuthority'),
    );

    for (const command of [grant, revoke]) {
      const currentAuthorization = command.indexOf('await authorizeGrantAdminTx');
      const tenantCommandLock = command.indexOf('await lockGrantCommandTx');
      const adminLock = command.indexOf('const admin = await lockGrantAdminTx');
      const replay = command.indexOf('const replay = await replayGrantCommandTx');
      expect(currentAuthorization).toBeGreaterThanOrEqual(0);
      expect(tenantCommandLock).toBeGreaterThan(currentAuthorization);
      expect(adminLock).toBeGreaterThan(tenantCommandLock);
      expect(replay).toBeGreaterThan(adminLock);
      expect(command.match(/replayGrantCommandTx/g)).toHaveLength(1);
      expect(command).toContain('if (replay) return replay');
      expect(command).toContain('target_after: targetAfter');
      expect(command).toContain('return targetAfter');
    }
  });

  it('builds grant recovery target_after from timestamp-bearing database rows', () => {
    const grant = facilityAuthority.slice(
      facilityAuthority.indexOf('export async function grantPharmacyFacilityAuthority'),
      facilityAuthority.indexOf('export async function revokePharmacyFacilityAuthority'),
    );
    expect(grant).toMatch(/RETURNING id, facility_id, staff_uid,[\s\S]*created_at, updated_at/);
    expect(grant.match(/AS receipt_snapshot/g)).toHaveLength(2);
    expect(grant).toContain('targetAfter = grantReceiptSnapshot(inserted[0])');
    expect(grant).toContain('delete grant.receipt_snapshot');

    const snapshot = facilityAuthority.slice(
      facilityAuthority.indexOf('function grantReceiptSnapshot'),
      facilityAuthority.indexOf('function recoveryReceiptSnapshot'),
    );
    expect(snapshot).toContain('if (grant.receipt_snapshot) return grant.receipt_snapshot');
    expect(snapshot).toContain('id: String(grant.id ?? grant.grant_id)');
    expect(snapshot).not.toContain('grant_id:');
    expect(snapshot).toContain('created_at: grant.created_at || null');
    expect(snapshot).toContain('updated_at: grant.updated_at || null');

    expect(facilityAuthority).toContain(
      'RETURNING to_jsonb(pharmacy_inventory_authority_recovery_worklist) AS target_after',
    );
    expect(facilityAuthority).toContain('reopened[0]?.target_after?.updated_at');
    expect(catalogController).toContain('RETURNING to_jsonb(${tableName}) AS target_after');
    expect(catalogController).toContain('reopened[0].target_after?.updated_at');
  });
});
