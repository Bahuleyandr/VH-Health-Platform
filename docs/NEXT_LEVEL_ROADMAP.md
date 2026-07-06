# VH Health — Next-Level Roadmap (Enterprise-Grade Program)

**Authored:** 2026-07-05 at `main` ~`65ee7b78`+. **Directive (owner):** build everything
required for an unbeatable, professional enterprise-grade hospital platform **before**
trials begin. YAGNI is suspended for this program — completeness beats minimalism.
This supersedes the "customer-pull / deferred-by-design" posture of
[`ROADMAP.md`](ROADMAP.md) §5–§6 for the items absorbed below.

**Scope split:** this document owns the **build** program (NL-1…NL-12).
[`ROADMAP.md`](ROADMAP.md) §§1–4 remain the authoritative **operator/go-live** track
(activation checklist, secret rotation, external engagements, procurement) — nothing
here replaces that. The prior engineering backlog (ROADMAP §0, Tier-0/1/2) is complete
except the T2 leftovers absorbed into §2 below.

**Standing clinical/product invariants (binding, do not regress):**
- In-hospital/IP notes are NEVER exposed to the patient app — only OP
  appointment-bound consultation notes (enforced in `patientPortalService.js`).
- Dictation/AI NEVER auto-submits or auto-saves clinical content — editors are
  filled, humans save; every existing save gate (CDS, composition checks, signoff,
  double-submit guards) stays load-bearing.
- Clinical AI stays decision-support-only, review-gated, per-tenant flagged;
  patient-facing generation stays off until the G2/G3 pilot evidence exists.
- Governed mode flips (care-team enforce, ledger authoritative,
  `ALLOW_DEFAULT_TENANT=false`) remain operator/evidence-gated — never code-flipped.

---

## 0. Verdict

The platform is an A-tier engineering artifact that no hospital can currently buy,
deploy, or trust at enterprise level. The clinical core (BCMA/MAR closed loop, CPOE,
offline-first writes, canonical timeline, governed AI, double-entry ledger,
multi-tenant RLS, typed contracts) exceeds the Indian mid-market and is credible
against global suites. What is missing is almost entirely the **enterprise shell**:
identity federation, the national claims rail, licensed clinical content, a migration
path off incumbent systems, certifications, the physical-hospital periphery
(devices, kiosks, donors, porters), and product packaging. This program closes that
shell.

## 1. Competitive positioning (2026 snapshot)

| Class | Representatives | We win on | They win on |
|---|---|---|---|
| India mid-market HIS | Insta by Practo, MocDoc, Ezovion, Attune, Birlamedisoft, NIC eHospital | Clinical depth (BCMA/CPOE/offline), engineering rigor, governed AI, audit posture | References, kiosk/queue networks, statutory register packs, early NHCX support, sales/support orgs |
| India premium / open | KareXpert, Bahmni-based | Same as above + typed contracts, tenancy | Device integration, working teleconsult, self-serve BI, multi-facility references |
| Global enterprise | Epic, Oracle Cerner, MEDITECH Expanse, InterSystems TrakCare | Modern stack, offline-first, India rails (ABDM/TPA/GST/UPI/5 languages), AI governance freshness, cost | Licensed content (order sets, FDB/Medi-Span DDI), device ecosystems, RCM depth, predictive-ops maturity, specialty suites, SMART app ecosystems, **proof at scale** |

The wedge: nobody in our price class has our clinical core; nobody buys the core
without the shell. Build the shell.

## 2. Open items inherited from the prior roadmap

- [ ] **T2 #2 Terminology spine** — absorbed into NL-5. (SNOMED-CT is free in India
      via NRCeS; LOINC free; ICD-11 free. Only the drug KB/DDI needs a license.)
- [ ] **T2 #6 Governed-AI remainder** — ~21 single-module wrappers + G2 ward pilot;
      pilot is operator-track, wrappers absorbed into NL-9/NL-6 where they fit.
- [ ] **T2 #7 White-label theming** — absorbed into NL-11.
- [ ] **T2 #10 Accessibility completion** — absorbed into NL-12.
- [ ] **T2 #11 SLSA-L3 finish** (verify-before-pin, Kyverno Enforce backstop,
      base-image digests) — absorbed into NL-12.
- [ ] **T2 #12 Zero-trust network / Cloudflare Access** — absorbed into NL-12.
- [ ] **§6 FHIR R4 writes + public SMART endpoints** — absorbed into NL-11.
- [ ] **§6 HL7 interface engine (Mirth-class)** — absorbed into NL-11.
- [ ] **§6 Provider credentialing & privileging** — absorbed into NL-6.
- [ ] **§6 NABH quality-indicator pack exporter** — absorbed into NL-12.
- [ ] **§6 eSign/DSC stack** — capture layer in NL-4; DSC provider remains
      procurement (ROADMAP §4).
