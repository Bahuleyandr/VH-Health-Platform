# W3 Per-Tenant Secrets & Shared State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make everything that varies by hospital identity per-tenant (inbound HMAC secrets, API keys, field-encryption KEK) and all shared process/replica state tenant- and replica-safe (rate limiting, caches, crons), while the existing single (default) tenant stays byte-identical.

**Architecture:** Seven independently-committable workstreams. The default tenant is seeded from today's global env values, so per-tenant resolution never breaks single-tenant operation. Reuses infra that already exists: `encryption_keys` (already per-tenant) + `encryptionKeyRegistryService`, the `src/lib/redis.js` ioredis client, `api_keys` + `apiClientService`, the `teleconsult_provider_configs` encrypted-config pattern, and the `runRevenueCycleSweepAllTenants` cron fan-out template.

**Tech Stack:** Node 22 + Express 5 + PostgreSQL 17 (raw-SQL migrations, Prisma client), Jest, ioredis, express-rate-limit v8, AES-256-GCM envelope encryption.

**Spec:** `docs/superpowers/specs/2026-06-19-w3-per-tenant-secrets-shared-state-design.md`

---

## Conventions (apply to every task)

- **NO-OP invariant:** every change is behaviour-identical for the default tenant `00000000-0000-4000-8000-000000000001`. The flag-on / single-tenant gate is the regression check.
- **Migrations:** bare DDL `apps/backend/src/migrations/NNN_*.sql`, single `BEGIN/COMMIT`, idempotent `DO`-block guards. Tip is **336** → W3 uses **337** (KEK column) and **338** (interop secrets). After a migration: `npx prisma db pull --url "postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test"` then `node scripts/check-schema-drift.mjs`.
- **Per-workstream gate:** run that workstream's deep test(s) connected as postgres: `DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" PGPASSWORD=postgres node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`. Commit only when green.
- **Final gate:** `DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" PGPASSWORD=postgres node scripts/run-ci-jest.mjs` on a rebuilt DB → "All chunks passed".
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit. All new tests are `*.deep.test.js` (integration) or `unit/*.test.js` (pure).
- Paths below are relative to `apps/backend/` unless absolute.

---

## WS1 — `tenants.settings` typed accessor

**Goal:** one typed read path for per-tenant config, reused by WS2 (quotas) and WS7/branding. No migration — `tenants.settings` jsonb already exists with a 60s cache in `tenantService`.

**Files:**
- Create: `src/services/tenant/tenantSettingsService.js`
- Create: `src/tests/unit/tenantSettingsService.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/tests/unit/tenantSettingsService.test.js
import { jest } from '@jest/globals';

const getTenantById = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById,
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
}));
const { getTenantSettings, getRateLimitOverride } = await import('../../services/tenant/tenantSettingsService.js');

describe('tenantSettingsService', () => {
  beforeEach(() => getTenantById.mockReset());

  it('returns the parsed settings object', async () => {
    getTenantById.mockResolvedValue({ settings: { rateLimits: { patient: { max: 250 } }, branding: { name: 'A' } } });
    expect(await getTenantSettings('t1')).toEqual({ rateLimits: { patient: { max: 250 } }, branding: { name: 'A' } });
  });

  it('returns {} when tenant missing or settings null', async () => {
    getTenantById.mockResolvedValue(null);
    expect(await getTenantSettings('t1')).toEqual({});
    getTenantById.mockResolvedValue({ settings: null });
    expect(await getTenantSettings('t1')).toEqual({});
  });

  it('getRateLimitOverride returns the profile override or null', async () => {
    getTenantById.mockResolvedValue({ settings: { rateLimits: { patient: { windowMs: 60000, max: 250 } } } });
    expect(await getRateLimitOverride('t1', 'patient')).toEqual({ windowMs: 60000, max: 250 });
    expect(await getRateLimitOverride('t1', 'staff')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `... jest tenantSettingsService --forceExit` → FAIL (module not found).

- [ ] **Step 3: Implement**

```javascript
// src/services/tenant/tenantSettingsService.js
import { getTenantById } from './tenantService.js';

