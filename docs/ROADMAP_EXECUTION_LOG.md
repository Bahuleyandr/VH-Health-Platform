# Roadmap Execution Log

Tracks pillar-by-pillar execution of `EPIC_LEVEL_ROADMAP.md`. One branch per
pillar (`roadmap/pillar-<x>`); each item lands as its own commit with tests.
Append per session; newest first.

## Session 2026-06-10 — Pillar A merge + Pillar B (branch `roadmap/pillar-b`)

Pre-work: reviewed `roadmap/pillar-a` (8 commits — focus: Prisma model-API
RLS wrapper, migrations 272–274, downtime route auth, $transaction
conversions, CNPG/monitoring manifests), independently re-ran lint + the 33
pillar-a unit tests, then merged `--no-ff` → main `7d5a3e9f` and pushed.
Merge is deploy-safe: prod image digest stays pinned, so migration 272 + the
runtime-role env var activate at the next backend image release; the CNPG
managed role + nightly ScheduledBackup apply immediately (intended).

| Item | State | Commit | Notes |
|---|---|---|---|
| B8 terminology service | ✅ | `164bea13` | Code-system registry (ICD-10/11, SNOMED CT, LOINC, ATC) + concepts (+pg_trgm search when available) + concept maps + local-catalog bindings (`investigation_test_catalog`/`pharmacy_catalog`/`medications`, suggest+confirm flow, coverage report). ICD-10 federated from `icd10_codes`; LOINC keeps the structural fallback until the full catalogue is imported so HL7 ingestion behaviour is unchanged. Importer CLI: SNOMED RF2 (free NRC license), LOINC csv, generic CSV. `/api/v1/terminology`. |
| B7 problem list | ✅ | `a031eaae` | `patient_problems` (active/resolved/inactive/entered_in_error, onset, managing doctor via the A9 canonical resolver, ICD-10/SNOMED soft-validated through B8, chronicity, provenance to the per-visit diagnosis row) + tenant RLS + one-active-coded-problem guard. Idempotent diagnosis promotion. Active problems feed encounter-start CDS cards and the B2 drug–disease checks. Timeline invariant honoured (detail+timeline+audit in one tx). |
| B2 drug knowledge base | ✅ code-complete | `b51b9d7a` | 7 `drug_kb_*` tables (monographs w/ Indian brand aliases, interactions, allergy cross-sensitivity groups, drug–disease by ICD-10 prefix vs the B7 problem list, dose ceilings incl. renal, IV Y-site) + clearly-flagged textbook starter set (~160 rows). Engine is TTL-cached and schema-tolerant (never bricks prescribing pre-migration). Wired as section 8 of `validatePrescriptionSafety`: contraindicated/major interactions, same-class allergy hits, disease contraindications and major dose breaches → blockers (same override path); dedupes against the legacy antithrombotic/allergy floor checks. **Licensing a real KB (Medi-Span/FDB/CIMS) is owner-side — import via `scripts/drug-kb-import.mjs`, then deactivate `vh_starter_set`.** |
| B1 BCMA closed loop | ✅ | `359b9f12` | Pharmacist clinical-verification gate as orthogonal columns on `pharmacy_orders` (client status enums untouched): `/pharmacy/orders/:id/verify` runs the full safety engine (allergy stores + B2 KB + B7 problems), writes `medication_safety_reviews` + canonical events in-tx, blockers require override-with-reason; PREPARING/DISPATCH/counter-dispense hard-gated server-side (grandfathered pre-existing orders). MAR is now scan-first: bare `/administer` 409s without a documented override (persisted + audited). Dispenses issue `VHMP-` pack barcodes the 5-rights drug-right matches exactly; wristband endpoint prints Code 39 of the patient uid (dependency-free SVG). Flags `MAR_REQUIRE_BARCODE_SCAN`, `PHARMACY_REQUIRE_CLINICAL_VERIFICATION` (both default ON). |
| B6 med-rec three-point | ✅ | `cf969458` | `medication_reconciliations` + items (tenant RLS; one open rec per patient/type/admission). Start snapshots home meds + active prescriptions + scheduled MAR (deduped, source priority per rec point); every drug needs an explicit continue/stop/change/new/hold decision (stop/change/hold need reasons; change needs instructions); completion blocked while undecided; discharge recs emit the take-home list. Per-item decisions audited; start/complete on the canonical timeline. The G2 stage-1 ward pilot (med-rec AI module) rides on this workflow. |
| B5 transfusion loop | ✅ | `33be670d` | `blood_units` registry pinned to requests at crossmatch (ABO/Rh matrix guard — recording an incompatible pairing as 'compatible' needs an override reason); two-person bedside verification (`first`/`second` must be different humans; scan unit + wristband; group/expiry verdicts; override audited); start/complete + the legacy `/transfused` path all hard-gate on both verifications; structured `transfusion_reactions` (type/severity/vitals/intervention) replaces notes-append. Canonical events at every step. |
| B3 lab closed loop | ✅ foundations | `04e2d2c9` | Specimen `barcode` (backfilled from accession) + printable Code 39 labels + case-insensitive scan-on-receipt (status history + canonical events). `lab_interface_messages` inbox persists every raw analyzer payload with parse/ingest outcome — failures are visible and replayable. Pure ASTM E1394 parser; ASTM results land in `lab_results` pinned to the scanned specimen and run critical detection + the autoverification delta/critical-band helpers at ingestion. **Per-analyzer serial/MLLP transports for the pilot hospital's instruments are owner-side; middleware-capable analyzers can POST to `/api/v1/lab/interface/ingest` today.** |
| B4 PACS + viewer | ✅ foundations | `6d41fc6d` | Opt-in infra module `infra/kubernetes/optional/pacs` (Orthanc StatefulSet w/ DICOMweb+worklists, OHIF viewer) — deliberately NOT in `base/` because `overlays/prod` consumes base wholesale; enabling is an explicit overlay edit per the README. Backend `/api/v1/pacs`: study linking pins `pacs_study_instance_uid` and puts an `imaging.study_linked` event with the OHIF deep link on the patient timeline; MWL-shaped worklist feed (`RAD-<orderId>` accessions, DICOM DA/TM) for the Orthanc worklist sidecar. `PACS_*` env in validateEnv. **Deploy, PVC sizing, modality pointing, Lua link hook: owner-side.** |
| Schema sync + suite | ✅ | (this commit) | `prisma db pull` regen against the migrations-built test DB; `check-schema-drift` green. Full suite via the sharded `test:ci` runner (the plain 4 GB run OOMs). Gate-fallout fixed forward: 3 `prescription-deep` dispense tests now verify (or override the paediatric-dose blocker) before dispensing; `clinical-safety` non-scan administrations carry documented overrides — both are the B1 policy working as designed. |

