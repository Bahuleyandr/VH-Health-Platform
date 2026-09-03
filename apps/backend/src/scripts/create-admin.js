// This legacy bootstrap bypassed the migrated admins schema, governed admin
// provisioning, MFA enrollment, and durable session revocation. Keep the path
// as a fail-closed tombstone so old operator notes cannot silently recreate or
// reset a live SUPER_ADMIN account.
console.error(
  'create-admin.js is retired. An existing SUPER_ADMIN with verified MFA must use '
    + 'POST /api/v1/auth/admin/create-admin through the governed admin management workflow.',
);
process.exitCode = 1;
