# W3 — Per-tenant secrets & shared state (design)

- **Date:** 2026-06-19 · **Wave:** 3 of the [multi-tenancy program](2026-06-19-multi-tenancy-program-design.md).
- **Status:** Design — approved scope (full depth, including re-wrapping existing PHI now and per-tenant inbound HMAC with no global fallback). Ready for an implementation plan.
- **Branch:** `feat/multi-tenancy-program` (HOLD — not pushed). Builds on W1 (fail-closed resolution) + W2 (schema completeness, all tenant-owned tables now carry `tenant_id`+RLS).
- **Depends on:** W1 — a reliable resolved tenant is the input to "pick the right secret/key/quota."

## Objective

Anything that varies by hospital identity becomes per-tenant, and all shared process/replica state becomes tenant- and replica-safe. After W3: inbound ABDM/HL7 callbacks verify against a **per-tenant** HMAC secret; the dormant `api_keys` table is the live API-key path; PHI is encrypted under a **per-tenant KEK wrapped by a master KEK** (per-tenant crypto-shred), with existing PHI re-wrapped; rate limiting is Redis-backed + replica-safe + per-tenant-quota-aware; caches are tenant-keyed; the ~10 default-tenant-only crons fan out per tenant; and per-tenant branding/config flows from `tenants.settings`.

## Guiding constraint — single-tenant stays byte-identical (the NO-OP invariant continues)

Every W3 change must be behaviour-identical for the existing single (default) tenant. The mechanism is **seed the default tenant from today's globals**, not a runtime "global fallback":

