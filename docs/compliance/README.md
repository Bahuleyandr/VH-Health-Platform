# VH Health Platform — Compliance Package Index

**Created:** 2026-06-13  
**Workstream:** WS7 — Compliance & Certification (S-Tier Roadmap)  
**Status:** Audit-ready documentation packages. External engagements are `[flagged: procurement]`.

This directory holds the four certification-ready packages produced under WS7.
Each package contains: (1) requirement catalogue, (2) control-to-evidence mapping
citing real source files and migrations, (3) a gap register with severity and
owner placeholder, and (4) clearly marked `[flagged: procurement]` lines for the
external engagement.

No external engagement is assumed to have started. All internal evidence cited
reflects the state of `main` as of 2026-06-13 after WS0/WS1 completion.

---

## Packages

| File | Framework | External engagement |
|---|---|---|
| [`B7.1-ABDM.md`](B7.1-ABDM.md) | Ayushman Bharat Digital Mission — M1/M2/M3 certification readiness | `[flagged: procurement]` ABDM sandbox credentials + empanelment |
| [`B7.2-NABH.md`](B7.2-NABH.md) | NABH hospital accreditation — digital/EMR-relevant chapters | `[flagged: procurement]` NABH assessor engagement |
| [`B7.3-DPDP.md`](B7.3-DPDP.md) | Digital Personal Data Protection Act 2023 — data-fiduciary obligations | `[flagged: procurement]` external DPDP audit |
| [`B7.4-PENTEST.md`](B7.4-PENTEST.md) | Penetration test readiness — scope, threat model, RoE, remediation SLA | `[flagged: procurement]` external pen-test firm engagement |

---

## How to use these documents

**For operators:** Each gap register lists open items with severity (Critical /
High / Medium / Low) and an owner placeholder (`[ASSIGN]`). Assign a named owner
before any real-patient PHI is accepted.

**For auditors/assessors:** The control-to-evidence mappings cite specific source
files (e.g., `apps/backend/src/utils/fieldEncryption.js`) and migration numbers
(e.g., `migration 075`, `migration 282`). These are the primary audit artefacts;
code review against those files is the verification step.

**For the compliance team:** The `[flagged: procurement]` items require commercial
or government engagement. No code or config changes are pending on those items
(the platform side is ready); only the external contract/registration is gated.

---

## Consolidated `[flagged: procurement]` list

| Item | Package | Why flagged | Rough lead time |
|---|---|---|---|
| ABDM sandbox credentials (`ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET`) | B7.1 | Owner-side NHA registration required | Weeks |
| ABDM bridge registration (HIP/HIU) | B7.1 | Owner-side NHA action | Weeks |
| ABDM M1/M2/M3 certification suites (with NHA observers) | B7.1 | Government-empanelled test run | Weeks–months |
| NABH assessor engagement | B7.2 | Empanelled NABH assessor required | Months |
| DPDP external audit / Data Protection Board registration | B7.3 | External auditor + regulatory registration once Rules in force | Weeks (audit) + variable (regulatory) |
| External penetration test (empanelled firm, CERT-In preferred) | B7.4 | Third-party technical audit required | 2–6 weeks |

---

## Related docs

- [`docs/ABDM_READINESS.md`](../ABDM_READINESS.md) — ABDM technical preflight (companion to B7.1)
- [`docs/PENTEST_READINESS.md`](../PENTEST_READINESS.md) — Existing pen-test pack (superseded/extended by B7.4)
- [`docs/SECURITY_CONTROLS_SELFASSESSMENT.md`](../SECURITY_CONTROLS_SELFASSESSMENT.md) — Self-assessment status register
- [`docs/india-deployment-readiness.md`](../india-deployment-readiness.md) — Go-live operator checklist
- [`docs/PLATFORM_AUDIT_2026-06-13.md`](../PLATFORM_AUDIT_2026-06-13.md) — Source audit (read-only)
- [`docs/S_TIER_ROADMAP.md`](../archive/S_TIER_ROADMAP.md) — Roadmap and batch definitions (read-only)
