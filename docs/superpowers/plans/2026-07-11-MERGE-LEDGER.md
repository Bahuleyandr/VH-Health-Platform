# Sol Ultra Audit Remediation — Merge Ledger & Pending-Work Handoff

**For the merging agent.** This branch remediates the 2026-07-11 Sol Ultra / Codex
security audit of VH Health. It is ready to merge. This ledger says what to merge,
how, and hands off the pending items with enough context to finish them.

- **PR:** #555 — https://github.com/Bahuleyandr/VH-Health-Platform/pull/555
- **Branch:** `fix/audit-remediation-2026-07-11-solultra` (off `main`)
- **Head:** `dbdf957` — clean tree, fully pushed to `github`.
- **Contents:** 36 commits = **29 `fix(security)`** + 7 docs/tracker.
- **Scope:** **33 audit findings + 1 systemic sweep**, every one with a RED→GREEN
  or regression test + eslint-clean. Covers the entire LIVE clinical-integrity /
  patient-authorization / auth-session / SSRF / device-gateway / insurance-graph /
  Wave-E signer set.
- **Deeper background:** tracker `docs/superpowers/plans/2026-07-11-audit-remediation-solultra.md`;
  agent memory `project_vh_health_audit_2026-07-11_solultra`; audit bundle under
  `%TEMP%/codex-security-scans-3ve1FJ/VH-Health-Platform/2e4a07a8..._7fj97iz0/`.

---

## 1. How to merge

1. **CI:** watch the PR's **`lint-and-test / Backend lint + static checks`** job
   plus the three **`lint-and-test / Backend tests (shard k/3)`** jobs (the old
   single `Backend lint + test` job was split 2026-07-17; all four together are
   the meaningful gate for the 21-file route sweep). ⚠ Per project CI lore: the
   *canonical* backend suite is flaky and `gh run watch --exit-status` LIES —
   re-query `gh pr checks 555` rather than trusting a single watch exit. Semgrep /
   secret-scans / dependency-review should be green.
2. **Acceptance signal beyond CI:** four permanent static guards + the RED→GREEN
   tests below are the regression net. If CI's Postgres suite is flaky, the fixes
   are still independently proven by the per-commit tests.
3. **Merge:** `--no-ff` into `main` (the repo convention), then push `main` to
   **both** remotes: `github` and `origin` (Forgejo `forgejo.hippocampus-monitor.ts.net`).
   Then delete the feature branch on both remotes + local.
4. **Deploy is separate.** Merging ≠ deploy — this repo ships GitOps-via-ArgoCD off
   pinned image digests. None of these fixes reach prod until images are
   built/tagged and the digest pins bumped. So merging is safe (no auto-deploy of
   app code from a plain `main` push).

## 2. Deployment posture (why severities look the way they do)

Verified at HEAD from `infra/kubernetes/apps/backend/configmap.yaml`:
- `AUTH_ENFORCE_TENANT_RLS="true"` — Postgres RLS on.
- `ALLOW_DEFAULT_TENANT="true"` — **still single-tenant** ⇒ pure cross-tenant
  findings are *latent* until the multi-tenant cutover.
- `CARE_TEAM_ENFORCEMENT_MODE` unset ⇒ **`shadow`** — care-team guards LOG but don't
  BLOCK. So the patient-relationship guards added here are wired + audited now and
  become enforcing when the operator flips care-team to `enforce` (the known
  **CAN-011** staged flip; see `project_vh_health_careteam_enforce_oracle`).

## 3. DONE — what this PR merges (33 findings + systemic)

### Systemic
| Fix | Commit | Test |
|---|---|---|
| Server-owned context wins over `...req.body` — 117 object-literal reorders / 21 route files (tenant/actor/route-param could be body-overridden) + permanent guard | `2b35c636c` | `tests/unit/server-context-body-override-guard.test.js` |

### Clinical patient-authorization
| # | Fix | Commit |
|---|---|---|
| #9/#12 | OR-board mount got `patientAccessGuard` + PHI logger | `a25c511a1` |
| #11 | `/prescriptions/all` split to a staff-only RBAC key (was PATIENT-reachable) | `a25c511a1` |
| #13 | pharmacy-order ownership gate (`callerMayAccessPrescription`) | `f4c729138` |
| #2 | FHIR write binds to the body patient + rejects conflicting SMART `?patient=` | `212a7f520` |
| #8 | TPA-enhancement mount → `patientAccessGuardForResource('admission')` | `fca225f54` |
| #3 | controlled-substance privilege also asserted on the authenticated actor | `3ebaac0fc` |