// tenants.settings jsonb shape (all keys optional):
//   { rateLimits?: { <profile>: { windowMs?: number, max?: number } },
//     branding?: { name?, logoUrl?, primaryColor?, supportEmail? },
//     cache?: { enabledRoutes?: string[] } }
export async function getTenantSettings(tenantId) {
  const tenant = await getTenantById(tenantId).catch(() => null);
  const s = tenant?.settings;
  return s && typeof s === 'object' ? s : {};
}

export async function getRateLimitOverride(tenantId, profile) {
  const s = await getTenantSettings(tenantId);
  const o = s.rateLimits?.[profile];
  return o && typeof o === 'object' ? o : null;
}

export async function getBranding(tenantId) {
  return (await getTenantSettings(tenantId)).branding ?? {};
}
```

- [ ] **Step 4: Run test, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(multi-tenancy): W3 WS1 — tenants.settings typed accessor"`

---

## WS2 — Redis-backed rate limiting + per-tenant quotas

**Goal:** replica-safe rate limiting (shared Redis counter) with a tenant key-prefix and per-tenant quota overrides; graceful MemoryStore fallback when `REDIS_URL` is unset (preserves current behaviour + local tests).

**Files:**
- Modify: `package.json` (add `rate-limit-redis`)
- Modify: `src/middleware/rateLimitMiddleware.js` (store + tenant key-prefix + quota override)
- Create: `src/tests/unit/rateLimitTenant.test.js`
- Reference: `src/lib/redis.js` (the ioredis client + `getRedis()`), `src/config/rateLimitProfiles.js`

- [ ] **Step 1: Install the store** — `npm install rate-limit-redis@^4` (in `apps/backend`). Verify `node -e "require.resolve('rate-limit-redis')"` resolves. Commit the lockfile change with WS2's final commit.

- [ ] **Step 2: Write the failing test** (pure — exercises the key generator + store selection without a live Redis)

```javascript
// src/tests/unit/rateLimitTenant.test.js
import { jest } from '@jest/globals';
import { tenantKeyGenerator, selectStore } from '../../middleware/rateLimitMiddleware.js';

describe('rate limit tenant keying', () => {
  it('prefixes the key with the resolved tenant', () => {
    const req = { tenantId: 'tA', user: { uid: 'u1' }, ip: '1.2.3.4' };
    expect(tenantKeyGenerator(req)).toBe('t:tA:u:u1');
  });
  it('falls back to ip when no uid, still tenant-prefixed', () => {
    expect(tenantKeyGenerator({ tenantId: 'tB', ip: '9.9.9.9' })).toBe('t:tB:ip:9.9.9.9');
  });
  it('uses default tenant label when tenantId absent', () => {
    expect(tenantKeyGenerator({ user: { uid: 'u1' }, ip: '1.2.3.4' })).toBe('t:default:u:u1');
  });
  it('selectStore returns undefined (MemoryStore) when REDIS_URL unset', () => {
    const prev = process.env.REDIS_URL; delete process.env.REDIS_URL;
    expect(selectStore()).toBeUndefined();
    if (prev) process.env.REDIS_URL = prev;
  });
});
```

