# BUILD: NL-7 P4 — RTLS seam (owner-gated) + pilot hardening

**Spec:** `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md` §6 + §9 P4. Read it fully, plus `_worker-common.md`.
**GATE:** the RTLS half builds ONLY if the playbook decision log says a vendor pilot is scheduled (Open Decision: RTLS pilot gating). Without it, deliver ONLY the hardening half — the RTLS seam stays a documented contract at zero code cost.

## Start gate (P1–P3 merged)
```
git fetch github
git grep -q "device_registry" github/main -- apps/backend/src/migrations && git grep -q "cold_chain_units" github/main -- apps/backend/src/migrations && git grep -q "biomed_work_orders" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl7-p4`, branch `feat/nl7-p4-rtls-hardening`.

## Scope A — pilot hardening (always)
1. Artifact-filter / suppression / charting-interval tuning hooks exercised against fixture replays at pilot volumes (soak test via the fixture replayer).
2. Association re-confirm TTL policy (configurable, default off — governance decision) + optional ADT-driven association assist behind a flag (only if bed-data trust was proven in pilot).
3. **Runbooks** under `apps/backend/docs/RUNBOOKS/`: `device-gateway-triage.md` (spool-drain procedure, silent-device response, unassociated-message response), cold-chain excursion response; UPDATE `code-blue-misfire.md` for the device source.
4. Grafana polish for the §7.4 metric set; activation checklist for the held manifests (what the operator flips, in order, with verification steps).

## Scope B — RTLS seam (ONLY if the decision log clears it)
Tables (1–2 migrations): `asset_tags` (vendor tag id ↔ biomed device FK, active, bound_by/at) + `asset_location_events` (tag, `location_id` FK → facility_locations resolved ZONES — the vendor system owns triangulation; never raw radio data; append-only, ~90-day retention + latest-per-tag snapshot). Ingest `POST /ingest/rtls` batched JSON authenticated as `device_registry` row `kind='rtls_feed'`; per-tenant `zone_ref → facility_locations.id` mapping table. Read API: latest location per asset + simple history; CMMS board column ("last seen: Ward 3, 12 min ago"). **Deliberately out:** patient/staff tracking, wander management, nurse-duress, live map UI, radio-layer processing.

## Tests
Hardening: soak replay (no loss/no dup at volume), TTL expiry closes associations with `end_reason='ttl_expired'`, runbook commands verified literal. RTLS (if built): zone mapping, latest-snapshot correctness, unknown-tag rejection, tenant isolation.

## Deliverable
PR `NL-7 P4: pilot hardening (+ RTLS seam if cleared)` with build ledger stating explicitly which half shipped. Migrations: **0–2**. Stop after the PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl7-p4-rtls-hardening.md` and `_worker-common.md` beside it; execute EXACTLY — note Scope B is owner-gated, check the playbook decision log first. Your migration block: <ASSIGN>. STOP after opening the PR; report PR number + build ledger.
