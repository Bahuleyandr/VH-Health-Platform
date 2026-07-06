# NL-1 Enterprise Identity Design

- Date: 2026-07-05
- Program: NL-1 Enterprise identity
- Status: Design proposal, deploy held
- Scope: Specification only. This document does not implement application code, database migrations, Kubernetes manifests, or client screens.
- Recommendation: Add tenant-scoped federation brokers for the ADMIN and STAFF realms. OIDC is the primary protocol, SAML is the secondary compatibility protocol, and both terminate in the backend issuing VH Health JWTs through the existing session machinery.

## 1. Context and Binding Invariants

NL-1 asks for OIDC and SAML SSO for staff/admin users, IdP group to `roleHelpers` role mapping, SCIM provisioning, preserved session policies, break-glass local accounts, and audited IdP events.

Repository evidence used for this design:

- `docs/NEXT_LEVEL_ROADMAP.md`: NL-1 is design-first and explicitly names OIDC, SAML, SCIM, session policies, break-glass local accounts, IdP event audit, `jwtMiddleware`, and the admins/staff identity split.
- `apps/backend/CLAUDE.md`: `jwtMiddleware.js` is the single JWT verification layer; the normalized `req.user` shape is `{ uid, role, roles?, phone?, email? }`; role helpers from `src/utils/roleHelpers.js` are the canonical role surface.
- `apps/backend/src/middleware/jwtMiddleware.js`: bearer JWT verification, jti revocation checks, revoke-all checks, role normalization, `rawRole` preservation, `tenant_id`, `deviceType`, `mfa`, `scope`, and `jti` surfacing on `req.user`.
- `apps/backend/src/services/auth/loginSessionHelper.js`: `issueAccessTokenAndClaimSession()` allocates `jti`, stamps `tenant_id` and optional `deviceType`, records the active session, and returns the signed access token; `resolveTenantIdForUid()` handles the staff/user realm and the separate admin realm.
- `apps/backend/src/services/auth/authService.js` and `apps/backend/src/controllers/auth/adminAuthController.js`: admin login, refresh tokens, SUPER_ADMIN mandatory MFA setup/challenge, and post-MFA sessions.
- `apps/backend/src/services/auth/staffAuthService.js` and `apps/backend/src/controllers/auth/staffAuthController.js`: staff password login, staff PIN login, quick login, device registration, and device-bound session behavior.
- `apps/backend/src/utils/roleHelpers.js`: canonical `ROLES`, `ALL_STAFF_ROLES`, `ADMIN_ROLES`, and role predicates.
- `docs/superpowers/specs/2026-06-19-multi-tenancy-program-design.md` section 8: patient identity is per-tenant; tenant `ADMIN` is tenant-bound; only `SUPER_ADMIN` crosses tenants; audit/activity logs are tenant-scoped; per-tenant secrets/config live in `tenants.settings`, `tenant_interop_secrets`, `tenant_encryption_keys`, and `api_keys`.
- `apps/backend/src/migrations/338_tenant_interop_secrets.sql`: current encrypted tenant-secret pattern with `tenant_id`, kind, sender identifier, encrypted secret, status, uniqueness, and RLS.

Binding invariants:

- Do not replace `jwtMiddleware`. Federation produces a normal VH Health JWT that `jwtMiddleware` already understands.
- Do not make patient login part of NL-1. The patient realm remains Firebase OTP and per-tenant patient identity stays governed by the multi-tenancy program.
- Do not collapse staff and admin identities. Staff are in the `users`/`staff` realm; admins are in the `admins` realm, with tenant-bound `ADMIN` and platform `SUPER_ADMIN` semantics intact.
- Do not add an always-on middleware cost for tenants that have no SSO enabled.
- Every IdP assertion, mapping decision, provisioning mutation, break-glass event, and deprovision action must be audited with tenant context.

## 2. Target Architecture

### Broker Pattern

Add federation brokers as explicit auth endpoints, not as a replacement auth middleware:

