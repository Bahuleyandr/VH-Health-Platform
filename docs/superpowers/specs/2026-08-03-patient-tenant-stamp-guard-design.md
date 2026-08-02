# Per-tenant build stamp guard — design

**Date:** 2026-08-03
**Branch:** `fix/patient-tenant-stamp-guard`
**Baseline:** `github/main` at `4c2d6abd3`
**Scope:** build/release config + a client guard + tests. No change to C-D12 outage
semantics or the C2.2 readiness contract.

## 1. The hazard

`TenantConfig.id` (`packages/vhhealth_core/lib/config/tenant_config.dart:23-26`) is a
build-time constant defaulting to `00000000-0000-4000-8000-000000000001`, which equals
the backend's `DEFAULT_TENANT_ID` (`apps/backend/src/services/tenant/tenantService.js:10`).
An unstamped build therefore agrees with the backend by construction.

The C-D12 readiness adapters compare the server's readiness `tenantId` against
`TenantConfig.id`:

- patient: `apps/patient/lib/core/outage/patient_outage_controller.dart:463`
- staff: `packages/vhhealth_core/lib/services/client_readiness_service.dart:270`

both via `ClientReadiness.isReadyForTenant()`
(`packages/vhhealth_core/lib/models/client_readiness.dart:169`, a strict `==`).

The backend derives the real tenant from the request Host / JWT, never from a client
header. So if `VH_BASE_URL` is repointed at a per-tenant deployment without a matching
`VH_TENANT_ID`, `isReadyForTenant()` fails on the tenant comparison, the adapter enters
outage, and per C-D12 §5.3 only two matching readiness *successes* can reopen it — the
outage is permanent. The default-deny mutation gate then refuses every hospital-facing
write including SOS, while displaying "Hospital systems are temporarily unavailable"
against a healthy backend.

This is the defect class PR #707 fixed (there the trigger was an RBAC 403).

Neither `.github/workflows/release-patient.yml` nor `release-staff.yml` stamps any
`VH_TENANT*` define today (grep count 0 in both).

## 2. Measured constraint — the empty-define trap

`String.fromEnvironment(k, defaultValue: d)` returns the **default** when the define is
absent, but returns the **empty string** when the define is present-but-empty. Measured
on this toolchain:

```
no define at all        -> value=[DEFAULT-UUID]  isEmpty=false
--define=VH_TENANT_ID=  -> value=[]              isEmpty=true
--define=VH_TENANT_ID=x -> value=[x]             isEmpty=false
```

`--dart-define=VH_TENANT_ID="${{ vars.VH_TENANT_ID }}"` with an unset repo variable
produces exactly the middle case. Naive unconditional stamping would set
`TenantConfig.id = ''`, which matches no tenant, putting **every** build — including the
default one — into the permanent outage. Unconditional stamping is therefore rejected.

## 3. Decision

Two layers. Neither alone closes the hazard: CI cannot constrain a local
`flutter build apk`, and a client guard gives the operator no signal until the binary
runs.

### 3.1 Client guard — `TenantConfig.verifyOrThrow()`

Throws only on configurations that are *definitionally* broken, so no legitimate build
can trip it:

| slug | id | Verdict |
|---|---|---|
| `''` | default UUID | pass (default / dev build) |
| `acme` | non-default UUID | pass (correct per-tenant build) |
| any | empty or not a UUID | **throw** — the empty-define trap |
| `acme` | default UUID | **throw** — `isDefaultTenant => slug.isEmpty` makes this a contradiction |

Deliberately **excluded** from the throw: any check tying the `VH_BASE_URL` host to the
slug. A single-tenant hospital on its own domain would false-positive, and blocking a
legitimate launch is worse than the bug being fixed. That check belongs in CI, where the
operator owns the naming convention.

Wired into both apps beside the existing live precedent `SecurityConfig.verifyOrWarn()`
(`apps/patient/lib/main.dart:67`, `apps/staff/lib/main.dart:128`), which already throws
in production on misconfiguration.

Note: `ClientReadinessConfig.verifyOrThrow()` exists but is **never called in production**
(only unit-tested). This design does not rely on it; wiring that one up is out of scope
and recorded as a follow-up.

### 3.2 CI guard — conditional stamping

In `release-patient.yml`, `release-staff.yml` and both `.forgejo` mirrors: append
`--dart-define=VH_TENANT_ID` / `VH_TENANT_SLUG` **only when the corresponding variable is
non-empty**, so an unset variable leaves the define absent and `TenantConfig` falls back
to its safe default. A precheck step fails the build early when the pair is incoherent.

## 4. Testing

Unit tests in `packages/vhhealth_core/test/` pin every row of the §3.1 table via the
injectable-parameter form of `verifyOrThrow` (the same seam
`ClientReadinessConfig.verifyOrThrow` already uses for testability), because
`String.fromEnvironment` cannot be varied within a single test process.

## 5. Out of scope

- C-D12 outage semantics and the C2.2 readiness contract.
- Wiring the pre-existing dead `ClientReadinessConfig.verifyOrThrow()`.
- Any backend change.
