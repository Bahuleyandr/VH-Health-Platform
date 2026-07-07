# BUILD: NL-5 P4 — India pediatric content packs (growth LMS + immunization schedules)

**Spec:** `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md` §4 + §Phased Plan P4. Read it fully, plus `_worker-common.md`.
**Content posture:** WHO LMS tables are public — importable now. IAP tables ship as operator-supplied files UNLESS the playbook decision log says redistribution is cleared (then CSVs may live under `docs/content/growth/`).

## Start gate
```
git fetch github
git grep -q "India Pediatric Content Packs" github/main -- docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md
```

## Workspace
Worktree `VH-Health-Platform-nl5-p4`, branch `feat/nl5-p4-pediatric-packs`. Backend only.

## Scope (spec §4.1–4.2)
1. **`growth_reference_lms`** (1 migration): global reference table, NO tenant/RLS (275/307 stance) — `(dataset CHECK IN ('WHO_0_5','IAP_5_18','CDC_2_20','FENTON'), sex, metric, age_days, l, m, s, source_version, UNIQUE(dataset,sex,metric,age_days))`. The CHECK mirrors `growth_charts.reference_dataset` (mig 131) exactly.
2. **Importer** `scripts/growth-lms-import.mjs` (`--dataset --csv`, provenance batch row, dry-run).
3. **Service change** (`growthPercentileService.js`): `computePercentile` looks up LMS from the table first (in-memory cache keyed dataset+sex+metric; linear interpolation between age points — helper exists at :101–119); dataset by age (≤60 mo → WHO_0_5; 5–18 y → IAP_5_18, replacing the >60-month bail-out at :158–163); falls back to the embedded approximation when the DB set is absent (dev/offline unchanged; `source` distinguishes `'WHO_0_5'` vs `'WHO_0_5_approx'`). `computeGrowthSnapshot` gains head-circumference + BMI once the full tables provide LMS rows.
4. **`vaccine_catalogue` versioning columns** (1 migration): `schedule_source CHECK ('uip','iap','custom') DEFAULT 'custom'`, `source_version`, `retired_at` — additive only; existing `UNIQUE (tenant_id, code, dose_number)` semantics unchanged.
5. **Importer** `scripts/immunisation-schedule-import.mjs --tenant <uuid> --schedule uip|iap|both --version <label>`: full 0–18 y packs (UIP completions: 5–6 y DPT booster, 10 y/16 y Td, endemic JE-2; IAP additions: MMR timing, varicella, hep-A, typhoid conjugate, annual influenza, Tdap, HPV). **Update semantics (safety-reviewed):** upsert on `(tenant_id, code, dose_number)`; timing changes apply going-forward only (existing patient/newborn schedule rows are computed at seed time and must stay untouched); removed rows flip `active=false, retired_at=NOW()` — never deleted (given doses reference them). Provenance batch row per run.
6. **Runbook**: per-tenant pack import + the named-clinician sign-off step (pack content is a clinical/policy choice; per-patient review already rides the signed `immunisation_review` note flow).

## Tests
LMS lookup vs embedded approximation (distinct source markers; known-value z-score/percentile fixtures for WHO and IAP points, extending `growthPercentileService.test.js`); >60-month path produces `reference_dataset='IAP_5_18'` rows accepted by the mig-131 CHECK; schedule import upsert/retire semantics; **existing patient schedules unchanged after a timing update** (seed → re-import with shifted `recommended_age_days` → seeded due_dates identical; new seeds pick up new timing) — extends `paediatric-immunisation-deep.test.js`.

## Deliverable
PR `NL-5 P4: pediatric content packs (growth LMS + UIP/IAP schedules)` with build ledger. Migrations: **2**. Stop after the PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl5-p4-pediatric-packs.md` and `_worker-common.md` beside it; execute EXACTLY. Your migration block: <ASSIGN>. STOP after opening the PR; report PR number + build ledger.