- ADMIN OIDC: `GET /api/v1/auth/admin/sso/oidc/:provider/start` and callback.
- STAFF OIDC: `GET /api/v1/auth/staff/sso/oidc/:provider/start` and callback.
- ADMIN SAML: `POST /api/v1/auth/admin/sso/saml/:provider/acs`.
- STAFF SAML: `POST /api/v1/auth/staff/sso/saml/:provider/acs`.

Each broker performs the external protocol exchange, validates the assertion, maps the principal to a local identity, and then calls the same session helper used by local login:

1. Resolve tenant before trusting the provider. For admin web, tenant comes from the per-tenant admin host. For staff app P2, tenant comes from the per-tenant app build/API base URL plus PKCE state. For platform SUPER_ADMIN, only explicitly configured platform providers may issue a tenant-null SUPER_ADMIN identity.
2. Load the tenant's enabled IdP config for `(tenant_id, realm, provider_key, protocol)`. If no config is active, return a normal login error. No global IdP fallback.
3. Validate the assertion:
   - OIDC: authorization-code + PKCE where possible; issuer, audience, nonce, state, expiry, signature, JWKS `kid`, `acr`/`amr` if configured, and hosted domain/tenant hints when supplied.
   - SAML: signed response or signed assertion, issuer/entity ID, audience/recipient, ACS URL, `InResponseTo`, `NotBefore`/`NotOnOrAfter`, replay ID, NameID format, and encrypted assertion support where configured.
4. Normalize an IdP principal record: issuer/entity ID, subject, email, display name, groups, IdP session ID, assurance fields, and raw assertion hash. Do not store raw tokens/assertions beyond short-lived debug redaction.
5. Map IdP groups to canonical roles and resolve exactly one local identity in the correct realm.
6. Issue a VH Health access token through `issueAccessTokenAndClaimSession()`, preserving:
   - server-allocated `jti`;
   - token blacklist/revoke-all behavior;
   - `tenant_id` claim;
   - `deviceType` claim when the initiating client supplied it;
   - `rawRole` behavior for SUPER_ADMIN;
   - existing access-token lifetimes by realm.
7. Issue refresh tokens through the existing refresh-token path. Refresh should rotate VH Health tokens only; it must not require a live IdP call on every refresh.

The assertion path ends at the same internal shape local login uses today:

```text
IdP assertion -> federation broker -> local staff/admin identity -> issueAccessTokenAndClaimSession()
              -> VH Health JWT -> jwtMiddleware -> tenantContextMiddleware -> route RBAC
```

This keeps `jwtMiddleware` as the only JWT verifier on protected routes. The new code verifies IdP tokens/assertions only inside the login/callback endpoints.

### Realm Split

ADMIN realm:

- Tenant `ADMIN` accounts map to rows in `admins` with a non-null `tenant_id`.
- Platform `SUPER_ADMIN` accounts map to tenant-null `admins` rows and require explicit platform provider configuration.
- Admin portal SSO is web-first in P1. Use authorization code flow and secure cookies or bearer response shape consistent with the current admin login implementation.
- SUPER_ADMIN step-up MFA stays in force. An IdP-authenticated SUPER_ADMIN does not bypass local `requireSuperAdminStepUp` controls unless the broker has completed a local step-up flow or a separately approved high-assurance IdP step-up has been mapped into `mfa: true`.

STAFF realm:

- Staff SSO maps to `users` plus `staff`, not `admins`.
- Staff tokens keep staff expiry and `deviceType`.
- Staff SSO is additive to employee ID/password, PIN login, and quick-login. Ward tablets and shared clinical devices continue using the existing device-bound staff flows where that is safer operationally.
- P2 mobile/Flutter SSO should use system-browser OIDC with PKCE, not embedded WebViews.

## 3. Tenant-Scoped IdP Configuration

Store tenant IdP configuration using the `tenant_interop_secrets` pattern: tenant-scoped, encrypted secrets, explicit status, uniqueness, and RLS. The design target is a new tenant-owned config surface, not global env-only SSO.

