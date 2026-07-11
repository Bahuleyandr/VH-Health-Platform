# Audit Remediation — Sol Ultra / Codex 2026-07-11 (Implementation Plan)

> **For agentic workers:** each workstream (WS) is executed with `superpowers:test-driven-development` — a RED test proving the vuln (or a static-scan guard), then the GREEN fix, then eslint. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remediate all 38 canonical findings + ~13 Wave-E delta findings from the 2026-07-11 Sol Ultra / Codex security audit of the VH Health backend.

**Architecture:** Fix highest-leverage systemic classes first (server-owned context, patient-relationship guards), then per-cluster. Landed on branch `fix/audit-remediation-2026-07-11-solultra`.

**Posture lens (verified at HEAD `fa390ddb`, `infra/kubernetes/apps/backend/configmap.yaml`):** `AUTH_ENFORCE_TENANT_RLS=true` (RLS on), `ALLOW_DEFAULT_TENANT=true` (single-tenant → cross-tenant findings LATENT), `CARE_TEAM_ENFORCEMENT_MODE` unset → `shadow` (patient-relationship bypasses LIVE intra-tenant). Full triage + finding→file map: memory `project_vh_health_audit_2026-07-11_solultra`; audit bundle under `%TEMP%/codex-security-scans-3ve1FJ/.../2e4a07a8..._7fj97iz0/`.

---

## WS1 — Server-owned context wins over request body  ✅ DONE (commit 2b35c636c)

Systemic finding (LD-RRB-01, NICU/PICU, ambulance): `{ tenantId, actorUid, ...req.body }` let the body override server-derived tenant/actor/route-param ids.

- [x] Static-scan guard `tests/unit/server-context-body-override-guard.test.js` (RED: 119 offenders).
- [x] AST codemod moved `...req.body` to front of 117 object literals across 21 route files; server fields now assigned last and win.
- [x] eslint --fix clean; guardrail GREEN.

## WS2 — Clinical patient-relationship & actor/signer authority  ▶ IN PROGRESS
Findings #2 SMART cross-patient write, #3 prescriber doctor_id-from-body, #8 TPA-enhancement, #9/#12 OR-board (no guard), #11 PATIENT-role bulk-Rx, #13 pharmacy-order owner, #38 Tier-C AI unscoped; Wave-E caller-asserted signer (LD-RRB-02 resus record forgery, LD-RRB-03 radiation gate default-off, LD-RRB-05 burn signatures, LD-RRB-07 radiation delivery/approval, NICU score/verify forgery, ambulance H1/H2/H3).
- [x] #9/#12 added `patientAccessGuard('OPERATING_THEATRE',{careTeamModeGoverned})` + `phiAccessLogger` to the `orBoardRoutes` mount (commit a25c511a1). Residual: actor-bind scheduleSurgery (spoofable audit) — still TODO.
- [x] #11 split `/prescriptions/all` onto staff-only `ePrescriptionListAllRoutes` (no PATIENT) + regression guard (commit a25c511a1).
- [x] #13 pharmacy-order ownership gate via `callerMayAccessPrescription` (commit f4c729138). ★ Did NOT add the signed/locked gate — walk-in OPD orders from an unsigned Rx (existing flow; would break prescription-deep + real OPD).
- [ ] #3 prescriber `doctor_id`-from-body — ⚠ nuanced: ePrescriptionCreateRoutes includes non-doctor creators (ADMIN); naive `doctorId=actorId` breaks assisted prescribing. Sharp part = run controlled-drug privilege on the AUTHENTICATED actor, not the body doctor; model on-behalf-of as an explicit delegation. Needs care.
- [ ] #2 SMART · #8 TPA-enh · #38 Tier-C AI · HR #30/#36 · Wave-E signer authority — pending.
- [ ] #3 derive prescriber from `req.user` for DOCTOR; controlled-drug privilege evaluated on authenticated actor.
- [ ] #13 verify pharmacy-order prescription belongs to the ordering patient.
- [ ] #2 reject conflicting SMART `?patient=` vs body `subject.reference`; bind write patient to the token context.
- [ ] #8 patient/admission relationship guard on admissionEnhancementRoutes.
- [ ] #38 tenant + patient-relationship predicate on Tier-C clinical-AI PHI reads.
- [ ] Wave-E: derive signer/reviewer/approver/administered_by from authenticated actor; radiation privilege gate mandatory when tenant enables radiation; ambulance recorded_by/accepted_by/verified_by from req.user.