### Auth / session
| # | Fix | Commit |
|---|---|---|
| #17 | jwtMiddleware rejects `type:'refresh'` as an access bearer | `d4e61e76a` |
| #19 | logout `revokeAllUserTokens` (sibling refresh revoked too) | `e4e70cb46` |
| #21 | atomic MFA first-enrollment (`updateMany WHERE totp_enabled=false`) | `374016d5b` |
| #29 | Redis blacklist *miss* falls through to Postgres (positive cache only) | `89ece1313` |
| #5 | SCIM lookups filter by provider ownership (not just ORDER BY) | `7f3da8688` |

### Compliance / HR / SSRF / device / insurance
| # | Fix | Commit |
|---|---|---|
| #30/#36 | HR overtime/replacement approval gated `STAFF_LEAVE_WRITE` | `c3a34b2dd` |
| #35 | SSRF guard decodes hex IPv4-mapped IPv6 / NAT64 | `d4e61e76a` |
| #31 | `safeFetch` re-validates every redirect hop (manual redirects) | `7e7868e8b` |
| #25 | device-gateway MLLP frame bounded (1 MiB) + socket destroy | `b6b0f1947` |
| #37 | device-gateway control-id dedup after auth + bounded map | `8fa9ea6a3` |
| #1/#15 | claim/preauth referenced policy/preauth/admission/parent bound to tenant+patient | `711f3f929` |
| #4 | direct `payer_id`/`tpa_id` verified in-tenant | `82fa5276a` |
| #7 | release workflow gated on main-containment before build/sign/pin | `9aba08b0a` |

### Wave-E delta findings (newest clinical modules)
| Finding | Fix | Commit |
|---|---|---|
| LD-RRB-02 | resuscitation signatures + QA sign-off bound to authenticated actor | `8014a483b` |
| LD-RRB-02 (Med) | `/events/:id` detail read patient-scoped (new `resuscitation_event` resolver) | `dbdf95712` |
| LD-RRB-05 | burn chart created draft/active only (no caller-forged signoff on create) | `3e57ff703` |
| LD-RRB-07 | radiation plan-approval + administration attributed to authenticated actor | `164eed740` |
| LD-RRB-06 | radiation nuclear-order referral bound to the same patient | `097cf9d7f` |
| LD-RRB-04 | ICU/NICU command-board chart gated to clinical roles (`isClinical||isLeadership`) | `3fa1d273b` |
| NICU signer | NICU score definition/review approver+reviewer bound to actor | `08eaa0d90` |
| NICU gov | NICU governance writes gated `requireGovernanceAuthority` | `33f713724` |
| ambulance-H2 | handover recorder/accepter/verifier from `req.user`, not body | `e8c1fbaf7` |
| ambulance-H3 | handover patient = ambulance request's patient | `9b5ab3b09` |
| ambulance-H1 | handover routes resolve handover→patient for the care-team guard | `650f503c4` |

**Permanent static guards added (regression nets):**
`server-context-body-override-guard.test.js`, `prescriptionListAllRbac.test.js`,
`hrApprovalGuard.test.js`, `nicuGovernanceGuard.test.js` — plus the existing
`wrapAutoRBAC-noop-guard.test.js`.

**Local test command (single test, skips the npm pretest):**
`cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js <path> --runInBand`
(deep tests need the QA cluster at `127.0.0.1:55432`: `node apps/backend/scripts/qa-cluster-up.mjs`).

---

## 4. PENDING — code items (NOT in this PR). Each has a specific reason it was held.

> Do these in a **fresh session with the QA cluster up** and full deep-test runs —
> they are mechanical but need real verification, not context-limit haste.

### #27 — OTP/PIN login tokens bypass active-session tracking (Medium)
- **What:** patient OTP + staff PIN + `directOtpLogin` mint access tokens via direct
  `generateToken()` instead of `issueAccessTokenAndClaimSession()`, so those jti's
  aren't registered in active-session tracking (not centrally revocable/replaceable).
- **Why held:** it touches **4 login methods** — a wrong `userUid`/`req`/`deviceType`
  breaks patient/staff login, and login can't be safely deep-tested at a context limit.
- **Approach:** swap each direct `generateToken({payload})` for
  `issueAccessTokenAndClaimSession({ userUid:String(payload.uid), tokenPayload:payload, req, deviceType })`
  in `authService.js` (call sites ~150, ~198, ~614, ~1191, ~1402) + `staffAuthService.staffLogin`.
  Thread `req`/`deviceType` through method+route signatures where missing. The helper
  is a clean wrapper (already used at `authService.js:399` and `:1037`). Add a
  negative test to `authServiceCoverage.test.js` asserting the session is claimed.
- **Mitigation today:** the DB blacklist + #19 revoke-all-on-logout already provide revocation.

