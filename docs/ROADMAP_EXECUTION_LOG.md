# Roadmap Execution Log

Tracks pillar-by-pillar execution of `EPIC_LEVEL_ROADMAP.md`. One branch per
pillar (`roadmap/pillar-<x>`); each item lands as its own commit with tests.
Append per session; newest first.

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

Pillar B (close the clinical loops) on `roadmap/pillar-b`: B1 BCMA
end-to-end, B2 drug knowledge base, B3 lab interfaces, B4 PACS+viewer,
B5 transfusion, B6 med-rec three-point workflow, B7 problem list,
B8 terminology service.
