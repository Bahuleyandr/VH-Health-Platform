# DeerFlow gate — when does the harness graduate?

Status: **not yet adopted.** This doc records the decision criteria so the
question doesn't get re-relitigated next time it comes up.

## What DeerFlow would buy us

[DeerFlow](https://github.com/Bahuleyandr/deer-flow) (in
`D:\Dev\Tools\deer-flow`) is a LangGraph-based agent harness with:

- A persistent sandbox per thread (filesystem isolation).
- Subagent delegation (general-purpose, bash) with bounded concurrency.
- A skills system that maps `.claude/skills/*/SKILL.md`-style modules
  into per-agent prompts.
- An MCP integration layer that lets the agent reach out to Playwright,
  Postgres, Slack, etc., through declarative configs in
  `extensions_config.json`.
- Streaming events (run lifecycle, token usage, tool invocations) so a
  human can watch a long QA pass without re-launching it.
- Embedded `DeerFlowClient` for in-process programmatic invocation, so
  CI can drive it without a network hop.

For VH Health QA specifically, the unlocking properties are:

1. **Multi-step exploration.** Today's harness runs a fixed list of
   smokes. DeerFlow can let an agent decide "the staff smoke just
   surfaced an unexpected 502 — pull the backend logs, then re-run the
   single failing endpoint with verbose tracing."
2. **Cross-stack reasoning.** A finding in admin that points at a
   backend endpoint can be triaged by the same agent without context
   switching.
3. **Long-horizon runs.** The orchestrator currently does one pass.
   DeerFlow's checkpointer lets an agent come back the next day and
   resume an exploration thread.

## Why we are NOT adopting it now

We deliberately deferred DeerFlow until the cheap loop proves itself.
The criteria below are the ones that flip "no" to "yes":

| Gate | Threshold |
|---|---|
| **Findings volume** | ≥ 30 distinct findings filed in `docs/qa-findings/` over a rolling 4-week window. Below that, a fixed-list orchestrator is the right tool. |
| **Repeat false-positives** | Less than 10% of findings are reclassified `false-positive` after triage. High noise means the harness needs better guards, not more agency. |
| **Cross-stack ratio** | At least 30% of findings touch ≥ 2 of {backend, admin, patient, staff}. Single-stack issues don't need DeerFlow's cross-stack reasoning. |
| **Human triage time** | Median minutes-per-finding from "stage failed" to "finding committed" is > 20 minutes — i.e., a human is the bottleneck, not the suite. |
| **Bootstrap stable** | The schema-bootstrap finding (`2026-05-07-prisma-db-push-fails-on-housekeeping-sequence.md`) is closed and three consecutive green orchestrator passes recorded. We don't add a heavier harness on top of a flapping foundation. |

If **all five** are satisfied, write a follow-up doc proposing the
adoption shape (where DeerFlow runs, how it talks to the orchestrator,
which MCP servers it gets) and run it through the structured-decision
trio (advocate / challenger / supervisor) before flipping the switch.

## What an integration would probably look like (for future-us)

When the gate flips, the most natural shape is:

1. **DeerFlow lives on Trenzalore**, same machine as the orchestrator.
   Talks to Postgres, backend, admin proxy, and Maestro/Playwright over
   localhost. Subscribes to Trenzalore's existing OAuth-mode Claude
   Max + Codex 20x quotas (no API spend; see
   memory `tools_ai_subscriptions.md`).
2. **The orchestrator stays.** DeerFlow does NOT replace
   `qa-orchestrator.mjs` — it wraps it as a "tool" the agent can call.
   The orchestrator remains the deterministic, replayable spine; the
   agent layer adds exploration on top.
3. **MCP wiring**: enable
   - Postgres MCP server pointed at `vhhealth_test`,
   - Playwright MCP for admin browser drives,
   - filesystem MCP scoped to `qa-runs/` and `docs/qa-findings/` only,
   - bash MCP for ad-hoc reproduction. Lock down via `extensions_config.json`.
4. **Skills**: port `.claude/skills/vh-health-qa/SKILL.md` content into
   a DeerFlow skill under `skills/public/vh-health-qa/`. Same prompt,
   different runtime.
5. **Findings stay on disk.** `docs/qa-findings/` remains the source of
   truth. DeerFlow writes findings as files; we don't move to a DB.

## Until then

The cheap loop:

1. Orchestrator runs (`scripts/qa-orchestrator.mjs`).
2. Human (or a single Claude Code session via the project skill) triages.
3. Findings under `docs/qa-findings/`.
4. Fix-mode is gated by humans.

This is enough to find real bugs — see the very first run, which
surfaced a Prisma schema bootstrap regression. Don't graduate until the
gate criteria say to.