### Environment notes

- `scripts/ci-setup-db.mjs` does not load `.env` itself — run via
  `node -r dotenv/config scripts/ci-setup-db.mjs` when applying migrations
  to the test DB by hand.
- Targeted deep-test runs need `--forceExit` (app timers keep jest alive;
  the full-suite scripts already pass it).
- **Sandbox `sed -i` against the Windows mount TRUNCATES files** (corrupted
  a test file mid-session; rewritten host-side). Same hazard class as the
  Pillar A `.git/index` warning: mutate repo files only via host-side
  tooling.
- The full suite must run through `npm run test:ci` (54 sharded chunks);
  the single-process `npm test` run exhausts the 4 GB heap.

### Owner-side actions queued (Pillar B)

1. License a real drug KB (Medi-Span / FDB / CIMS), transform to the
   documented CSVs, import via `scripts/drug-kb-import.mjs`, validate, then
   deactivate `vh_starter_set` — the B2 acceptance gate.
2. Download SNOMED CT (NRC India) + LOINC releases and run
   `scripts/terminology-import.mjs` (B8 content; schema+API are live).
3. B1 go-live ceremony on the pilot ward: print wristbands + pack labels,
   confirm scanner hardware, decide whether the
   `MAR_REQUIRE_BARCODE_SCAN` / `PHARMACY_REQUIRE_CLINICAL_VERIFICATION`
   defaults (ON) stand during week one.
4. Stand up analyzer transports (serial/ASTM or MLLP → POST
   `/api/v1/lab/interface/ingest`) for the instruments the pilot hospital
   owns (B3).
5. Enable `infra/kubernetes/optional/pacs` in the prod overlay (size the
   imaging PVC first), point modalities at AET `VHHEALTH`, wire the Orthanc
   OnStableStudy Lua hook to `/api/v1/pacs/orders/:id/link-study` (B4).
6. Merge `roadmap/pillar-b` → main after review.

## Session 2026-06-09/10 — Pillar A (branch `roadmap/pillar-a`)