- [ ] **Step 3: Run test, verify it fails** (exports don't exist yet).

- [ ] **Step 4: Implement** in `src/middleware/rateLimitMiddleware.js`:
  - Export `tenantKeyGenerator(req)`: `const t = req.tenantId || 'default'; const who = req.user?.uid ? \`u:${req.user.uid}\` : \`ip:${req.ip}\`; return \`t:${t}:${who}\`;` (preserve the existing richer key precedence — account+IP, JWT hash, api key — but always prefix `t:${t}:`).
  - Export `selectStore()`: returns `undefined` when `!process.env.REDIS_URL`; otherwise `new RedisStore({ sendCommand: (...args) => getRedis().call(...args), prefix: 'rl:' })` (import `RedisStore` from `rate-limit-redis`, `getRedis` from `../lib/redis.js`).
  - In `getRateLimiter(profileKey, opts)`: set `store: selectStore()`, `keyGenerator: tenantKeyGenerator`, and resolve per-request limits — wrap the limiter so `max`/`windowMs` come from `getRateLimitOverride(req.tenantId, profileKey)` when present, else the profile default. (express-rate-limit v8 supports a function for `max`; read the override there. Keep it synchronous-safe by reading a per-tenant override cached via the WS1 60s cache.)

- [ ] **Step 5: Run test, verify PASS.**
- [ ] **Step 6: Manual Redis smoke (optional, only if a local Redis is available):** set `REDIS_URL`, hit a limited route N+1 times, expect a 429 and an `rl:` key in Redis. If no Redis locally, note it — the MemoryStore path + keying logic is covered by the unit test.
- [ ] **Step 7: Commit** — `git commit -m "feat(multi-tenancy): W3 WS2 — Redis rate-limit store + per-tenant key/quota (MemoryStore fallback)"`

---

## WS3 — Tenant-keyed cache (make safe, do NOT mount)

**Goal:** close the tenant-bleed gap in the dormant `cacheMiddleware` before it's ever mounted; add tenant-scoped invalidation. Leave it unmounted (decision C).

**Files:**
- Modify: `src/middleware/cacheMiddleware.js` (cache key includes tenant; add `clearTenantCache`)
- Create: `src/tests/unit/cacheMiddlewareTenant.test.js`
- Reference: `src/lib/redis.js` (`cacheGet/cacheSet/cacheClear`)

- [ ] **Step 1: Write the failing test**

```javascript
// src/tests/unit/cacheMiddlewareTenant.test.js
import { buildCacheKey } from '../../middleware/cacheMiddleware.js';

describe('cache key tenant isolation', () => {
  it('two tenants on the same path+query get different keys', () => {
    const a = buildCacheKey('appts', { tenantId: 'tA', method: 'GET', path: '/x', query: { p: 1 } });
    const b = buildCacheKey('appts', { tenantId: 'tB', method: 'GET', path: '/x', query: { p: 1 } });
    expect(a).not.toBe(b);
    expect(a).toContain('tA'); expect(b).toContain('tB');
  });
  it('omitted tenant uses the default label (never a tenant-blind key)', () => {
    expect(buildCacheKey('appts', { method: 'GET', path: '/x', query: {} })).toContain(':default:');
  });
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — extract `buildCacheKey(keyPrefix, { tenantId, method, path, query })` returning `${keyPrefix}:${tenantId||'default'}:${method}:${path}:${JSON.stringify(query)}`; use it in `cacheResponse`. Add `export async function clearTenantCache(keyPrefix, tenantId){ return cacheClear(\`${keyPrefix}:${tenantId}:*\`); }`. Do NOT mount the middleware anywhere.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(multi-tenancy): W3 WS3 — tenant-key the dormant cache middleware + invalidation (unmounted)"`

---

## WS4 — Wire `api_keys` into `validateApiKey`

**Goal:** `validateApiKey` authenticates DB-backed per-tenant keys first, falling back to the env-var registry (default-tenant keys keep working).

**Files:**
- Modify: `src/middleware/validateApiKey.js`
- Create: `src/tests/api-key-tenant.deep.test.js`
- Reference: `src/services/auth/apiClientService.js` (`issueApiKey`, `authenticateByApiKey`, `revokeApiKey`)

- [ ] **Step 1: Write the failing deep test** — seed an api_client + issue a key for tenant A via `apiClientService`, then assert the middleware accepts it and sets `req.tenantId`, rejects a revoked key, and still accepts the env `API_KEY` fallback.

```javascript
// src/tests/api-key-tenant.deep.test.js (shape)
import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';
import { upsertApiClient, issueApiKey, revokeApiKey } from '../services/auth/apiClientService.js';
import validateApiKey from '../middleware/validateApiKey.js';

const TENANT_A = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a301';
function runMw(headers) {
  return new Promise((resolve) => {
    const req = { headers, get: (h) => headers[h.toLowerCase()] };
    const res = { status: (c) => ({ json: (b) => resolve({ code: c, body: b }) }) };
    validateApiKey(req, res, () => resolve({ code: 200, req }));
  });
}
// beforeAll: ensure tenant A row; upsertApiClient({tenantId:TENANT_A,...}); const { plaintext } = await issueApiKey({tenantId:TENANT_A,...})
it('accepts a DB key and stamps tenantId', async () => {
  const { code, req } = await runMw({ 'x-api-key': plaintext });
  expect(code).toBe(200); expect(req.tenantId).toBe(TENANT_A);
});
it('rejects a revoked key', async () => { await revokeApiKey(...); expect((await runMw({ 'x-api-key': plaintext })).code).toBe(401); });
it('falls back to the env API_KEY', async () => {
  process.env.API_KEY = 'env-shared'; expect((await runMw({ 'x-api-key': 'env-shared' })).code).toBe(200);
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — in `validateApiKey`, before the env-registry compare: `try { const c = await apiClientService.authenticateByApiKey(presentedKey, { ip: req.ip }); if (c) { req.apiClient = c.client_code; req.tenantId = c.tenant_id; return next(); } } catch (e) { if (!apiClientService.isMissingSchemaError(e)) throw; }` then fall through to the existing env-var compare. Honour `status`/`expires_at` inside `authenticateByApiKey` (already does). Keep the timing-safe env compare unchanged.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(multi-tenancy): W3 WS4 — wire api_keys into validateApiKey (env fallback)"`

---

## WS5 — Per-tenant field-encryption KEK + re-wrap existing PHI

**Goal:** `master KEK → per-tenant KEK → DEK → data`; existing global-`kid` ciphertext grandfathered and re-wrapped by an idempotent job; crypto-shred = drop the tenant's wrapped KEK.

**Files:**
- Create: `src/migrations/337_encryption_keys_wrapped_material.sql`
- Create: `src/services/security/tenantKekProvider.js` (loads + unwraps per-tenant KEK from `encryption_keys` under the master KEK; caches)
- Modify: `src/utils/fieldKeyProvider.js` (tenant-aware `getKek(keyId,{tenantId})`)
- Modify: `src/services/security/kmsProviderService.js` (same tenant-aware path)
- Modify: `src/utils/fieldEncryption.js` (thread `tenantId` through `encryptField`/`decryptField`/`rewrapField`)
- Create: `scripts/phi-rewrap-tenant-keks.mjs` (idempotent re-wrap, modeled on `scripts/phi-backfill.mjs`)
- Modify: `.env.example` (`FIELD_ENCRYPTION_MASTER_KEK`)
- Create: `src/tests/unit/tenantKekProvider.test.js`, `src/tests/phi-rewrap.deep.test.js`
- Reference: `src/services/security/encryptionKeyRegistryService.js`, `src/migrations/129_phi_encryption_keys.sql`, `scripts/phi-backfill.mjs`

- [ ] **Step 1: Migration 337** — add the wrapped-key columns and provision the default tenant's KEK row.

```sql
-- 337_encryption_keys_wrapped_material.sql
BEGIN;
DO $$
BEGIN
  ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS wrapped_key_material text;  -- per-tenant KEK, AES-GCM-wrapped under master KEK, base64url(JSON {edek,wiv,wtag})
END $$;
COMMIT;
```
Apply + `prisma db pull` (qa_writer DSN) + `check-schema-drift`. (Default-tenant KEK row is provisioned by the script in Step 4, not the migration, so the master KEK env is the only secret input.)

- [ ] **Step 2: Write the failing unit test for the provider**

```javascript
// src/tests/unit/tenantKekProvider.test.js
import { jest } from '@jest/globals';
import crypto from 'crypto';
process.env.FIELD_ENCRYPTION_MASTER_KEK = crypto.randomBytes(32).toString('base64');
const rows = new Map();
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: {
  $queryRawUnsafe: async (_sql, tenantId) => rows.has(tenantId) ? [rows.get(tenantId)] : [],
  $executeRawUnsafe: async () => 1,
}}));
const { provisionTenantKek, getTenantKek, cryptoShredTenant } = await import('../../services/security/tenantKekProvider.js');

it('provision then load round-trips the same 32-byte KEK', async () => {
  const row = await provisionTenantKek('tA');   // returns the stored encryption_keys row
  rows.set('tA', row);
  const kek = await getTenantKek('tA');
  expect(kek).toHaveLength(32);
  expect(kek.equals(await getTenantKek('tA'))).toBe(true); // stable
});
it('two tenants get different KEKs', async () => {
  rows.set('tA', await provisionTenantKek('tA')); rows.set('tB', await provisionTenantKek('tB'));
  expect((await getTenantKek('tA')).equals(await getTenantKek('tB'))).toBe(false);
});
it('crypto-shred drops the wrapped row so the KEK can no longer load', async () => {
  rows.set('tA', await provisionTenantKek('tA'));
  await cryptoShredTenant('tA'); rows.delete('tA');
  await expect(getTenantKek('tA')).rejects.toThrow();
});
```

- [ ] **Step 3: Run, verify fail.**
- [ ] **Step 4: Implement `tenantKekProvider.js`** — `masterKek()` reads `FIELD_ENCRYPTION_MASTER_KEK` (base64, 32 bytes). `provisionTenantKek(tenantId)`: `const kek = crypto.randomBytes(32); const wrapped = wrapUnderMaster(kek);` insert/return an `encryption_keys` row (`tenant_id`, `key_id='t:'+tenantId+':v1'`, `provider='local-tenant'`, `status='active'`, `wrapped_key_material=wrapped`). `getTenantKek(tenantId)`: load active row, `unwrapUnderMaster(row.wrapped_key_material)`, cache by tenant. `cryptoShredTenant(tenantId)`: `UPDATE encryption_keys SET status='compromised', wrapped_key_material=NULL WHERE tenant_id=$1`. `wrapUnderMaster`/`unwrapUnderMaster` = AES-256-GCM with the master KEK (mirror `fieldKeyProvider.wrapDek`).

- [ ] **Step 5: Run unit test, verify PASS. Commit** — `git commit -m "feat(multi-tenancy): W3 WS5a — tenant KEK provider (encryption_keys wrapped material) + mig 337"`

- [ ] **Step 6: Thread tenant through encryption** — `fieldEncryption.encryptField(plaintext, { tenantId })`: when `tenantId` is set, wrap the DEK under `getTenantKek(tenantId)` and stamp `kid = 't:'+tenantId+':v1'`; else legacy global KEK + `kid='local-v1'`. `decryptField(value, { tenantId })`: if the envelope `kid` starts with `t:`, unwrap with `getTenantKek(<tenant from kid>)`; else legacy global KEK (grandfather). Same change mirrored in `kmsProviderService`. Update each call site to pass the owning row's `tenant_id` (webhook secrets, OAuth secrets, HL7 outbound, telemedicine configs, mig-132 PHI columns).

- [ ] **Step 7: Write the failing re-wrap deep test** (`phi-rewrap.deep.test.js`): provision KEKs for tenant A+B; write a PHI value for A under the legacy global kid; run the re-wrap function for A; assert the stored value now has a `t:A:` kid, decrypts to the original, the job is idempotent (second run re-wraps 0 rows), and after `cryptoShredTenant('A')` the value no longer decrypts while B's is unaffected.

- [ ] **Step 8: Implement `scripts/phi-rewrap-tenant-keks.mjs`** — for each (table, encrypted column) in a manifest, in `id` batches: `SELECT id, tenant_id, <col>`; for rows whose decoded `kid` is NOT `t:<tenant_id>:*`, `decryptField(val,{legacy})` → `encryptField(plain,{tenantId})` → `UPDATE ... SET <col>=$1 WHERE id=$2`. Flags: `--tenant <id>`, `--dry-run`, `--table <name>`. Resumable (kid check makes it idempotent). A guard counts remaining legacy-kid rows; never drop the legacy global KEK while > 0.

- [ ] **Step 9: Run the re-wrap deep test, verify PASS. Run the default tenant re-wrap** (`node scripts/phi-rewrap-tenant-keks.mjs --tenant 00000000-0000-4000-8000-000000000001`). **Commit** — `git commit -m "feat(multi-tenancy): W3 WS5b — thread tenant through encryption + idempotent re-wrap job + crypto-shred"`

---

## WS6 — Per-tenant ABDM/HL7 inbound secrets (reject unresolved)

**Goal:** resolve tenant from the sender identifier BEFORE HMAC, verify with that tenant's secret, reject if unresolved. Default tenant seeded from today's env secrets.

**Files:**
- Create: `src/migrations/338_tenant_interop_secrets.sql` (table + RLS + seed default tenant)
- Create: `src/services/interop/tenantInteropSecretService.js` (`resolveTenantBySender`, `getInteropSecret`)
- Modify: `src/routes/abdm/abdmRoutes.js` (resolve tenant → per-tenant secret in `validateABDMRequest`)
- Modify: `src/routes/hl7/hl7Routes.js` (resolve tenant → per-tenant secret in `assertHl7InboundAuthentic`)
- Create: `src/tests/interop-secret-tenant.deep.test.js`
- Reference: `prisma/schema.prisma` `teleconsult_provider_configs`, `src/utils/signedRequest.js`, `src/utils/fieldEncryption.js`

- [ ] **Step 1: Migration 338** — table + RLS + seed.

```sql
-- 338_tenant_interop_secrets.sql
BEGIN;
CREATE TABLE IF NOT EXISTS tenant_interop_secrets (
  id               serial PRIMARY KEY,
  tenant_id        uuid NOT NULL DEFAULT
    COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
             '00000000-0000-4000-8000-000000000001'::uuid),
  kind             varchar(40) NOT NULL,            -- 'abdm_callback' | 'hl7_inbound'
  sender_identifier varchar(255) NOT NULL,          -- ABDM HIP/CM id | HL7 MSH facility
  secret_ciphertext text NOT NULL,                  -- via encryptField (default-tenant kid at seed time)
  status           varchar(20) NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_tenant_interop_secrets_tenant') THEN
    ALTER TABLE tenant_interop_secrets ADD CONSTRAINT fk_tenant_interop_secrets_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_interop_secrets_kind_sender
  ON tenant_interop_secrets (kind, sender_identifier);
CREATE INDEX IF NOT EXISTS idx_tenant_interop_secrets_tenant ON tenant_interop_secrets (tenant_id);
ALTER TABLE tenant_interop_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_interop_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_interop_secrets;
CREATE POLICY tenant_isolation ON tenant_interop_secrets
  USING (current_setting('app.current_tenant_id', true) IS NULL
      OR current_setting('app.current_tenant_id', true) = ''
      OR current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid())
  WITH CHECK (current_setting('app.current_tenant_id', true) IS NULL
      OR current_setting('app.current_tenant_id', true) = ''
      OR current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid());
COMMIT;
```
> Seeding the default-tenant rows from `ABDM_CALLBACK_SECRET`/`HL7_INBOUND_SHARED_SECRET` requires `encryptField` (JS), so it runs in a one-shot seed script `scripts/seed-default-interop-secrets.mjs` (idempotent ON CONFLICT (kind, sender_identifier) DO NOTHING), not the SQL migration. The sender_identifier for the default tenant = the current ABDM HIP id / HL7 facility from env/config. Apply migration → `prisma db pull` → `check-schema-drift`. **Update `check-phi-tenant-id` expectations** (new tenant_id table; policy present via the ARRAY idiom).

- [ ] **Step 2: Write the failing deep test** (`interop-secret-tenant.deep.test.js`): seed interop secrets for tenant A (sender `HIP-A`, secret `secretA`) and B (`HIP-B`, `secretB`); assert `resolveTenantBySender('abdm_callback','HIP-A')===TENANT_A`; a request signed with `secretA` and sender `HIP-A` verifies; the SAME body signed with `secretA` but sender `HIP-B` (tenant B) FAILS; an unknown sender `HIP-Z` resolves to null and the route rejects (401).

- [ ] **Step 3: Run, verify fail.**
- [ ] **Step 4: Implement `tenantInteropSecretService.js`** — `resolveTenantBySender(kind, senderId)`: `SELECT tenant_id FROM tenant_interop_secrets WHERE kind=$1 AND sender_identifier=$2 AND status='active'` (run under super-admin/bypass since tenant isn't known yet), return `tenant_id` or `null`. `getInteropSecret(tenantId, kind)`: read the row under `setTenant(tenantId)`, `decryptField(secret_ciphertext, { tenantId })`.

- [ ] **Step 5: Wire the routes** — in `validateABDMRequest` (abdm) and `assertHl7InboundAuthentic` (hl7): extract the sender identifier (ABDM HIP/CM id header or payload field; HL7 MSH-4/MSH-6); `const tid = await resolveTenantBySender(kind, senderId); if (!tid) return reject(401);` `const secret = await getInteropSecret(tid, kind); verifySignedRequest(req, secret);` then stash `req.tenantId = tid` for the downstream `setTenant`. Remove the env-var secret read from the hot path (env now only feeds the seed script).

- [ ] **Step 6: Run deep test, verify PASS. Run the default-tenant seed script. Commit** — `git commit -m "feat(multi-tenancy): W3 WS6 — per-tenant ABDM/HL7 inbound secrets + resolve-before-HMAC (mig 338)"`

---

## WS7 — Cron fan-out

**Goal:** the ~10 default-tenant-only crons run per tenant via the existing discovery-loop template; one tenant's failure never aborts the others.

**Files:**
- Modify: `src/utils/scheduler.js` (wrap the 10 crons)
- Create: `src/tests/cron-fanout.deep.test.js`
- Reference: `src/utils/scheduler.js` `runRevenueCycleSweepAllTenants` (lines ~248-279) — the exact template.

- [ ] **Step 1: Write the failing deep test** — seed tenants A+B each with one due item (e.g. a pending scheduled notification); call the fanned-out function; assert it processed an item for BOTH tenants and that injecting a throw for tenant A still processes tenant B (error isolation) and reports `errors:1`.

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — for each of the 10 crons, introduce `run<Job>AllTenants()` that mirrors `runRevenueCycleSweepAllTenants`: `const tenants = await prisma.$queryRawUnsafe('SELECT id FROM tenants'); for (const t of tenants) { try { await setTenant(t.id, () => run<Job>ForTenant(t.id)); ok++ } catch(e){ errs++; logger.error(...) } } return { tenantsSwept: tenants.length, errors: errs };` and point the cron registration at the `AllTenants` variant. Keep `withJobLock`. The 10: `send-appointment-reminders`, `timed-reminders`, `process-scheduled-notifications`, `drug-chart-missing-sla`, `investigation-notifications`, `unread-critical-notification-escalation`, `escalate-stuck-orders`, `operational-alert-sweep`, `reap-stale-visits`, `roster-deadline-escalation`.

- [ ] **Step 4: Run deep test, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(multi-tenancy): W3 WS7 — fan out the default-tenant crons per tenant"`

---

## Final gate & closeout

- [ ] **Rebuild the QA DB** (the from-scratch recipe — extensions first): drop+create template0 → create the 6 extensions (vector, btree_gist, pgcrypto, pg_trgm, citext, "uuid-ossp") → `ci-setup-db.mjs` → `qa-cluster-up.mjs`. Run the two new seed scripts (interop secrets, default KEK) + the default-tenant re-wrap.
- [ ] **Full gate:** `DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" PGPASSWORD=postgres node scripts/run-ci-jest.mjs` → "All chunks passed".
- [ ] **Guards:** `check-schema-drift` clean; `check:phi-tenant-id` (incl. `tenant_interop_secrets`) allowlist empty; `check:no-default-tenant-fallback` clean.
- [ ] **Closeout:** update the W3 spec Status line + the program-design Wave 3 status + the program memory (W3 DONE, on to W4). Branch stays on `feat/multi-tenancy-program` (HOLD); no ff main.

---

## Self-review notes (author)

- **Spec coverage:** WS1↔settings accessor; WS2↔Redis rate-limit+quota; WS3↔tenant-key cache (unmounted, decision C); WS4↔api_keys wiring; WS5↔per-tenant KEK + idempotent re-wrap (decision A) + crypto-shred; WS6↔interop secrets + reject-unresolved (decision B) + default seed; WS7↔cron fan-out. All seven spec workstreams covered.
- **NO-OP invariant** preserved everywhere via default-tenant seeding (interop secrets, KEK provision+re-wrap) and env/profile fallback (api_keys, rate-limit, cache-unmounted).
- **Migration numbers** unique + ordered: 337 (KEK column), 338 (interop secrets).
- **Naming consistency:** `tenantKekProvider` exports `provisionTenantKek`/`getTenantKek`/`cryptoShredTenant`; `tenantInteropSecretService` exports `resolveTenantBySender`/`getInteropSecret`; `tenantSettingsService` exports `getTenantSettings`/`getRateLimitOverride`/`getBranding`; rate-limit exports `tenantKeyGenerator`/`selectStore`; cache exports `buildCacheKey`/`clearTenantCache` — each referenced consistently by its consumer.