Proposed logical entities:

- `tenant_identity_providers`
  - `tenant_id`
  - `realm`: `admin` or `staff`
  - `protocol`: `oidc` or `saml`
  - `provider_key`: stable slug such as `entra-main` or `keycloak-staff`
  - `display_name`
  - `status`: `draft`, `active`, `disabled`
  - discovery fields: OIDC issuer/discovery URL/JWKS URI; SAML entity ID/metadata URL/ACS settings
  - nonsecret policy fields: allowed domains, required claims, group claim name, SCIM mode, default failure mode
  - encrypted secret/certificate fields: OIDC client secret, SAML signing/decryption private keys, SCIM bearer token hash material if applicable
  - timestamps and audit actor fields
- `tenant_idp_role_mappings`
  - `tenant_id`, `provider_id`, `realm`, `idp_group`, `vh_role`, `status`, `priority`, `created_by`, `updated_by`
- `federated_identities`
  - `tenant_id`, `realm`, `provider_id`, `issuer`, `subject`, `local_uid`, `email_at_link`, `last_seen_at`, `status`
- `identity_audit_events`
  - tenant-scoped append-only audit for assertion accepted/denied, group mapping, link/create, SCIM create/update/deactivate, break-glass use, and deprovision session revocation.

Nonsecret tenant defaults may be mirrored into `tenants.settings` only for UI display and feature flags. Secrets must be encrypted and tenant-owned. The runtime should cache provider metadata and JWKS by `(tenant_id, provider_id, kid)` with TTL and invalidation on config update; tenants without active SSO should not pay for metadata lookups.

## 4. IdP Group to Role Mapping

The only allowed target roles are canonical values from `ROLES` in `apps/backend/src/utils/roleHelpers.js`.

Mapping rules:

- Mapping is per tenant, per provider, per realm. A group named `Doctors` at tenant A is unrelated to `Doctors` at tenant B.
- The ADMIN realm may map only to `ADMIN` or, for platform provider configs only, `SUPER_ADMIN`.
- The STAFF realm may map only to `ALL_STAFF_ROLES` values and must not map to `ADMIN`, `SUPER_ADMIN`, `PATIENT`, or `WEBHOOK_CLIENT`.
- Machine roles such as `WEBHOOK_CLIENT` are not human IdP targets.
- If the assertion has no mapped group, or maps to more than one incompatible highest role, login fails closed with an audited `SSO_ROLE_MAPPING_FAILED`.
- If multiple groups map to staff roles, choose one deterministic effective role by tenant policy. The conservative default is "most privileged explicit mapping requires owner approval"; until such a priority is configured, multiple matches fail closed.
- Never infer roles from email domain, display name, title, department, or unapproved IdP app role names.

Mapping lifecycle:

- Tenant admins can request or edit mappings only inside their own tenant.
- SUPER_ADMIN can manage platform mappings and assist tenant mappings through the existing audited tenant override path.
- Mapping changes do not silently change active sessions. The implementation phase should either revoke active sessions for affected users or require re-login before new mappings apply.

## 5. SCIM 2.0 Provisioning

SCIM is a provisioning surface, not an authentication surface. It must coexist with local staff/admin CRUD.

Endpoints should be tenant/provider scoped, for example:

- `GET/POST /api/v1/scim/v2/:tenantSlug/:providerKey/Users`
- `GET/PATCH/PUT/DELETE /api/v1/scim/v2/:tenantSlug/:providerKey/Users/:id`
- `GET /api/v1/scim/v2/:tenantSlug/:providerKey/Groups`
- `GET /api/v1/scim/v2/:tenantSlug/:providerKey/ServiceProviderConfig`

Authentication:

- Use per-tenant SCIM bearer credentials, stored encrypted/hashed in the tenant IdP config surface.
- SCIM credentials are not human JWTs and must not run through `jwtMiddleware`.
- SCIM routes must resolve tenant and provider first, then authenticate the SCIM token in constant time, then audit every mutation.