| Item | State | Commit | Notes |
|---|---|---|---|
| A2 tenant RLS end-to-end | ✅ code-complete | `7445d25f` | Migration 272 FORCEs all 62 tenant_isolation tables (075 set incl. `users` was owner-exempt in prod). **Found+fixed a live cross-tenant PHI leak**: Prisma model-API calls (`findMany` etc., batches 26–38) bypassed the RLS auto-wrapper entirely — proven by the new HTTP deep test (tenant-B admin read tenant-A appointments through /appointments/list), then closed by wrapping model delegates in the same setTenant path. Posture probe now flags owner-exempt-unforced tables. `AUTH_TENANT_RLS_RUNTIME_ROLE` canonical env + CNPG managed role `vhhealth_app` + boot-time grant ensure. 4 array-form `$transaction([model…])` sites converted to interactive form. 32 RLS tests green. |
| A9 doctor-ID resolver | ✅ | `0101bbb6` | Write path already canonical (`resolveDoctorRef`). Added lenient `resolveDoctorFilterId` + adopted at 7 read surfaces (appointments list + /doctor/:id ownership check, investigations, feedback, records list + PDF/Excel export, OPD dashboard). |
| A10 allergy propagation | ✅ | `422a7e66` | `getUnifiedActiveAllergies` unions all four allergy stores; adopted in the prescription gate, encounter-start CDS card (which had NEVER rendered — selected a nonexistent `allergen` column, 42703 silently swallowed), pharmacy dispense label. ER→IPD order carry-over verified already implemented (`carryActiveErOrdersToAdmission`). |
| A3 downtime mode | ✅ | `c6713db7` | Scheduled (15 min) per-ward printable packs: census, unified allergies, code status, 12 h MAR due-list, active orders, vitals+NEWS2. Migration 273; routes `/api/v1/downtime/*`; `docs/DOWNTIME_PROCEDURE.md`. Migration 274 repairs pre-existing drift (`staff_queries` model had no migration). |
| A5 load testing | ✅ | `a51c3f76` | k6 hospital-day profile + SLO thresholds (read p95<400 ms, write p95<800 ms, err<1%). Baseline run on prod-shaped hardware still owner-side. |
| A6 observability | ✅ | `a51c3f76` | PrometheusRule RED alerts (incl. clinical-route 5xx, stale downtime packs, CNPG backup freshness) + `docs/RUNBOOK_ONCALL.md`; Sentry samples clinical writes at 100%. |
| A4 DR | ✅ code-complete | `f1a1e22a` | Nightly CNPG `ScheduledBackup` (WAL-only archiving existed → PITR was unreplayable). `docs/DR_RESTORE_DRILL.md` (RPO ≤5 m, RTO ≤60 m). **First timed drill is owner-side and is the acceptance gate.** |
| A7+A8 security | ✅ checklist | `f1a1e22a` | `docs/SECURITY_HARDENING_CHECKLIST.md` — rotation order, purge list, image-signature verification gap, pen-test scope, DPDP review. Execution is owner-side. |
| A1 suite/journeys | ◐ partial | (this commit) | Fixed fresh regression: phone-mode gate (`rejectMobileClinicalWrite`, commit `84d882ca`) 403'd every harness token (`DEVICE_TYPE_MISSING`) — investigation-deep 18 failures → 19/19 green after `generateTestToken` stamps `deviceType: 'desktop'`. Full-suite status: see below. The 11 swarm journeys proper still need the swarm harness re-armed (`start-loop-codex.sh`, dalekdefender) — out of session scope. |

### Environment notes

- **pgvector restored** into `C:\Program Files\PostgreSQL\17` from
  `D:\Dev\Tools\pgvector-windows\vector.v0.8.2-pg17` (a PG reinstall had
  wiped it; tenant deletes cascading into vector tables failed with 58P01).
- `qa-cluster-up.mjs` now provisions the three `rls_*` test roles +
  `qa_writer` memberships idempotently.
- **Never run git from the Cowork sandbox against this repo** — the
  Windows-mount filesystem corrupts `.git/index` (recovered via host-side
  index rebuild; fsck clean). All git on the host.
- QA DB is long-lived and predates the current `000_baseline.sql` — do NOT
  `prisma db pull` from it (produces false deletions). Regenerate schema
  from a fresh DB per `apps/backend/CLAUDE.md`.

### Owner-side actions queued (cannot be done from the repo)

1. Run the first DR restore drill (`docs/DR_RESTORE_DRILL.md`) — A4 gate.
2. Execute the secret rotation checklist — A7 gate.
3. Commission the pen test — A8 gate.
4. k6 baseline against prod-shaped hardware — A5 gate.
5. Downtime drill on one ward — A3 gate.
6. Re-arm the QA swarm for the 11 journeys — A1 completion.
7. Merge `roadmap/pillar-a` → main after review.

## Next pillar

Pillar C (interoperability & ecosystem) on `roadmap/pillar-c`: C1 ABDM
certification (sandbox creds are owner-side), C2 HL7v2 live feeds /
interface engine, C3 FHIR R4 read-write server on the canonical timeline,
C4 e-signature + tamper-evident audit hash chain, C5 ICU device/vitals
ingestion. Pillar B foundations C builds on: B8 terminology (FHIR
CodeableConcepts), B3 interface inbox (HL7v2 transport), B7 problem list
(FHIR Condition).
