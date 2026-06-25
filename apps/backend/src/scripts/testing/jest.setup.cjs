// jest.setup.cjs — CommonJS setup file, runs before ESM test modules
// Using .cjs so Jest can load it before --experimental-vm-modules is fully active
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
} catch (err) {
  void err;
  // .env.local is optional — fall through to .env
}

try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
} catch (err) {
  void err;
  // .env also optional in test environments
}

// Ensure test bootstrap satisfies runtime env validation even when CI injects
// minimal placeholder secrets.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (!process.env.API_KEY) process.env.API_KEY = 'test-api-key';
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:55432/vhhealth_test';
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars';
}

// validateEnv.js requires all three encryption keys (>=32 chars). Tests must
// supply deterministic dummy keys so `import './utils/validateEnv.js'` succeeds
// without a real .env file. These are test-only — prod/staging use real
// 32-byte base64 values delivered via SealedSecrets (see DEPLOYMENT_GUIDE.md#secrets).
if (!process.env.FIELD_ENCRYPTION_KEY || process.env.FIELD_ENCRYPTION_KEY.length < 32) {
  process.env.FIELD_ENCRYPTION_KEY = 'test-field-encryption-key-32chars!!';
}
// W3 WS5: master KEK that wraps per-tenant KEKs (envelope: master -> tenant KEK -> DEK).
if (!process.env.FIELD_ENCRYPTION_MASTER_KEK || process.env.FIELD_ENCRYPTION_MASTER_KEK.length < 32) {
  process.env.FIELD_ENCRYPTION_MASTER_KEK = 'test-field-encryption-master-kek-32c';
}
// W4: base host(s) the per-tenant subdomains sit under (Host-derived tenant).
if (!process.env.TENANT_BASE_HOST) {
  // Flat per-tenant host model: tenant API hosts are <slug>-api.<base>, so the
  // base host is the apex (vhhealth.app), NOT api.vhhealth.app.
  process.env.TENANT_BASE_HOST = 'localhost,vhhealth.app';
}
if (!process.env.TOTP_ENCRYPTION_KEY || process.env.TOTP_ENCRYPTION_KEY.length < 32) {
  process.env.TOTP_ENCRYPTION_KEY = 'test-totp-encryption-key-32chars!!!!';
}
if (!process.env.BACKUP_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY.length < 32) {
  process.env.BACKUP_ENCRYPTION_KEY = 'test-backup-encryption-key-32chars!!';
}

// Mandatory-MFA-for-SUPER_ADMIN defaults to 'true' in prod, but the legacy
// test fixtures seed SUPER_ADMIN accounts without TOTP and assert the
// normal login shape. Pin to 'false' unless a test explicitly overrides.
process.env.REQUIRE_MFA_FOR_SUPER_ADMIN ||= 'false';

// W1 (multi-tenancy): tenant resolution now fails closed by default. The legacy
// test fixtures rely on the single-tenant default-tenant floor, so allow it here
// unless a test (e.g. the fail-closed suite) overrides it.
process.env.ALLOW_DEFAULT_TENANT ||= 'true';

// BigInt JSON serialization. Prod sets this in bin/www.js, but tests import
// app.js directly (bin/www.js never runs), so any endpoint returning a BIGSERIAL
// column (e.g. cash_drawer_sessions.id) would throw "Do not know how to serialize
// a BigInt". Mirror the prod serializer so the test env matches prod behaviour.
if (typeof BigInt !== 'undefined' && !BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function bigIntToJSON() {
    const n = Number(this);
    return Number.isSafeInteger(n) ? n : this.toString();
  };
}

// Keep Jest output small enough to avoid CI heap blowups from repeated app bootstrap logs.
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.debug = () => {};