## WS3 — Insurance/billing object-graph binding
Findings #1 claim, #4 policy, #15 preauth, #16 revenue-cycle 837. Validate referenced policy/preauth/admission/parent belong to same tenant+patient before INSERT; add tenant predicates to revenue-cycle queries + 837 export.

## WS4 — Compliance breach registry tenant scoping  ⚠ NEEDS DECISION + MIGRATION
Findings #6 enumeration, #14 lifecycle tampering. ★ Verified: `data_breaches` has NO `tenant_id` column — every query in `breachService.js` is global, and `notifyAdminsOfBreach` selects ALL ADMIN/SUPER_ADMIN. Proper fix needs a **migration** (add `tenant_id` + RLS + backfill) + threading tenantId through 8 service fns + routes, AND a **tenancy-model decision**: is the breach registry (a) per-tenant (each tenant's compliance officer manages their own — needs tenant_id scoping) or (b) a platform-level registry only SUPER_ADMIN touches (restrict the mount, no migration)? Under single-tenant this is LATENT. Do NOT blind-restrict the mount to SUPER_ADMIN — may lock the current operating admin out of legitimate breach management.

## WS5 — HR approval authorization
Findings #30 replacement final approval, #36 overtime approval. Require HR/manager capability (not any staff) for final approve/reject.

## WS6 — Auth/session hardening  ▶ IN PROGRESS
Findings #17 refresh-as-access (token-kind claim check), #19 partial logout (revoke both tokens), #21 SUPER_ADMIN MFA first-enroll replay (single-use setup state), #27 OTP/PIN bypass session tracking, #29 Redis-miss bypasses durable revocation (fail-closed to DB).
- [x] #17 jwtMiddleware rejects `type:'refresh'` as an access bearer (commit d4e61e76a).
- [x] #19 logout calls `revokeAllUserTokens(uid)` — sibling refresh revoked too (tradeoff: all-session logout). 
- [ ] #21 MFA first-enroll replay · #27 OTP/PIN session tracking · #29 Redis-miss fail-closed.

## WS7 — SCIM cross-provider ownership  (#5)
Bind SCIM create/replace to the authenticated provider; reject taking over an identity owned by another provider/externalId.

## WS8 — Integration trust: ABDM/HL7/consent/SSRF/device  ▶ IN PROGRESS
Findings #18 ABDM legacy secret (CAN-007 residual), #23 HL7 legacy secret (CAN-021 residual), #33 consent-field binding, #31/#35 SSRF IP-literal/IPv6-hex (CAN-027 residual), #25 MLLP frame cap, #34 device cleartext (TLS), #37 control-ID DoS, #26 downtime dedicated token (CAN-054, doc/set). Legacy-secret paths latent under single-tenant — add tenant-equality on per-tenant-secret path + document the deliberate legacy path.
- [x] #35 SSRF hex IPv4-mapped IPv6 bypass fixed in `ssrfGuard.js` (commit d4e61e76a).
- [ ] #31 IP-literal redirect · #18/#23 legacy-secret tenant-equality · #33 consent-field binding · #25/#34/#37 device gateway · #26 downtime token.

## WS9 — Supply-chain / CI-CD
Findings #7 release tag bypasses main review, #20 mutable-tag digest rebind, #22 ArgoCD project cluster-RBAC, #24 Forgejo actions signing-key exposure, #28 image-name/namespace verify bypass, #32 Kyverno audit-mode. Gate release on main-ancestry; immutable digest pin; tighten Argo project; scope action secrets; Kyverno enforce.

## WS10 — Latent cross-tenant defense-in-depth sweep
Before the multi-tenant cutover (`ALLOW_DEFAULT_TENANT=false`): the tenant-override half of WS1 is now closed; sweep remaining tenant predicates flagged latent.

---

## Known / by-design (cross-referenced, not re-litigated)
- #10 care-team shadow fail-open = **CAN-011 / HEAD-001**, the staged operator enforce-flip (see `project_vh_health_careteam_enforce_oracle`). Flipping it is necessary but NOT sufficient — WS2 items (OR-board no-guard, #3 body-identity, #11 RBAC, breach registry, `no_patient_context` collection routes) still need code fixes.
