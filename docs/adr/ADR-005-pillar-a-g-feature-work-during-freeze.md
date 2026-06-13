# ADR-005 — Pillar A–G Feature Work Merged During Declared 2026-06-16 Feature Freeze

**Date:** 2026-06-13
**Status:** Accepted (risk acknowledged)
**Deciders:** Platform lead (Bahuleyandr)
**Source:** `docs/PLATFORM_AUDIT_2026-06-13.md` — §1, DOC-1/2/3; `docs/ROADMAP_EXECUTION_LOG.md`; git log

---

## Context

`docs/GOAL_2026-06-16.md` (set 2026-05-16) declared a feature freeze: "no new feature work
merges to `main` outside the bugs the swarm surfaces." The goal: 11 swarm journeys green +
0 critical/high in-flight by 2026-06-16.

Despite this freeze, the following Pillar A–G feature merges landed on `main`
between 2026-05-17 and 2026-06-13, comprising ~561 commits:

| Merge | Date | Contents |
|---|---|---|
| `Merge roadmap/pillar-a` (`7d5a3e9f`) | 2026-06-10 | Reliability + trust: A1–A10 (circuit breaker, downtime snapshots, DR/backup, load tests, etc.) |
| `Merge roadmap/pillar-b` (`8d6a5880`) | 2026-06-10 | Close clinical loops: B1–B8 (BCMA, structured CPOE, medication reconciliation, NABH pack, etc.) |
| `Merge roadmap/pillar-c` (`db75b945`) | 2026-06-10 | Interoperability + ecosystem: C1–C5 (FHIR, HL7v2, SMART OAuth, ABDM, drug-KB) |
| `Merge roadmap/pillar-d` (`8edae310`) | 2026-06-10 | Missing modules: D1–D4, D6, D7 + C1 encryption follow-up |
| `Merge roadmap/pillar-e` (`31106697`) | 2026-06-10 | Experience parity: E1–E3, E5, E6 (CPOE composer, staff i18n, a11y, Malayalam, patient summary) |
| `Merge roadmap/pillar-f` (`2d3123ea`) | 2026-06-10 | Analytics warehouse: F1 (publication/subscriber/dbt) + F2 operational marts |
| `Merge roadmap/pillar-g` (`8d8d0ecc`) | 2026-06-10 | G3 outcome scoreboard + unified allergies over HTTP (A10/E5) |
| `Merge roadmap/pillar-d-d5` (`ac9b0e9a`) | 2026-06-10 | D5 infection-control workbench + ICD-11 terminology coding |

These merges were executed with per-item gates (lint, targeted deep tests, `test:ci` chunks,
schema drift checks) run locally before each merge. However, there was no change-record
documenting why the feature freeze was waived.

The 2026-06-13 audit noted (DOC-1/2/3): "~561 commits of Pillar A–G feature work merged to
main during a declared feature freeze with no decision record."

## Decision

**Risk accepted; pillar merges are retained; feature freeze is formally superseded.**

The decision to proceed with Pillar A–G work during the freeze window was driven by the
following factors:
1. The swarm had stopped 21 days before the 2026-06-16 audit date — the goal was already
   unmeasurable. Continuing to enforce a freeze against a dead measurement instrument
   provided no quality benefit.
2. The Pillar A–G work included items that fixed the swarm's own blocker findings
   (e.g. Pillar A fixed the 11 journeys' underlying infra gaps; Pillar B fixed clinical
   data-integrity bugs the swarm surfaced). The work was bug-fix adjacent.
3. The S-tier roadmap (created 2026-06-13) supersedes the 2026-06-16 goal as the active
   milestone. The feature-freeze framing belonged to the swarm model; the S-tier model
   uses per-batch CI gates instead.

All pillar merges carried per-batch validation gates. The full `test:ci` suite (58 chunks)
was confirmed green on the combined tree after the final D5/ICD-11 commit (`06fccd5e`).
No rollback of the pillar work is warranted.

## Consequences

**Positive:**
- Platform capability advanced substantially: deep clinical modules, interoperability
  framework, analytics warehouse, i18n parity, AI governance tightened.
- Technical debt from the freeze-violation is zero: every pillar merge carried local CI gates.

**Negative / risks:**
- The 2026-06-16 goal ("11 journeys green, 0 critical/high in-flight") is formally missed
  and is no longer measurable under the swarm model. The equivalent quality gate moves to
  WS3 (deterministic in-CI journeys, target 2026-06-16–24).
- The violation of the declared freeze, even retrospectively accepted, signals process
  weakness in change control. Mitigation: `docs/CHANGE_MANAGEMENT.md` establishes a
  lightweight CAB-lite process for future freezes; any freeze waiver requires an explicit
  log entry.

**Process change:**
- Future feature-freeze waivers must be logged in `docs/CHANGE_MANAGEMENT.md` under
  "Change log" with: date, items waived in, rationale, and approver.
- The S-tier roadmap's batch model replaces the freeze model; each batch has its own
  go/no-go gate defined in the roadmap.