### #38 Tier-C AI + #16 revenue-cycle — tenant-predicate sweeps (Medium, LATENT)
- **What:** `services/ai/tierCAssistantsService.js` (~9 queries) and
  `routes/billing/revenueCycleRoutes.js` (~12 queries) select PHI by id/patient_uid
  without a `tenant_id` predicate.
- **Why held:** **RLS-mitigated** — prod's `tenantRlsMiddleware` auto-scopes these
  plain `$queryRawUnsafe` reads, so it's latent defense-in-depth. And the param
  arrays are *shared* between entry and child queries, so a blind `AND tenant_id=$N`
  add risks a `42P08/42P18` param bug.
- **Approach (#38):** add `AND tenant_id = $N::uuid` + thread `tenantId` to the ENTRY
  queries — `admissions WHERE id` (lines ~94/138/614/676), `prescriptions WHERE id`
  (~366), `patient_uid` reads (~454/489/565/573). Child `admission_id` queries are
  transitively safe once the admission-by-id entry is scoped (the fn throws notFound
  first). Two-tenant deep test. Do before the multi-tenant cutover.

### #33 — ABDM consent artefact not bound to persisted fields (Medium, LATENT)
- **What:** `_verifyConsentArtefact` verifies a signature but `handleConsentRequest`
  persists authorization-critical values from the (unverified) outer wrapper.
- **Why held:** complex ~10-field crypto-protocol binding, and **ABDM is disabled in
  prod** (no live impact).
- **Approach:** make the verified payload authoritative; bind wrapper↔verified for
  consent id / ABHA / HIP / HIU / purpose / HI-types / date-range / expiry / CM id;
  reject mismatch (`ABDM_CONSENT_BINDING_MISMATCH`); persist an artefact hash for
  reuse detection. Files: `services/abdm/abdmService.js` (~335/403/423/427/476),
  `routes/abdm/abdmRoutes.js`.

### #20 — mutable-tag digest rebind (Medium)
- **What:** `scripts/update-prod-digests.mjs` re-resolves a mutable tag to a digest
  (rollback to any previously-signed image).
- **Why held:** build tooling — only verifiable in a real CI run.
- **Approach:** pin by the immutable digest emitted by the build job; verify the
  pinned digest matches the just-built one; refuse a digest not from this release.

---

## 5. PENDING — SIGN-OFF group (needs a human decision; do NOT blind-merge)

> These **auto-sync to the cluster on merge** (ArgoCD) or change prod enforcement.
> Do them on a **separate branch validated in staging**, not on this PR.

| Item | Decision / risk |
|---|---|
| **#6/#14** breach registry | `data_breaches` has NO `tenant_id`. Decide the model: **per-tenant** (migration + tenant_id scoping) vs **platform-only** (SUPER_ADMIN restriction). Then implement. Latent under single-tenant. |
| **LD-RRB-03** radiation privilege gate | Gate defaults fail-*open* (any role can administer radioisotopes). Flipping closed **over-blocks all administration until the owner-supplied privilege is credentialed** — CAN-011 class. Stage: seed credentials → enable `RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED`. |
| **#32** Kyverno Audit→Enforce | Starts BLOCKING unsigned images — verify every prod image is cosign-signed first. |
| **#28** Kyverno image match | Broaden the policy image match (repo/namespace bypass). Safe-ish but verify coverage. |
| **#22** ArgoCD project | Tighten `sourceRepos`/`clusterResourceWhitelist` — over-tightening breaks sync. |
| **#34** device-gateway TLS | Cleartext HTTP inside the cluster VLAN → wrap in TLS/mTLS (deploy + gateway config). |

## 6. Operator / by-design (no code change)

- **#10** = **CAN-011** care-team `shadow`→`enforce` — the staged operator flip (see
  `project_vh_health_careteam_enforce_oracle`). Flipping it activates most of the
  patient-relationship guards this PR wired in shadow. NOT sufficient alone — the
  guards + RBAC here are needed too.
- **#18** ABDM legacy secret / **#23** HL7 legacy secret — the deliberately-retained
  legacy shared-secret paths (CAN-007 / CAN-021), latent under single-tenant.
- **#26** downtime token — set `DOWNTIME_ACCESS_TOKEN` in the prod secret (CAN-054).
- **#7/#24 tail** — repo settings: protect the `backend-v*`/`admin-v*`/`staff-web-v*`
  tag prefixes against force pushes; put the sign+pin steps behind a required-reviewer
  environment; scope the signing key. (The #7 workflow *code* gate is already in this PR.)

---

## 7. Coverage note
The scan declared partial coverage — follow-ups `COV-029` (some newly-added specialty
clinical modules were not full-read) and `COV-030` (lower-ranked exec/template/process
sinks). Worth a targeted re-scan of `apps/backend/src/routes/clinical` +
`services/clinical` after this merges.
