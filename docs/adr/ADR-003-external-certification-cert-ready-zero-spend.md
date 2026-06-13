# ADR-003 — External Certification (ABDM/NABH/DPDP/Pen-Test): Cert-Ready at Zero-Spend

**Date:** 2026-06-13
**Status:** Accepted
**Deciders:** Platform lead (Bahuleyandr)
**Source:** `docs/S_TIER_ROADMAP.md` — §1 (flagged column), §2 S-tier scorecard; `docs/PLATFORM_AUDIT_2026-06-13.md`

---

## Context

S-tier for a clinical platform requires external certification across four domains:

| Certification | What it covers | Cost model |
|---|---|---|
| **ABDM** | Ayushman Bharat Digital Mission — FHIR/API conformance + HIE interoperability | Government engagement + conformance harness run |
| **NABH** | National Accreditation Board for Hospitals — clinical quality indicators + evidence pack | Assessment by external NABH assessor |
| **DPDP** | Digital Personal Data Protection Act (India, 2023) | External audit of data handling, consent, retention, deletion |
| **Pen-test** | Third-party penetration test of the deployed platform | Commercial engagement, typically INR 2–5 L |

All four require lead times of weeks to months (assessor availability, credential provisioning,
government API access). None can be rushed to 2026-06-30. The original internal plan did not
account for this lead-time gap.

Two options were considered:

1. **Block the S-tier milestone on external certs** — defer declaring S-tier until all four
   external engagements are complete. Target: Q3–Q4 2026, lead-time bound.
2. **Two-declaration model** — declare "Internal A+/S" by 2026-06-30 (all in-our-control
   work complete, code cert-ready) and "Externally-certified S" when the external
   engagements clear (lead-time bound, not blocked by code).

## Decision

**Option 2: two-declaration model.**

All code and configuration work is completed by 2026-06-30:
- ABDM: FHIR conformance harness integrated in CI; ABDM tables, consent, and API credential
  placeholders fully documented. Cert-ready code shipped; M1/M2/M3 certification requires
  government API credentials and submission — flagged.
- NABH: indicator pack complete, evidence export pipeline complete. External assessment
  requires NABH assessor engagement — flagged.
- DPDP: data-handling artifacts, consent management, right-to-erasure, audit dashboards
  complete. External audit requires engagement — flagged.
- Pen-test: self-SAST (Semgrep, Trivy), DAST baseline, and `docs/PENTEST_READINESS.md`
  complete. Third-party engagement requires commercial spend — flagged.

Flagged items are packaged as "operator actions" in the S-tier roadmap, not code blockers.

## Consequences

**Positive:**
- The internal team is not blocked waiting for external scheduling.
- All code work is completed on schedule; the external-cert path is well-documented
  and ready for the operator to initiate.
- Cost is zero until the operator decides to engage external parties.
- `docs/PENTEST_READINESS.md` and `docs/SECURITY_CONTROLS_SELFASSESSMENT.md` provide
  the evidence pack for any assessor.

**Negative / risks:**
- "Externally-certified S" may slip to Q4 2026 or beyond if engagements are slow to schedule.
  Mitigation: operator actions are explicit and time-estimate flagged in the roadmap.
- Self-attestation (SAST/DAST) is not equivalent to a third-party pen-test for regulatory
  purposes. The platform should not be marketed as "pen-test certified" until the external
  engagement completes.

**Flagged items (operator must initiate, not code work):**
- ABDM M1/M2/M3 certification submission.
- NABH external assessor engagement.
- DPDP external audit engagement.
- Third-party penetration test commercial contract.
- GPU node procurement for deep-tier AI (manifests ready; hardware spend pending).
- Commercial drug-KB license (Medi-Span/FDB) — open CIMS/CDSCO data is interim.
- eSign provider contract (DSC/eSign India).
- Stage-1 AI ward pilot approval (real doctor, 1 week of real use).
