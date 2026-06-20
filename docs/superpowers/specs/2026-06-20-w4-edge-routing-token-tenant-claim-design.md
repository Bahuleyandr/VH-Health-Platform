# W4 — Edge routing & token tenant claim (design)

- **Date:** 2026-06-20 · **Wave:** 4 of the [multi-tenancy program](2026-06-19-multi-tenancy-program-design.md).
- **Status:** Design — approved shape (Host-derived trust; client `x-tenant-*` untrusted; token cross-check; backend-now / wildcard-infra-HELD). Ready for an implementation plan.
- **Branch:** `feat/multi-tenancy-program` (HOLD — not pushed). Builds on W1 (fail-closed resolution), W2 (schema), W3 (per-tenant secrets/state).
- **Depends on:** W1 (a reliable resolved tenant). Coordinates with W7 (the wildcard subdomain DNS/TLS + Cloudflare routing is operator/HELD, spec'd here, flipped on at onboarding).

## Objective

The tenant is identified at the **edge by the request's per-tenant subdomain**, carried in **every** token, and the backend **trusts the Host/token, never a raw client header**. After W4: a request to `tenant-a.api.<host>` resolves tenant A end-to-end; the token minted at any login (admin/staff/patient/refresh/dev) carries the correct `tenant_id`; a client cannot influence its tenant by sending `x-tenant-*`; and a token minted for one tenant is rejected on another tenant's subdomain.

## Trust model (decided) — Host-derived, trust-by-topology

The only network path to the backend is **Cloudflare Tunnel → ingress-nginx → Service** with **zero inbound ports** and per-tenant TLS. So the request **Host** (subdomain) is authoritative and cannot be spoofed to another tenant by a client. Therefore:

- The backend derives the tenant from `req.hostname`'s **leftmost label** (the subdomain slug), NOT from a client header.
- Client-supplied `x-tenant-id` / `x-tenant-slug` are **untrusted** and ignored for resolution — EXCEPT the existing authenticated **SUPER_ADMIN `x-tenant-id` override** (requires `x-tenant-override-reason`, audit-logged; unchanged from W1/W3).
- No ingress/Cloudflare header injection is required (ingress-nginx has `allow-snippet-annotations: false` for security — we do not fight that). The **only** operator/HELD piece is **wildcard DNS + wildcard TLS** for `*.api.<host>`.

## NO-OP invariant (single-tenant stays byte-identical)

Today there is one host (`api.vhhealth.app`, no per-tenant subdomain). `tenantFromHost` on a **bare base host** (no extra label) returns the **default tenant**, so every code path behaves exactly as today. Per-tenant behavior only activates once a real tenant onboards on its subdomain. This is the W1/W2/W3 NO-OP discipline continued.

## Current state (verified by two mapping passes, 2026-06-20)

- **Token claim is ~80% wired by W3.** `loginSessionHelper.issueAccessTokenAndClaimSession` already resolves + injects the `tenant_id` claim; `jwtMiddleware` reads `decoded.tenant_id` → `req.user.tenant_id`; `tenantContextMiddleware` precedence is JWT-claim → SUPER_ADMIN `x-tenant-id` (reason+audit) → `users.tenant_id` lookup → fail-closed default.
- **Pre-auth resolution** (`tenantService.resolveTenantForRequest(req)`) reads `x-tenant-id` → `x-tenant-slug` → default. It is used by the **Firebase** login path to scope identity lookup + INSERT. Staff/admin login do NOT pre-resolve a tenant.
- **Gaps:** (a) patient OTP login (`authService`) + dev login mint via **bare `generateToken`** → **no `tenant_id` claim**; (b) `resolveTenantIdForUid` looks up `users`, so **admin** tokens (admins are not in `users`; `admins.tenant_id` added in mig 334) silently resolve to the **default** tenant; (c) client `x-tenant-*` is accepted pre-auth and **not stripped**; (d) no subdomain-derived tenant anywhere; (e) no Host↔token cross-check.
- **Infra:** Cloudflare tunnel routes only `api`/`admin.vhhealth.app` (no wildcard); no per-subdomain header injection. = operator/HELD.

## Components (backend; each independently testable)

### C1 — `tenantFromHost(req)` (new, in `tenantService.js`)
Parse the subdomain slug from `req.hostname` against a configured base host and resolve the tenant.
- Config: `TENANT_BASE_HOST` (e.g. `api.vhhealth.app`; may be a comma list for staging/dev/`localhost`). 
- `host === baseHost` (or host not under baseHost) → **default tenant** (slug `null`).
- `host === '<slug>.' + baseHost` → `getTenantBySlug(slug)`; unknown/inactive slug → reject (`AppError.badRequest('Unknown or inactive tenant')`), matching `resolveTenantForRequest`'s existing contract.
- Returns `{ tenantId, slug }`. Cached via the existing tenant cache (no per-request DB hit in steady state).

### C2 — Pre-auth resolution becomes Host-first
`resolveTenantForRequest(req)` → use `tenantFromHost(req)` as the **sole** trusted pre-auth signal; remove the client `x-tenant-id` / `x-tenant-slug` branches. (The SUPER_ADMIN override is a post-auth concern in `tenantContextMiddleware`, untouched.) All current callers (Firebase login; new staff/admin pre-auth in C5) keep working — single-tenant resolves to default.

### C3 — No client header influences tenant resolution
Pre-auth resolution (C2) ignores client `x-tenant-*` entirely (Host-only). Post-auth, the ONLY honored client header is the **SUPER_ADMIN `x-tenant-id` override** (role + `x-tenant-override-reason` + audit, in `tenantContextMiddleware` — unchanged from W1/W3). A regular user's `x-tenant-*` is silently **ignored**, never an error. We do NOT blanket-delete the headers (that would break the SUPER_ADMIN override, which legitimately reads `x-tenant-id` AFTER auth); instead we assert — via a code audit (grep for `x-tenant-` reads) + the header-trust tests — that no code path outside the audited override trusts a client tenant header.

### C4 — Post-auth Host↔token cross-check (`tenantContextMiddleware`)
After the JWT-claim tenant is established, if `tenantFromHost(req)` yielded a **non-default** tenant that **differs** from the token's `tenant_id` → **reject 403** (`TENANT_HOST_TOKEN_MISMATCH`). Defends against replaying a tenant-A token on tenant-B's subdomain. **Exemptions:** SUPER_ADMIN (platform `tenant_id` null) legitimately crosses tenants via the audited override, and an active SUPER_ADMIN `x-tenant-id` override is authoritative — both bypass the cross-check. Bare-host / default → no cross-check (preserves single-tenant + non-subdomained internal calls).

### C5 — Every token path carries the right `tenant_id`
- **Patient OTP login** + **dev login**: route through `issueAccessTokenAndClaimSession` (or resolve the tenant from the request + pass it explicitly) so the minted token carries `tenant_id`.
- **Admin login**: pass `admin.tenant_id` (mig 334) **explicitly** into the token payload so the helper uses it directly instead of the `users`-keyed `resolveTenantIdForUid` (which mis-resolves admins to default). Refresh re-mint reads the admin's tenant the same way.
- **Staff login**: pre-resolve the Host tenant (C2), scope the employee credential lookup to it, stamp the token's `tenant_id`.
- **Refresh**: ensure the re-minted access token re-resolves `tenant_id` correctly for every role (staff/patient via `users`, admin via `admins`).

## Testing & gate

- **Unit:** `tenantFromHost` (bare-host→default, `slug.base`→tenant, unknown-slug→reject, multi-base-host/localhost); header-strip middleware removes client `x-tenant-*`.
- **Deep (2-tenant):** seed tenant A+B with their slugs; a request on `b.<base>` with a tenant-A token → 403 cross-check; client `x-tenant-id: B` on tenant-A's host → ignored (resolves A); every login path (OTP/staff/admin/firebase/dev) mints a token whose `tenant_id` matches the Host tenant; same phone/username in A and B logs into the correct tenant by subdomain.
- **Existing gates stay green:** the auth/tenant suites (firebaseAuthService, tenant-override-audit, cross-tenant-rls journey, walkin-tenant-binding) must pass unchanged under the NO-OP (default-host) path.
- **Final gate:** full chunked-as-postgres gate GREEN on a rebuilt DB → "All chunks passed". (Runs once the QA cluster is healthy — see the program memory's cluster-reboot note.)

## Risks & mitigations

- **Edge↔backend trust composition:** the whole model rests on "the Host can't be spoofed to another tenant." True only because there are zero inbound ports (Cloudflare tunnel is the sole ingress) and TLS is per-host. Documented as the security invariant; if a direct-to-backend path is ever opened, this must be revisited (defense-in-depth: RLS + the token cross-check still contain a spoof post-auth).
- **`req.hostname` behind proxies:** Express derives `hostname` from `Host` (or `X-Forwarded-Host` when `trust proxy` is set). Confirm the Cloudflare/ingress chain forwards the real per-tenant Host; pin the parsing to `Host` and validate `trust proxy` config so a client `X-Forwarded-Host` can't override it.
- **Login flows that pre-date a known tenant:** handled — the subdomain is known at login time (the per-tenant build hits its own subdomain), so pre-auth resolution has a tenant before any identity lookup.
- **Single-tenant regression:** mitigated by the bare-host→default invariant + keeping every existing auth test green.

## Done-criteria

1. C1–C5 implemented; unit + 2-tenant deep tests green; existing auth/tenant suites green under the default-host NO-OP.
2. A request on `tenant-a.<base>` resolves tenant A end-to-end; every login path mints a token carrying the right `tenant_id`; a client `x-tenant-*` cannot change the resolved tenant; a cross-subdomain token is rejected.
3. Full chunked-as-postgres gate GREEN on a rebuilt DB.
4. Program memory + this spec's wave-status updated; on to W5 (admin portal multi-tenancy). Branch stays on `feat/multi-tenancy-program` (HOLD); no ff main.
5. **Operator/HELD (documented, not built):** wildcard DNS (`*.api.<host>`) + wildcard TLS + per-tenant subdomain provisioning — folded into the W7 onboarding orchestrator.
