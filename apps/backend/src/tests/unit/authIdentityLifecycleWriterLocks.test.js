import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(src, relativePath), 'utf8');

function scope(relativePath, start, end) {
  const source = read(relativePath);
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function expectOrdered(source, anchors) {
  let previous = -1;
  for (const anchor of anchors) {
    const current = source.indexOf(anchor, previous + 1);
    expect(current).toBeGreaterThan(previous);
    previous = current;
  }
}

describe('auth identity lifecycle writer locks', () => {
  it('serializes local admin deactivation and reactivation before identity mutation', () => {
    expectOrdered(scope(
      'services/auth/authService.js',
      'static async deactivateAdmin',
      'static async reactivateAdmin',
    ), [
      'withAuthIdentityLifecycleLocks(tx, [String(adminId)]',
      'tx.admins.updateMany',
      'persistRevokeAllUserTokens',
    ]);
    expectOrdered(scope(
      'services/auth/authService.js',
      'static async reactivateAdmin',
      'static async updateAdminPermissions',
    ), [
      'withAuthIdentityLifecycleLocks(tx, [String(adminId)]',
      'tx.admins.updateMany',
    ]);
  });

  it('takes the revocation advisory lock before credential writers lock identity rows', () => {
    expectOrdered(scope(
      'services/auth/authService.js',
      'static async changeAdminPassword',
      'static async adminForgotPassword',
    ), [
      'persistRevokeAllUserTokens',
      'tx.admins.update',
    ]);
    expectOrdered(scope(
      'services/auth/authService.js',
      'static async adminResetPassword',
      '/* ========================= Staff Auth',
    ), [
      'persistRevokeAllUserTokens',
      'tx.admins.update',
    ]);
    expectOrdered(scope(
      'controllers/auth/adminAuthController.js',
      'export const mfaDisable',
      'POST /auth/admin/mfa/setup-enroll',
    ), [
      'persistRevokeAllUserTokens',
      'tx.admins.update',
    ]);
    expectOrdered(scope(
      'services/auth/staffAuthService.js',
      'static async changeOwnPassword',
      'static async registerStaffDevice',
    ), [
      'persistRevokeAllUserTokens',
      'UPDATE users',
    ]);
    expectOrdered(scope(
      'services/auth/staffAuthService.js',
      'static async adminResetPin',
      'static async _verifyDeviceOwnership',
    ), [
      'persistRevokeAllUserTokens',
      'SELECT uid FROM users WHERE id = $1 LIMIT 1 FOR UPDATE',
      'UPDATE staff_devices',
    ]);
  });

  it('creates patient profiles without a lock and serializes status changes and account deletion', () => {
    // Creation takes no lifecycle lock (see authIdentityCreationWriterLocks.test.js):
    // the new row is invisible to every other transaction until commit and its
    // uid is database-generated, so there is nothing for a lock to serialize.
    const creation = scope(
      'services/user/userService.js',
      'static async createOrUpdateProfile',
      'static async listUsers',
    );
    expect(creation).toContain('tx.users.create');
    expect(creation).not.toContain('withAuthIdentityLifecycleLocks');
    expectOrdered(scope(
      'services/user/userService.js',
      'static async changeUserStatus',
      'static async deactivateUser',
    ), [
      'withAuthIdentityLifecycleLocks(tx, [user.uid]',
      'UPDATE users',
      'persistIdentityRevocation',
    ]);
    expectOrdered(scope(
      'services/user/userService.js',
      'static async deleteOwnAccount',
      'static async getUsersByRole',
    ), [
      'withAuthIdentityLifecycleLocks(tx, [user.uid]',
      'UPDATE users',
      'persistIdentityRevocation',
    ]);
  });

  it('keeps every erasure identity mutation and durable revocation in one locked transaction', () => {
    const dataExport = scope('routes/dataExportRoutes.js', "router.delete('/my-data'", 'export default router');
    expectOrdered(dataExport, [
      'setTenantTx(tenantId',
      'withAuthIdentityLifecycleLocks(tx, [uid]',
      'UPDATE ${table}',
      'persistRevokeAllUserTokens',
    ]);
    expect(dataExport.indexOf('publishRevokeAllUserTokens')).toBeGreaterThan(
      dataExport.indexOf('return { results: deletionResults, revokedAt: durableRevokedAt }'),
    );

    expectOrdered(scope(
      'services/gdpr/dataErasureService.js',
      'export async function executeErasure',
      'export async function checkLegalHold',
    ), [
      'prisma.$transaction',
      'withAuthIdentityLifecycleLocks(tx, [uid]',
      'tx.users.updateMany',
      'persistRevokeAllUserTokens',
    ]);
  });

  it('serializes role and lock-state changes before mutating the identity', () => {
    expectOrdered(scope(
      'services/infrastructure/rbacService.js',
      'static async assignRole',
      'static async bulkAssignRoles',
    ), [
      'withAuthIdentityLifecycleLocks(tx, [user.uid]',
      'UPDATE users SET role',
      'persistRevokeAllUserTokens',
    ]);
    expectOrdered(scope(
      'services/infrastructure/rbacService.js',
      'static async toggleUserStatus',
      'static async getMyRoleInfo',
    ), [
      'withAuthIdentityLifecycleLocks(tx, [identity.uid]',
      'UPDATE users SET',
      'persistRevokeAllUserTokens',
    ]);
  });

  it('locks both merge identities before loading and mutating their patient rows', () => {
    const merge = scope(
      'services/patient/patientMergeService.js',
      'export async function executeMerge',
      'export async function listMergeRequests',
    );
    expectOrdered(merge, [
      'withAuthIdentityLifecycleLocks(tx, [primary, secondary]',
      'loadMergePatients',
      'UPDATE users',
      'persistRevokeAllUserTokens',
    ]);
  });

  it('locks guardian, dependent, and tuple before unlinking delegated authority', () => {
    expectOrdered(scope(
      'services/user/dependentsService.js',
      'static async unlinkDependent',
      null,
    ), [
      'withAuthIdentityLifecycleLocks(',
      'persistRevokeDelegatedTuple(',
      'UPDATE users AS dependent',
    ]);
  });

  it('locks existing SCIM identities on both staff and admin paths and never the ones it creates', () => {
    for (const [start, end, insert] of [
      ['async function upsertStaff', 'async function upsertAdmin', 'INSERT INTO users'],
      ['async function upsertAdmin', 'export async function upsertScimUser', 'INSERT INTO admins'],
    ]) {
      const writer = scope('services/auth/scimProvisioningService.js', start, end);
      const insertIndex = writer.indexOf(insert);
      expect(insertIndex).toBeGreaterThanOrEqual(0);
      // The creation branch returns the new row without locking it; the only
      // lock in each upsert is the `existing` branch below.
      const creationBranch = writer.slice(insertIndex, writer.indexOf('const source = sourceAfterScim', insertIndex));
      expect(creationBranch).not.toContain('withAuthIdentityLifecycleLocks');
      expect(writer).toMatch(
        /else\s*{\s*await withAuthIdentityLifecycleLocks\(tx, \[existing\.uid\][\s\S]*?UPDATE (?:users|admins)/,
      );
    }
  });

  it('makes the reusable SCIM deactivation helper acquire the identity lock itself', () => {
    const deactivation = scope(
      'services/auth/scimProvisioningService.js',
      'export async function deactivateScimIdentityTx',
      'export function publishScimRevocationAfterCommit',
    );
    expectOrdered(deactivation, [
      'withAuthIdentityLifecycleLocks(tx, [uid]',
      'DELETE FROM user_active_sessions',
      'persistRevokeAllUserTokens',
      'UPDATE users',
      'UPDATE admins',
    ]);
  });

  it('classifies the staff purge endpoint as non-identity retention cleanup', () => {
    const purge = scope(
      'controllers/staff/staffAdminOperationsController.js',
      'export const purgeOldRecords',
      '// Helper functions for exports',
    );
    expect(purge).toMatch(/DELETE FROM staff_attendance/);
    expect(purge).toMatch(/DELETE FROM staff_performance_reviews/);
    expect(purge).not.toMatch(/(?:UPDATE|DELETE FROM)\s+(?:users|admins)\b/i);
  });

  it('serializes admin-console user reactivation before the update and audit', () => {
    expectOrdered(scope(
      'services/user/adminUserService.js',
      'static async reactivateUser',
      'static async generateReport',
    ), [
      'prisma.$transaction',
      'withAuthIdentityLifecycleLocks(tx, [identity.uid]',
      'UPDATE users',
      'tx.audit_logs.create',
    ]);
  });
});