- [ ] **§6 Scheduling-optimization depth** (provider templates, overbook, resource
      booking) — absorbed into NL-8.
- [ ] **§6 Outbreak/infection-control workbench depth** — absorbed into NL-6.
- [ ] **§6 Dental / ophthalmology / dialysis depth** — absorbed into NL-6.
- [x] §6 portal longitudinal lab trends — shipped (patient P2, PR #370).
- [x] §6 dependent proxy consent — shipped (patient P2, PR #372).
- [x] T2 #3 typed event bus — satisfied by the node-native outbox + WS fabric +
      `ws_broadcast_dropped_total` tripwire; revisit only if the tripwire fires.

## 3. Verified gap inventory

Every ✗ below was verified against the repo (grep/read), not assumed.

### A. Enterprise IT trust
- [ ] ✗ **SSO** — no SAML/OIDC anywhere; staff/admin auth is local JWT only.
- [ ] ✗ **SCIM** user provisioning/deprovisioning.
- [ ] ✗ SIEM export path (Loki 180d exists; no external SIEM feed).
- [ ] ✗ ISO 27001 / SOC 2 program; pen test never executed (package ready).
- [ ] ✗ **Legacy-HIS data-migration toolkit** — the single biggest sales blocker.
- [ ] ✗ End-user manuals, training mode, in-app tours, admin LMS.
- [ ] ✗ Cross-site DR replica story (single-cluster PITR only).
- [ ] ✗ License/entitlement packaging & enforcement (per-tenant module flags exist
      as the substrate; no commercial packaging layer).

### B. India money rails
- [ ] ◐ **NHCX** (National Health Claims Exchange) — P1 backend core exists
      and P2 claim cycle is in review behind `NHCX_ENABLED=false`: exchange
      envelope, tenant credentials, eligibility/preauth/claim FHIR builders,
      Task status checks, outbound dispatcher, callbacks, and mock exchange.
      Live version lock, sandbox enrolment, communications, payment notice, and
      tariff UI remain.
- [ ] ✗ Tariff / rate-card master admin UI (entities exist; no editor).
- [ ] ✗ Statutory register/report pack (OPD/IPD registers, birth/death, MLC
      registers as printable statutory formats).

### C. Basics that embarrass in a demo
- [x] **Appointment reschedule** — shipped in NL-4 (PR #429): backend PATCH
      endpoint and patient/staff reschedule UI honor double-booking guards.
- [ ] ✗ **Teleconsultation UI** — backend (mig 117) complete; stub UI was removed;
      needs a real build on a self-hosted SFU.
- [x] **e-Consent signature capture** — shipped in NL-4 (PR #429): staff
      patient/witness pads and patient proxy-grant signatures store audited PNG
      evidence and embed consent signatures; DSC provider remains procurement.
- [x] EMPI hardening + optional biometric capture at registration — shipped in
      NL-4 (PR #429): front-desk duplicate review/create-anyway audit,
      profile-photo capture, and disabled-by-default biometric seam.

### D. Clinical content & safety licensing
- [ ] ✗ Licensed drug KB + DDI (FDB / Medi-Span class) behind CDS — homegrown KB is
      a liability posture for production prescribing (decision + integration).
- [ ] ✗ Terminology spine: SNOMED-CT (NRCeS), LOINC, ICD-11 mapping services.
- [ ] ✗ Order-set / pathway **content studio** (author → approve → version →
      deploy; import); the CPOE composer exists, the content system does not.
- [ ] ✗ Indian pediatric content: IAP growth charts, UIP immunization schedule.

### E. Departmental completion (the physical hospital)
- [ ] ✗ Blood bank **donor cycle** (recruitment, screening, component prep,
      donor deferral registry) — transfusion side is done.
- [ ] ✗ Histopathology / cytology reporting (templates, grossing→reporting flow).
- [ ] ✗ Structured radiology reporting + peer review (worklist + PACS links exist).
- [ ] ✗ Medical-device gateway: bedside monitors → `deviceVitalsRoutes` (route
      exists, nothing feeds it); infusion-pump seam.
- [ ] ✗ Cold-chain IoT (blood bank / pharmacy / vaccine fridge temps + alerts).
- [ ] ✗ CMMS behind the biomed device registry (PM schedules, breakdowns, AMC).
- [ ] ✗ Dialysis machine HL7 integration (module + admin board exist).
- [ ] ✗ Oncology day-care infusion chair scheduling.
- [ ] ✗ Physio/rehab module; mortuary chain (death certification page exists);
      CSSD instrument-level tracking; linen/laundry; RTLS/asset seam.
- [ ] ✗ Porter/patient-transport task loop.

### F. Ops intelligence
- [ ] ✗ Embedded self-serve BI (dbt marts + `metabaseService` seam + report-builder
      page exist — nothing embedded/deployed).
- [ ] ✗ Predictive census/LOS/no-show surfaced operationally (tierH models exist).
- [ ] ✗ Theatre utilization optimizer surfaced (AI panel exists, unused).
- [ ] ✗ Exec mobile digest; benchmarking.

### G. Product & platform
- [ ] ✗ Shared design system across the three clients (visible drift).
- [ ] ✗ White-label theming (patient W6 dart-defines exist as the seam).
- [ ] ✗ Developer portal + activated `api_clients` (built-but-dormant) + public
      SMART-on-FHIR endpoints + FHIR writes + interface engine (see §2).
- [ ] ✗ Demo-tenant generator (seed scripts exist; not productized).
- [ ] ✗ Kiosk self-check-in + queue TV displays (token numbers exist, displays don't).

### Structural cons (name them honestly)
Zero production usage or references; bus factor of one; certifications not started;
scale unproven beyond k6 baselines; three drifting UI systems; no priced packaging.
The mitigations are NL-11/NL-12 plus the operator track — and shipping the pilot.

## 4. Strengths to protect (the moat — regress none of these)

Typed, drift-gated OpenAPI across every surface · full multi-tenant RLS fail-closed
posture · tamper-evident audit chains + canonical clinical timeline · offline-first
clinical safety (MAR five-rights, BCMA, scan intents, owner-scoped encrypted queue) ·
99-module governed AI substrate + dictation pipeline · realtime fabric (13 admin
boards + staff channels) · double-entry money ledger · India-native rails (ABDM,
TPA/PMJAY, GST, UPI, 5 languages) · monitoring-as-code + GitOps supply chain ·
deterministic journey tests + chunked CI discipline.

## 5. Programs NL-1 … NL-12

Each program gets the standard cycle: brainstorm/design spec (where marked
**[design-first]**) → plan → batched TDD execution → verification. Effort classes:
S (≤1 session), M (2–5), L (program).

**NL-1 Enterprise identity [design-first] (L).** OIDC + SAML SSO for staff/admin
(Keycloak-compatible; map IdP groups → `roleHelpers` roles), SCIM provisioning,
session policies (step-up preserved), break-glass local accounts, audit of IdP
events. Seams: `jwtMiddleware` single auth layer; `admins`/staff identity split.

**NL-2 NHCX claims exchange [design-first] (L).** FHIR-profile claim/preauth/
communication cycle per NHCX spec on the `tpa_claims`/`insurance_preauth` spine;
registry enrolment ops; tariff-master UI; denial-analytics tie-in (admin denials
page exists). Keep `insurance_claims`/`tpa_claims` split intact.

**NL-3 Teleconsultation [design-first] (L).** Self-hosted SFU (LiveKit-class,
on-prem — PHI never leaves), room/token provisioning service on mig-117 entities,
staff + patient UI (schedule → lobby → consult → notes via existing OP note flow →
e-Rx), recording policy default-off, consent gate, bandwidth-degraded mode.

**NL-4 Demo-basics debt (M).** Appointment reschedule end-to-end (backend endpoint +
both clients, honoring double-booking guards); e-consent signature capture (staff
pad + patient app, image embedded into the consent PDF/record, audit rows); EMPI
front-desk hardening (duplicate-warning at registration using the existing dedupe
engine; optional photo capture; biometric capture seam behind a flag).

**NL-5 Terminology + content studio [design-first] (L).** SNOMED-CT (NRCeS) + LOINC
+ ICD-11 services extending `terminologyService`; licensed drug-KB/DDI integration
behind `prescriptionSafetyCheck`/CDS (license = procurement decision); order-set &
pathway content studio (author/approve/version/deploy + import), IAP growth charts +
UIP schedule content packs.

**NL-6 Departmental completion (L, slice per department).** Blood-bank donor cycle;
histopath/cytology reporting; structured radiology reporting + peer review;
credentialing & privileging; outbreak workbench depth; dialysis/dental/ophtho depth;
oncology infusion scheduling; physio/rehab; mortuary; CSSD instrument tracking;
linen. Each slice = its own mini-design + batch.

**NL-7 Device & IoT gateway [design-first] (L).** Bedside-monitor ingestion (HL7v2
ORU / vendor protocols → `deviceVitalsRoutes` → vitals stream + NEWS2), cold-chain
sensors + alerts (reuse alert fabric), CMMS on the biomed registry, RTLS/asset seam.

**NL-8 Patient-flow suite (M–L).** Kiosk self-check-in (Flutter web/tablet build),
queue TV display app (token boards; channels exist), porter/transport tasks (reuse
housekeeping dispatch pattern), scheduling 2.0 (provider templates, overbook,
resource booking), predictive census/LOS surfaced on the command centre.

**NL-9 Engagement & CRM (M–L).** Recall/outreach campaigns on the WhatsApp rails
(consent-gated), NPS analytics on feedback, RPM/home-health program (device kit +
`rpm agent` module), teleconsult follow-up loops, loyalty deepening (health points).

**NL-10 Embedded BI (M).** Deploy + embed self-serve analytics (Metabase/Superset
on the dbt marts; `metabaseService` seam), governed dataset catalog, exec mobile
digest, benchmark pack.

**NL-11 Productization (L).** Shared design system (tokens + component parity across
the 3 clients), white-label theming, license/entitlement packaging on the per-tenant
module substrate, **legacy-HIS migration toolkit** (CSV/HL7 importers, patient/
encounter/billing openers, validation reports, rehearsal mode), demo-tenant
generator, user manuals + in-app tours + LMS, developer portal (activate
`api_clients`) + public SMART endpoints + FHIR R4 writes + HL7 interface engine.

**NL-12 Assurance & scale (L, mostly parallel).** ISO 27001/SOC 2 program, pen-test
execution, ABDM M1–M3 certification, NABH indicator exporter, SIEM export,
cross-site DR replica, 500-bed load profile (k6 + SLO re-baseline), accessibility
completion (screen-reader plan automation + font scaling), SLSA-L3 finish,
zero-trust network (Cloudflare Access, Cilium L7, per-tenant NetworkPolicy).

## 6. Wave sequencing

| Wave | Programs | Rationale |
|---|---|---|
| **A** | NL-1, NL-2, NL-3, NL-4 | Enterprise trust + India money rail + the demo table stakes. Everything afterwards demos better. |
| **B** | NL-5, NL-6, NL-7 | Clinical content + the physical hospital — the "complete HIS" claim. |
| **C** | NL-8, NL-9, NL-10 | Flow, engagement, intelligence — the "modern platform" claim. |
| **D** | NL-11, NL-12 | Packaging + proof — the "you can buy and trust this" claim. Runs partly parallel to B/C. |

Design-first programs (NL-1/2/3/5/7) start with a spec under
`docs/superpowers/specs/` and a decision review before any code.

## 7. Do-not-build (even in overkill mode)

Own DDI content database (license it — patient-safety liability) · US RCM/EDI
(835/837) · blockchain anything · microservices rewrite · hand-rolled WebRTC stack
(self-host an SFU) · genomics module (until oncology pull) · voice wake-words ·
hospital-picker in per-tenant client builds (build = hospital stays).

## 8. Execution conventions

Unchanged from the shipped programs: every change lands via a GitHub PR merged with
checks green (Smoke/Canonical are PR-only); full chunked backend gate + OpenAPI
regenerate/check/sync on backend changes; melos gates on Flutter; staff i18n via
`app_strings.dart`, patient via ARB (all languages); hospital-tz rule for 'today'
test seeds; migration counter — check `src/migrations/` for the next free number;
branch hygiene (delete on merge, both remotes); deploy stays HELD until the operator
track says otherwise. Single-PR-per-batch is acceptable when requested, with
one-commit-per-item for bisectability.

## 9. Status ledger

| Program | Wave | Status |
|---|---|---|
| NL-1 Enterprise identity | A | ◐ P1 shipped — PR #436 ([spec](superpowers/specs/2026-07-05-nl1-enterprise-identity-design.md)); Keycloak-first admin OIDC SSO held/default-off |
| NL-2 NHCX claims exchange | A | ◐ P2 claim cycle in review — PR #438 ([P1 PR #437](https://github.com/Bahuleyandr/VH-Health-Platform/pull/437), [spec](superpowers/specs/2026-07-05-nl2-nhcx-claims-design.md), [runbook](../apps/backend/docs/RUNBOOKS/nhcx-p1-core.md)); live NHCX version lock + sandbox enrolment still gate enablement |
| NL-3 Teleconsultation | A | ◐ P1 in review — PR #435 ([spec](superpowers/specs/2026-07-05-nl3-teleconsultation-design.md)); backend provisioning + held LiveKit infra only; P2 patient Flutter join and P3 staff consult surface next |
| NL-4 Demo-basics debt | A | ☑ shipped — PR #429 |
| NL-5 Terminology + content studio | B | ☐ not started |
| NL-6 Departmental completion | B | ☐ not started |
| NL-7 Device & IoT gateway | B | ☐ not started |
| NL-8 Patient-flow suite | C | ☐ not started |
| NL-9 Engagement & CRM | C | ☐ not started |
| NL-10 Embedded BI | C | ☐ not started |
| NL-11 Productization | D | ☐ not started |
| NL-12 Assurance & scale | D | ☐ not started |

Tick with PR ranges + main SHAs as programs land, mirroring `ROADMAP.md` §0 style.
