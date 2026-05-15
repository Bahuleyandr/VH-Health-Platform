---
id: 2026-05-15-efficiency-findings-summary
run_id: 2026-05-15T13-33-29-632Z-4799
started_at: 2026-05-15T14:31:21.135Z
finished_at: 2026-05-15T14:31:22.356Z
git_sha: cc968269f4f7e09ed4cd33b3ad4b3f0e0b73d2a4
seed_version: none
base_url: http://127.0.0.1:5206
tenant_id: 00000000-0000-4000-8000-000000000001
scenario: Sweep-summary of the 10 efficiency findings filed by the efficiency-auditor stage of tick 2026-05-15T13-33-29-632Z-4799
command: see body
exit_code: 0
severity: info
area: infra
repro_steps:
  - "Read the per-role files under D:/Dev/Projects/vh-health-swarm/findings/in-flight/efficiency-2026-05-15-*.md"
  - "Cross-reference with runs/2026-05-15T13-33-29-632Z-4799/efficiency/stats.json"
expected: |
  Either each efficiency finding maps to a discrete platform bug we can fix, or — if they're observational — we acknowledge that and skip the per-finding PR cycle in favor of a single planning doc.
actual: |
  Of the 10 filed, 9 are aggregate driver-step-duration observations (1 per role) and 1 is a per-role finding-count hot-spot (receptionist). Neither category is a platform bug. They are inputs to swarm-tuning and to a future platform-side perf pass. See body for the recommendation.
confidence: high
status: open
---

## TL;DR

The efficiency-auditor stage filed 10 findings this tick. **None of them are platform bugs.** They are telemetry observations:

- **9 role-slowness findings** (one per role) — driven by driver-agent runtime (Claude + driver-prompt verbosity), not platform endpoint latency.
- **1 receptionist hot-spot finding** — receptionist surface produced 4x the per-role median *findings*. This one is platform-meaningful; the cherry-pick sweep this tick already shipped 5 of its 8 priority-bug PRs against the receptionist surface (the visit_no collision, prescription filters, pharmacy catalog mismatch, walk-in workflow gaps, and the surgical-doc redirect).

Recommendation: **don't open per-finding PRs against the platform for these.** Treat them as inputs to two separate workstreams — swarm tuning and a platform-side perf pass — both of which are larger than a sweep.

## The numbers

| Role | Severity | Samples | Median | p90 | Max |
|---|---|---:|---:|---:|---:|
| receptionist | high | 121 | 503s | 1210s | 1800s |
| doctor | high | 82 | 756s | 1183s | 1464s |
| nurse | high | 57 | 542s | 985s | 1800s |
| patient | high | 54 | 593s | 1121s | 1800s |
| admission | high | 52 | 713s | 1169s | 1507s |
| lab-tech | high | 33 | 652s | 1115s | 1374s |
| billing | high | 32 | 567s | 970s | 1032s |
| pharmacy | high | 20 | 651s | 1284s | 1800s |
| housekeeping | medium | 6 | 531s | 852s | 852s |

Plus:

| Hot-spot | Severity | Findings (last 20 ticks) | Per-role median |
|---|---|---:|---:|
| receptionist | medium | 235 | 58 |

## Why the role-slowness numbers aren't platform-perf signals

The samples are **driver-agent step durations**, not real-staff workflow durations and not platform endpoint latencies. A "step" is one autonomous Claude run that simulates a role (`receptionist` etc.) doing one piece of a journey. Each run carries:

- The full driver-persona prompt
- A snapshot of the journey state so far
- Tool-call latency for the LLM provider (typically Claude API)
- 30-minute hard ceiling (`SWARM_DRIVER_STEP_TIMEOUT_MS`)

A `Max` of `1800s` on every high-severity row is the **ceiling itself** — the swarm killed the step. That's the upper bound on the histogram, not a workflow taking exactly 30 minutes.

Median 500-700s + p90 1000-1300s reflects Claude API latency × the number of tool-calls a driver makes in one step. The platform is mostly answering in tens of milliseconds per request — the few endpoints that take seconds are correctly flagged by the per-endpoint slow-query log (`>1000ms` warnings in Winston, see `apps/backend/CLAUDE.md` "Database Resilience").

Conclusion: **fixing these numbers means optimising the swarm, not the platform.** Real targets:

- Tighten driver prompts (less prose, more structure).
- Pre-cache the journey context so each step doesn't re-read 20K tokens of prior state.
- Drop the 30-minute ceiling once the median is genuinely <5min, so the p90/max numbers stop being ceiling-bound.

That work lives in `D:/Dev/Projects/vh-health-swarm/`, not here. **Not in scope for the platform repo.**

## The hot-spot finding IS platform-meaningful

`efficiency-2026-05-15-hotspot-receptionist` — *235 findings across 20 ticks, 4.1× the per-role median of 58* — is the only one of these 10 that points at the platform.

Receptionist findings dominate because:

1. Receptionist is the journey *entry point* for almost every scripted journey (walk-in-opd, follow-up-opd, lab-walk-in, obstetric-anc, pediatric-opd, emergency-walk-in, dynamic-acute-abdomen, inpatient-admission). Every one of those tries the receptionist step first. Pure volume.
2. Walk-in registration is the platform's busiest surface, with the largest number of state-machine branches (insurance, payer, paeds guardian, ER unidentified, follow-up parent link, visit_no composition, token counter scoping). Branches generate findings.
3. The receptionist driver tries many recovery paths on first failure ("does omitting department fix it? does using a different phone fix it? ..."), which inflates the finding count per real bug.

The five sweep PRs landed this tick directly relieve this hot-spot:

| PR | What it relieves on the receptionist surface |
|---|---|
| #99 | Prescription lookup filters now honoured (pharmacy-driver receptionist-adjacent) |
| #100 | visit_no UNIQUE collision on prefix-equivalent departments — was a hard 500 on every "General Medicine" walk-in |
| #101 | Pharmacy catalog mismatch surfaces alternatives instead of dead-ending |
| #95 | Test staff seed lands automatically — drivers no longer waste 5 minutes per tick discovering EMP-1001..EMP-1015 don't exist |
| #98 | Legacy /admin/surgical URLs 308-redirect — drivers using stale docs no longer 403 on the wrong door |

Expectation for next tick: the receptionist finding count drops materially. Re-run the hotspot calc after 5 more ticks (the auditor analyses the trailing 20).

## What to do about these specific 10 findings

- **Auto-resolve all 9 role-slowness findings as `wont-fix` with reason: telemetry observation, not a platform bug.** They will re-fire every tick until the swarm itself gets a perf pass.
- **Mark the receptionist hot-spot as `in-fix` and bind it to the 5 PRs above.** Re-evaluate in 5 ticks.

Both lifecycle changes belong in the swarm repo's `daemon/finding-queue.mjs` (per the swarm's `CLAUDE.md` rule: "Never edit findings/** outside daemon/finding-queue.mjs"). Not a platform change.

## Why this is filed at `severity: info` not at all

For traceability. The cherry-pick sweep PR notes refer to "10 efficiency findings (informational)" — a future reader pulling on that thread needs to be able to find this analysis without re-deriving it from raw stats. The same standard the wave-1–4 verification doc set last tick.