Provisioning behavior:

- `active=true` creates or reactivates the local staff/admin identity in the configured realm.
- `active=false` deactivates the local identity, revokes all active VH Health sessions, and disables device-bound quick-login/PIN where applicable.
- SCIM group membership updates change proposed role mappings only when the groups are already mapped in `tenant_idp_role_mappings`; unmapped groups do not create roles.
- Local CRUD remains available for break-glass, contractors, temporary staff, and tenants without SCIM. Records should carry `source = local | scim | hybrid`.
- Local edits to SCIM-owned identity fields should be restricted or marked as overrides. Recommended owner model:
  - SCIM owns employment identity fields such as active state, employee identifier, email, name, department, and group-derived role.
  - Local VH Health owns clinical app settings, ward/device registrations, PIN/device state, and emergency break-glass flags.
  - Conflict resolution is explicit and audited.

Deprovisioning done criteria:

- Deactivated SCIM user cannot log in via SSO, password, PIN, quick-login, or refresh.
- Existing access tokens are denied by revoke-all or blacklist checks.
- Staff devices remain in history but are no longer accepted for login.
- Audit logs show the SCIM actor, tenant, provider, local uid, prior state, new state, and assertion/request ID.

## 6. Break-Glass Local Accounts

Local login must remain as a controlled break-glass path.

Policy:

- Each tenant keeps at least two named local admin break-glass accounts, stored in the normal admin realm, not shared passwords.
- Break-glass accounts are excluded from SCIM deactivation, but they are visible in tenant security reports.
- Break-glass accounts require strong local password policy and MFA where the role is ADMIN or SUPER_ADMIN.
- Break-glass use requires a reason before full access whenever the normal SSO path is healthy enough to evaluate. If SSO is down, reason capture can occur at first post-login sensitive operation.
- Break-glass sessions are short-lived, heavily audited, and should emit security notifications.
- Quarterly access review must prove the accounts still work and remain assigned to current, authorized owners.

This is distinct from clinical PHI break-glass. NL-1 break-glass is an identity-continuity mechanism for SSO outage or IdP misconfiguration.

## 7. Session Policy Interactions

Existing policies stay authoritative:

- `jwtMiddleware` remains the only protected-route JWT verifier.
- Token revocation continues through `jti`, blacklist, revoke-all, refresh rotation, and `user_active_sessions`.
- Admin expiry remains admin-specific; staff expiry remains staff-specific.
- `deviceType` remains part of the VH Health token when the client provides it.
- `requireSuperAdminStepUp` stays on sensitive namespaces. SSO does not remove it.
- Staff PIN login and quick-login stay for ward tablets and shared clinical workflows. SSO can be used for initial enrollment or normal workstation login, but it is not a replacement for registered-device PIN flows.
- Narrow-scope token rules still apply. IdP callback tokens are never accepted as REST bearer tokens.

Step-up MFA policy:

- Default: SUPER_ADMIN SSO login still requires local TOTP step-up before `mfa: true` is minted.
- Optional future policy: a tenant/platform may map IdP high-assurance claims into `mfa: true` only after owner approval. Required evidence would include OIDC `acr`/`amr` or SAML AuthnContext values, provider config pinning, tests, and audit events. Until approved, fail closed to local TOTP.

## 8. Patient Realm Out of Scope

Patient identity remains Firebase OTP. NL-1 must not add patient SSO, patient SAML, patient SCIM, or a patient hospital picker.

This follows the multi-tenancy decision that patient identity is per tenant: the same person at two hospitals has separate isolated patient records, and the per-tenant app/build supplies tenant context. Any future patient federation would need its own design and privacy review.

## 9. No Always-On Cost for Non-SSO Tenants

Non-SSO tenants should continue to pay only the existing auth cost:

- No new middleware in the global protected-route chain.
- No per-request IdP metadata/JWKS/SAML lookup after a VH Health JWT is issued.
- No SCIM lookup during normal login.
- SSO config is loaded only on `/sso/*` and `/scim/*` endpoints or tenant admin config screens.
- JWKS and metadata refresh are background/on-demand by active provider, not global polling for all tenants.
- Existing local admin/staff login paths should not query SSO tables unless the caller enters an SSO endpoint.

## 10. validateEnv Additions to Document During Implementation

Most IdP configuration is per tenant and should live in encrypted DB-backed config, not global env. The implementation plan should still document and validate global operational limits:

- `SSO_OIDC_HTTP_TIMEOUT_MS`: outbound metadata/token/JWKS request timeout.
- `SSO_METADATA_CACHE_TTL_SECONDS`: discovery/JWKS/SAML metadata cache TTL.
- `SSO_ASSERTION_CLOCK_SKEW_SECONDS`: max accepted clock skew for OIDC/SAML assertion timestamps.
- `SSO_SAML_MAX_ASSERTION_BYTES`: max decoded SAML response size.
- `SSO_SCIM_MAX_PAGE_SIZE`: SCIM list cap.
- `SSO_DEBUG_ASSERTION_LOGGING`: must be rejected in production unless set to `false` or empty.

Tenant-specific values such as issuer, metadata URL, client ID, client secret, SAML certs, SCIM bearer credentials, required groups, and claim names belong in the tenant IdP config surface. They should not be added as one-off global env vars.

## 11. Audit Requirements

Every assertion path is audited:

- SSO start: tenant, realm, provider, protocol, request ID, state hash, device type, redirect target class.
- Assertion accepted: tenant, realm, provider, issuer/entity ID, subject hash, local uid, mapped role, assurance fields, assertion ID hash, IdP session ID hash.
- Assertion denied: reason code, tenant/provider if resolvable, issuer/entity ID if safe, subject hash if validated, never raw assertion.
- Group mapping failure: groups hash/list redacted by policy, missing mapping reason, provider ID.
- Local identity link/create: local uid, source `sso`, provider ID, subject hash.
- SCIM mutation: SCIM actor, operation, local uid, prior active state, new active state, role/mapping impact.
- Deprovision: revoke-all result and affected device/session counts.
- Break-glass login/use: reason, account uid, tenant, role, notification status.

Audit writes should be tenant-scoped and append-only. Failure to persist security-critical assertion audit should fail closed for login unless the owner explicitly approves a degraded-mode exception.

## 12. Phased Plan

### P1 - OIDC Login for Admin Portal

Build ADMIN realm OIDC first because admin is browser-based and has the smallest client surface.

Scope:

- Tenant admin UI/API for OIDC provider config, stored tenant-scoped and encrypted.
- OIDC authorization-code callback broker.
- Link IdP principal to an existing `admins` row only. P1 does not allow admin just-in-time creation.
- Per-tenant group to `ADMIN` mapping; platform-only path for `SUPER_ADMIN`.
- Local VH Health token issuance through `issueAccessTokenAndClaimSession()`.
- Preserve SUPER_ADMIN local MFA step-up.

Test strategy:

- Unit tests for discovery validation, state/nonce, issuer/audience, JWKS kid rotation, expired token, wrong tenant host, and unmapped group fail-closed.
- Controller tests proving callback produces a normal VH Health JWT with `jti`, `tenant_id`, `rawRole` where relevant, and no IdP token accepted by `jwtMiddleware`.
- Deep two-tenant tests: tenant A IdP assertion cannot create/session tenant B admin.
- SUPER_ADMIN tests: SSO without step-up cannot pass `requireSuperAdminStepUp`.
- Audit tests for accepted, denied, and mapping-failed assertions.

### P2 - Staff App OIDC via System Browser PKCE

Scope:

- STAFF realm OIDC provider config.
- Flutter staff app starts system-browser PKCE login, receives app/deep-link callback, and exchanges code with backend broker.
- Staff identity links to existing `users`/`staff`; optional JIT staff creation only when SCIM is not enabled and tenant policy allows it.
- Preserve staff password/PIN/quick-login and device registration.

