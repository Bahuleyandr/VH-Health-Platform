# ADR-002 — Retire Agent Swarm; Replace with Deterministic In-CI Journey Tests

**Date:** 2026-06-13
**Status:** Accepted
**Deciders:** Platform lead (Bahuleyandr)
**Source:** `docs/S_TIER_ROADMAP.md` — Decisions §5; `docs/PLATFORM_AUDIT_2026-06-13.md` — §1 bottom-line, DOC-3

---

## Context

The VH Health Platform used a headless Claude-agent swarm running on Dalekdefender
(`tmux attach -t vh-swarm`) to exercise the 11 clinical journeys and surface bugs
as "findings". This swarm:

- Stopped running 21 days before the 2026-06-16 milestone audit.
- Produced non-deterministic results (flaky, timing-sensitive, environment-dependent).
- Required the swarm host (Dalekdefender) to be live and appropriately seeded to produce
  meaningful output.
- Had a gate of "3 consecutive green ticks" that was impossible to satisfy without
  continuous operator attention.
- Produced `findings/in-flight/` artifacts that were the basis of the 2026-06-16 goal,
  but the findings directory itself did not exist at audit time (DOC-3).

The audit (DOC-1/2/3) found: the 2026-06-16 milestone was unmeasurable because the
tracking instrument (swarm) was stopped and its artifacts missing.

Two replacement options were considered:

1. **Re-arm the swarm** — re-start Dalekdefender swarm, rebuild seed, restart ticks.
   Same non-determinism and operator-attention problems remain.
2. **Deterministic in-CI journey tests (WS3)** — replace the swarm with a Jest/Supertest
   test suite that exercises each of the 11 journeys deterministically against a
   scratch database in CI, producing a pass/fail signal as part of the standard
   Forgejo CI pipeline.

## Decision

**Option 2: deterministic in-CI journey tests (WS3).**

The swarm is retired. The 11 clinical journeys are re-expressed as deterministic
integration tests that seed their own DB state, exercise the backend API end-to-end,
and produce a binary pass/fail in CI. This is the new authoritative quality gate
(WS3, scheduled 2026-06-16–24).

The swarm codebase (`D:\Dev\Projects\vh-health-swarm`) is left in place for reference
but is not re-armed. Swarm-related branches (`swarm/swarm-fix/*`) were verified
absorbed by content and no cherry-picks are needed.

## Consequences

**Positive:**
- The quality gate is now observable by anyone with CI access — no Dalekdefender dependency.
- Deterministic: same seed, same assertions, reproducible failure mode.
- Integrates with the existing Forgejo CI pipeline; failures block merge automatically.
- No ongoing operator attention required (the swarm needed daily: "skim the curation
  queue, merge any approved-but-deferred branches, update the tracker").

**Negative / risks:**
- The swarm surfaced bugs through exploration (tried unexpected paths). Deterministic
  tests only cover the known-happy and known-failure paths explicitly written.
  Mitigation: WS3 includes adversarial/negative assertions (wrong-tenant JWT, revoked
  session, missing-role access) for each journey.
- Writing 11 journey test suites is substantial work (WS3, ~8 days). Mitigation:
  existing backend unit/adversarial test patterns (`src/tests/`) provide scaffolding.

**Related:**
- `docs/GOAL_2026-06-16.md` is marked superseded by `docs/S_TIER_ROADMAP.md`
  (swarm-framing is historical; WS3 is the new journey-green gate).
- `SESSION_HANDOFF.md` updated to point to the S-tier roadmap as the active goal.
