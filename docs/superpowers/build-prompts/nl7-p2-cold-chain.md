# BUILD: NL-7 P2 — Cold-chain IoT (units, readings, excursions, alerts)

**Spec:** `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md` §4 + §9 P2. Read it fully, plus `_worker-common.md`. Nothing exists for cold-chain today (verified) — net-new domain on existing alert rails.

## Start gate (P1 must be merged — registry + gateway are prerequisites)
```
git fetch github
git grep -q "device_registry" github/main -- apps/backend/src/migrations && git grep -q "Cold-Chain IoT" github/main -- docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md
```

## Workspace
Worktree `VH-Health-Platform-nl7-p2`, branch `feat/nl7-p2-cold-chain`. Backend + admin + gateway (`apps/device-gateway` exists after P1).

## Scope (spec §4)
1. **Tables** (2–3 migrations from your block, tenant RLS mig-356 boilerplate): `cold_chain_units` (unit_code, kind fridge|freezer|ilr|ambient, department pharmacy|blood_bank|lab|ward|ot, location FK, nullable biomed FK, `device_registry_id` FK, min/max temp, `excursion_grace_minutes` — door-open transients must not page; default 15 min pharmacy, tighter blood bank, `alert_roles`, status) · `cold_chain_readings` (append-only; temp/humidity/battery, recorded_at/received_at; BRIN or monthly-partition note; retention ≥2 y configurable) · `cold_chain_excursions` (opened/closed, peak temp, duration, severity, acknowledged_by/at, `corrective_action` REQUIRED to close, advisory `disposition_note`, status open|acknowledged|closed — one row per episode).
2. **Ingest**: HTTP adapter on the gateway (`POST /ingest/cold-chain`) AND direct backend route for HTTPS+token-capable sensors — both authenticate via `device_registry` bearer tokens (`kind='fridge_sensor'`; sha256+timingSafeEqual pattern). MQTT = documented seam only, NOT built.
3. **Excursion engine**: breach must survive the grace window to open an episode; closes only when readings return in-range AND a corrective action is recorded.
4. **Alerting on existing rails**: excursion opens → `notificationOutbox.queue()` to the unit's `alert_roles` (roster/delegation lookup mirroring `housekeepingTaskDispatchService`); un-acked excursions escalate via the existing escalation engine (workflow_sla_instances-backed task, T1/T2/T3). Results-inbox NOT used (patient-scoped by design; cold-chain is facility-scoped). New `staff:cold-chain` realtime channel + admin dashboard tile per the proven board recipe (CHANNEL_CATALOG + emitter + producer at the excursion write + `useRealtimeInvalidation`).
5. **Compliance**: monthly temperature-register export per unit (PDF/CSV via existing export rails). **Blood-bank linkage advisory only**: excursions on blood-bank units raise a review flag on the blood-bank board — NEVER auto-quarantine/discard stock (binding invariant §1.1).
6. **Silent-sensor watchdog**: active sensor silent >3× expected interval → WARNING through the same path (powered by `last_seen_at` + §7.4 metrics). Registry provisioning UX for `fridge_sensor` kind.

## Tests
Grace-window filter (transient in-window breach → no episode; sustained → one episode); corrective-action-required-to-close gate; ack → escalation stops; silent-sensor watchdog fires; register export golden test; realtime emitter + channel-RBAC unit tests; tenant isolation on all new tables.

## Deliverable
PR `NL-7 P2: cold-chain monitoring (units, excursions, alert rails)` with build ledger. Migrations: **2–3**. Stop after the PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl7-p2-cold-chain.md` and `_worker-common.md` beside it; execute EXACTLY. Your migration block: <ASSIGN>. STOP after opening the PR; report PR number + build ledger.