- The default tenant's interop secret rows are seeded from `ABDM_CALLBACK_SECRET` / `HL7_INBOUND_SHARED_SECRET`.
- The default tenant's KEK is provisioned and its existing PHI re-wrapped under it.
- `validateApiKey` keeps the env-var registry as a fallback *for keys not in the DB* (the default tenant's current keys).
- Rate-limit/cache fall back to the hardcoded profiles / dormant state when no per-tenant override exists.

So "no global fallback once configured" (decision B) is satisfied **without** breaking single-tenant: resolution is always per-tenant; the default tenant simply *holds* the formerly-global values.

## Current state (verified 2026-06-19 by three subsystem-mapping passes)

Most W3 infrastructure already exists — W3 is largely *wiring* + two heavier crypto/secret builds.

- **Encryption:** `src/utils/fieldEncryption.js` (`enc:v2` envelope = AES-256-GCM, per-record DEK wrapped by a KEK, `kid` tag drives unwrap + supports rotation via `FIELD_ENCRYPTION_KEK_OLD`). KEK from `LocalKekProvider` (`src/utils/fieldKeyProvider.js`, `FIELD_ENCRYPTION_KEK`, scrypt-derived). A **second** subsystem — `kmsProviderService.js` / `phiEnvelopeService.js` (`KMS_MASTER_KEY`) — encrypts the mig-132 PHI shadow columns. **`encryption_keys` table (mig 129) ALREADY has `tenant_id` + `(tenant_id, key_id)` unique + status/rotation columns, and `encryptionKeyRegistryService` is already per-tenant** — but it has NO column holding wrapped key material, and `encryptField`/`decryptField`/`unwrapDek` do NOT thread `tenantId` (the `kid` is the global `local-v1`).
- **Secrets/API keys:** ABDM inbound HMAC verified with global `ABDM_CALLBACK_SECRET` (`abdmConfig.js`), HL7 with global `HL7_INBOUND_SHARED_SECRET` (`hl7Routes.js`), both via `verifySignedRequest` (timing-safe). **Tenant is resolved AFTER the HMAC check** today (ABDM from ABHA, HL7 from patient UID). `api_keys` table + `apiClientService` (`issueApiKey`/`revokeApiKey`/`authenticateByApiKey`, all per-tenant) are **fully built but dormant** — `validateApiKey` is env-var-only. `teleconsult_provider_configs` is the golden per-tenant-encrypted-secret template (`(tenant_id, provider)` unique, `*_ciphertext` via `encryptField`). No `tenant_interop_secrets` table.
- **Shared state:** `src/lib/redis.js` (ioredis, `REDIS_URL`, graceful no-op, used by the token blacklist) — **Redis is already wired**. Rate limiter is per-process MemoryStore, keyed on uid with **no tenant prefix**, profiles in `rateLimitProfiles.js`; `rate-limit-redis` is NOT a dependency. `cacheMiddleware` is **dormant** (never mounted) and its key omits tenant. ~4 crons already fan out per tenant (`runRevenueCycleSweepAllTenants` is the template); **~10 still run default-tenant-only**. `tenants.settings` jsonb is stored (60s in-memory cache in `tenantService`) but **no feature reads it yet**.

## The 7 workstreams (sequenced by dependency; each independently gated)

### WS1 — `tenants.settings` typed accessor *(foundation, built first)*
`tenantSettingsService` exposing `getTenantSettings(tenantId) → { rateLimits?, branding?, cache?, … }` over the existing `tenantService` 60s cache. Documented key shape in `tenants.settings` jsonb (no migration). Underpins WS2 (quotas) + WS7 (branding).

### WS2 — Redis-backed rate limiting + per-tenant quotas
Add `rate-limit-redis` → `RedisStore` bound to `src/lib/redis.js`. **Graceful fallback to MemoryStore when `REDIS_URL` is unset** (keeps current behaviour + local-test path). Tenant-prefix every key (`t:<tenantId>:…`); per-tenant `windowMs/max` overrides from `tenants.settings.rateLimits`, else the hardcoded profile. Replica-safe (shared Redis counter).

### WS3 — Tenant-keyed cache *(make safe, do NOT mount — decision C)*
Fix `cacheMiddleware`'s key to include `req.tenantId`; add `cacheClear('t:<tenantId>:…')` invalidation helpers. Leave it **dormant/unmounted** (zero stale-data risk; mounting is a deliberate later per-route decision). Closes the tenant-bleed gap before the middleware is ever used. Also tenant-tag the uid-keyed caches noted in the program gap inventory (`jwtMiddleware`, `loginSessionHelper`) defensively.

### WS4 — Wire `api_keys` into `validateApiKey`
`validateApiKey` tries `apiClientService.authenticateByApiKey()` (DB, per-tenant) first; **falls back to the env-var registry** when the presented key isn't a DB key or the schema is missing (default-tenant keys keep working). On a DB match, set `req.apiClient` + `req.tenantId` from the key's tenant; honour `status`/`expires_at`/`allowed_ips`. No change to JWT auth.

### WS5 — Per-tenant field-encryption KEK + re-wrap existing PHI *(heaviest)*
**Envelope hierarchy:** `master KEK → per-tenant KEK → per-record DEK → data`.
- **Master KEK:** ONE new `FIELD_ENCRYPTION_MASTER_KEK` env wraps the per-tenant KEKs for **both** encryption subsystems. Each subsystem's existing global key is retained ONLY as its **legacy grandfather decrypt key** for already-written global-`kid` ciphertext: `FIELD_ENCRYPTION_KEK` for `fieldEncryption.js`, `KMS_MASTER_KEY` for `kmsProviderService`. Neither is the default tenant's new KEK — the default tenant gets a freshly-provisioned random per-tenant KEK like every tenant.
- **Per-tenant KEK storage:** add a `wrapped_key_material` column (the per-tenant KEK encrypted under the master KEK) to `encryption_keys` (the table is already per-tenant). `provisionTenantKek(tenantId)` generates a random 32-byte KEK, wraps it under the master KEK, inserts an `active` `encryption_keys` row with `kid = t:<tenantId>:v1`. The same unwrapped per-tenant KEK is shared by both providers. **Crypto-shred** = delete (or mark `compromised`/`retired`) that wrapped row → the tenant's data is unrecoverable.
- **Provider:** both `LocalKekProvider` and `kmsProviderService`'s `EnvKmsProvider` get a tenant-aware `getKek(keyId, { tenantId })` that, for a tenant-scoped `kid`, loads + unwraps the per-tenant KEK from `encryption_keys` under the master KEK (cached); for a legacy global `kid`, uses that subsystem's retained global key (grandfather). Thread `tenantId` through `encryptField`/`decryptField`/`unwrapDek`/`rewrapField` and their call sites (webhook secrets, OAuth secrets, HL7 outbound, telemedicine configs, the mig-132 PHI columns) — the tenant is derived from the owning row's `tenant_id`.
- **Re-wrap (decision A — idempotent background job):** `scripts/phi-rewrap-tenant-keks.mjs`, modeled on `phi-backfill.mjs` — for each encrypted column on each tenant-owned table, in batches, decrypt under the resolved (legacy or tenant) KEK and re-encrypt-wrap under the tenant's KEK, writing back `enc:v2` with the tenant `kid`. Resumable + re-runnable (skips rows already on the tenant `kid`). Run against the default tenant as part of W3 verification.

### WS6 — Per-tenant ABDM/HL7 inbound secrets *(reject unresolved — decision B)*
New `tenant_interop_secrets` table mirroring `teleconsult_provider_configs`: `(tenant_id, kind)` unique where `kind ∈ {abdm_callback, hl7_inbound}`, `secret_ciphertext` (via `encryptField`), `sender_identifier` (the value used to resolve tenant), status. **Resolve tenant BEFORE HMAC** from the sender identifier — ABDM HIP/CM id (header or callback payload), HL7 MSH sending/receiving facility — via a `sender_identifier → tenant` lookup. Verify HMAC with that tenant's decrypted secret. **If no tenant resolves → reject (401/400)**; no global fallback. A migration seeds the **default tenant**'s `abdm_callback`/`hl7_inbound` rows from today's env secrets + the current sender identifier, so the existing single-tenant sender keeps working. (Exact header/segment confirmed during implementation; the design fixes the seam.)

### WS7 — Cron fan-out
Wrap the ~10 default-tenant-only crons (`send-appointment-reminders`, `timed-reminders`, `process-scheduled-notifications`, `drug-chart-missing-sla`, `investigation-notifications`, `unread-critical-notification-escalation`, `escalate-stuck-orders`, `operational-alert-sweep`, `reap-stale-visits`, `roster-deadline-escalation`) in the existing `runRevenueCycleSweepAllTenants` tenant-discovery loop (discover tenants → `setTenant(tenantId, …)` per tenant → aggregate errors per tenant, one failing tenant never aborts the others). Keep `withJobLock` semantics.

## Testing & gate

- **Per-workstream deep tests:** WS2 — shared-store key isolation + per-tenant quota override; WS4 — DB key authenticates + env fallback + revoked/expired rejected; WS5 — encrypt-as-tenant-A/decrypt round-trips, decrypt of legacy global-`kid` ciphertext still works, re-wrap job is idempotent, **crypto-shred** (drop tenant KEK → tenant A's ciphertext is unrecoverable while tenant B's is intact); WS6 — **tenant A's ABDM/HL7 secret cannot verify tenant B's callback**, unresolved sender rejected, default-tenant seeded secret still verifies; WS7 — a cron fans out across seeded tenants A+B and isolates failures.
- **Existing gates stay green:** `check-schema-drift`, `check:phi-tenant-id` (any new tenant_id table — `tenant_interop_secrets` — gets a policy via the FOREACH-ARRAY idiom so the static guard sees it), `check:no-default-tenant-fallback`.
- **Final gate:** the full chunked-as-postgres gate (`run-ci-jest.mjs` as `postgres`) GREEN on a rebuilt QA DB → "All chunks passed". Redis-dependent tests degrade gracefully when `REDIS_URL` is unset (the keying logic is unit-tested without Redis).

## Risks & mitigations

- **Re-wrap correctness / data loss** (WS5): the re-wrap job decrypts then re-encrypts PHI. Mitigate — idempotent + resumable + per-batch verify (decrypt-after-write equals the original), dry-run mode, and the decrypt path always tolerates BOTH `kid` forms so a half-finished run is fully readable. Never drop the legacy global KEK until every row is re-wrapped (a guard counts remaining legacy-`kid` rows).
- **Two encryption subsystems** (WS5): `fieldEncryption` vs `kmsProviderService`. Thread tenant through BOTH rather than risk a big-bang unification; share the `encryption_keys`-backed per-tenant KEK loader.
- **Pre-HMAC tenant resolution** (WS6): resolving tenant before verifying the signature means an unauthenticated lookup by sender identifier — keep it a cheap, side-effect-free indexed read; reject fast on miss; never trust the identifier beyond selecting which secret to check.
- **Redis availability** (WS2): graceful MemoryStore fallback preserves correctness on a single node; per-tenant quota + replica-safety simply require Redis in prod (already deployed). Local QA without Redis still passes (keying logic unit-tested).
- **Crypto-shred vs backups** (WS5): deleting a tenant KEK shreds live data but not historical backups — documented as an operational caveat (out of scope to solve here).

## Done-criteria

1. WS1–WS7 implemented; per-workstream deep tests green; `tenant_interop_secrets` policied (phi-tenant-id allowlist stays empty); drift clean; no-default-tenant-fallback clean.
2. Per-tenant secret resolution proven (tenant A's ABDM/HL7 secret cannot verify tenant B's callback; unresolved sender rejected); KEK crypto-shred + re-wrap-idempotency proven; rate-limit shared-store + per-tenant-quota proven; cron fan-out deep tests green.
3. Full chunked-as-postgres gate GREEN on a rebuilt QA DB.
4. Program memory + this spec's wave-status updated; on to W4 (edge routing & token tenant claim). Branch stays on `feat/multi-tenancy-program` (HOLD); no ff main.
