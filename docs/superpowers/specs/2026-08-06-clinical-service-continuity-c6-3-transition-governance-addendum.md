# Clinical Service Continuity C6.3-TG Transition-Governance Addendum

**Status:** owner-approved transition re-scope implemented activation-inert
**Authority:** C-D11, countersigned by Dr Bahuleyan S on 2026-08-04; C6.3-TG
re-scope countersigned 2026-08-06
**Adds to:**
[`2026-07-28-clinical-service-continuity-design.md`](2026-07-28-clinical-service-continuity-design.md)

This addendum records the C6.3 ruling without editing the merged design. It
governs how the existing signed facility policy may cross an activation state;
it does not publish a policy, name a roster identity, supply drill evidence,
deploy, release, activate, or widen any capability.

## 1. Section 6.7 is superseded by the merged substrate

The standalone `clinical_continuity_facility_activations` projection and its
separate sub-facility cohort key are **SUPERSEDED-BY-SUBSTRATE**. The one
authoritative current projection remains the signed
`clinical_continuity_policy_versions` row for the exact `(tenant_id,
facility_id)` already read by both server and client.

The C6.3 state mapping is:

| C6.3 state | Existing signed-policy representation |
| --- | --- |
| `off` | No `lifecycle_state = 'active'` row for the tenant and facility. |
| `shadow` | The active row has `actionRegistry.activation.mode = 'shadow'` and an empty `enforcedActionIds`. |
| `active` | The active row has `actionRegistry.activation.mode = 'enforce'` and the exact non-empty `enforcedActionIds`. |

Facility-wide shadow therefore remains compatible with action-by-action
enforcement. There is no second activation flag, projection, tenant-wide
switch, or independently mutable cohort record.

## 2. C-D11 disagreement rule

The governing disagreement rule is retained verbatim:

> Moving a cohort from shadow to enforcement requires two keys: the accountable clinical owner and one operational or technical lead must both agree. Rolling back requires only one voice — any person holding a listed sign-off role, including the affected unit's clinical lead, may stop an activation alone. Advancing is deliberately harder than halting.

C6.3-TG makes that rule mechanically provable:

- an advance intent is recorded by one authenticated roster identity and is
  inert until a distinct authenticated identity holding the complementary
  clinical or technical roster key countersigns the same target and expected
  state fingerprint;
- a listed rollback sign-off identity or affected-unit clinical lead may halt
  alone, including without a caller-supplied justification; the command
  retires the current active policy and restores absence-means-`off`;
- direct `approved -> active` and `active -> retired` policy updates are
  rejected unless bound to the applied transition event in the same
  transaction.

## 3. Evidence-gate computation

Entering facility-wide shadow uses the two-key command but does not pretend the
shadow-duration gate has already elapsed. Leaving shadow, and every later
strict widening of the enforced action-ID set, additionally binds an immutable
per-facility evidence-gate version.

The database floor is conjunctive and cannot be configured lower:

- at least 14 elapsed days since the applied `off -> shadow` event; **and**
- at least one clean planned downtime-drill record proving continuity packs
  verified, paper path exercised, captured work reconciled, and zero unresolved
  items.

Elapsed time alone is never sufficient. A later gate version may require more
days or more clean drill records, but never fewer.

## 4. Empty-by-default authority

Migration
[`632_clinical_continuity_activation_transition_governance.sql`](../../../apps/backend/src/migrations/632_clinical_continuity_activation_transition_governance.sql)
creates the append-only transition ledger, append-only key roster, and
versioned evidence-gate configuration with composite tenant/facility
integrity, `ENABLE` plus `FORCE ROW LEVEL SECURITY`, restrictive explicit
tenant context, and runtime `SELECT` plus narrow command execution only.

The roster and per-facility evidence-gate configuration ship empty. Empty
roster means no advance intent or halt can be authorized; absent evidence-gate
configuration means shadow cannot advance to enforcement. Phase H must name
exact identities and exact evidence through a later owner-audited change.