Test strategy:

- Backend tests for PKCE verifier/challenge, tenant binding in state, redirect allowlist, group mapping to `ALL_STAFF_ROLES`, and deviceType propagation.
- Flutter tests for system-browser launch and callback parsing using mocked platform/deep-link handlers.
- Staff session tests proving attendance/device-gated routes still honor `deviceType`.
- Negative tests for embedded WebView callback, unknown tenant, unmapped group, disabled staff record, and deprovisioned staff record.

### P3 - SCIM 2.0 Provisioning

Scope:

- Tenant/provider-scoped SCIM 2.0 `/Users`, `/Groups`, and metadata endpoints.
- SCIM token management with encrypted/hashed tenant credentials.
- Source ownership model for local versus SCIM-managed staff/admin fields.
- Deprovision revokes VH Health sessions and disables staff device login.

Test strategy:

- SCIM conformance subset tests for create, patch replace, patch remove, filter by userName/externalId, pagination, active false, and idempotent retries.
- Tenant isolation tests for SCIM tokens and provider keys.
- Local CRUD coexistence tests for `source=local`, `source=scim`, and override conflict behavior.
- Deprovision tests proving SSO, local password, PIN, quick-login, and refresh are all blocked.
- Audit tests for every mutation and revoke-all result.

### P4 - SAML 2.0 Compatibility

Scope:

- SAML metadata import, signed AuthnRequest where required, ACS endpoints, replay cache, certificate rotation, and optional encrypted assertions.
- Same local identity link, group mapping, session issuance, audit, and tenant isolation rules as OIDC.
- SAML is compatibility-first for hospitals whose IdP cannot support OIDC cleanly.

Test strategy:

- Signature validation tests for response-signed and assertion-signed cases.
- Audience/recipient/ACS mismatch tests.
- Expiry, `NotBefore`, replay ID, unsigned assertion, and oversized assertion rejection.
- Tenant A/B metadata mix-up tests.
- Same role mapping and VH Health JWT issuance tests as OIDC.

## 13. Owner Decisions

Locked for P1:

- Reference IdP: Keycloak first. Microsoft Entra ID validation is deferred until after the Keycloak-first broker is reviewable.
- Keycloak bundle: include a HELD/default-off Keycloak reference under infra for self-hosted hospital deployments and operator-run local smoke testing. It must not be referenced by root kustomization or CI until explicitly approved.
- Admin JIT: disabled. ADMIN and SUPER_ADMIN SSO can only link to an existing, active `admins` row; unmatched assertions are audited failures.
- SUPER_ADMIN step-up: local TOTP is always required for sensitive namespaces. SSO must not mint `mfa: true`; no OIDC `acr`/`amr` shortcut is approved in P1.
- P1 scope: ADMIN realm OIDC only. Staff realm, SAML, and SCIM remain P2-P4.
- Tenant admin UX: P1 maps one or more IdP group strings to the single effective ADMIN role for tenant providers; platform providers may map only to SUPER_ADMIN.

Still open after P1:

- Decide whether staff JIT creation is allowed before SCIM ships, and which fields are required for safe creation.
- Decide retention periods for assertion hashes, SSO audit events, and SCIM request logs.

## 14. Open Questions

- Which IdP should be the first live reference target: Entra ID because hospitals commonly use Microsoft, Keycloak because it is deterministic for CI/on-prem demos, or both?
- Should SAML be deferred until after one real OIDC tenant is onboarded, or built immediately for procurement demos?
- Should SCIM be mandatory before staff JIT creation is enabled in production?
- Should break-glass reason capture be required at login time, at first sensitive action, or both?
- What exact IdP group naming convention should VH Health recommend to hospitals so mappings are predictable without becoming globally assumed?
- Should tenant IdP metadata refresh be purely on-demand, scheduled, or both?
- Should platform SUPER_ADMIN SSO be limited to a VH Health-owned IdP even when tenant admins use their hospital IdP?
