---
name: vh-health-qa
description: Run the agent-driven QA harness for the VH Health platform — drive the local smoke env, capture failures, file structured Markdown findings under docs/qa-findings/. Default mode is report-only; fix mode is gated per-finding by human approval.
---

# /vh-health-qa — VH Health QA harness

Use when the user wants to:
- Run a full QA pass against the local smoke env.
- Triage existing findings under `docs/qa-findings/`.
- Begin a gated fix-mode session for one finding.

## Repo context (do not re-derive)

- Monorepo at `D:\Dev\Projects\VH Health\VH-Health-Platform`.
- Local smoke env: backend `:5206`, admin proxy `:3201`, Postgres
  `:55432/vhhealth_test`.
- QA target = local smoke env on Trenzalore. Dalekdefender is the
  deployment target only — not driven by this harness, except for the
  opt-in `--include-role` stage which talks to a live `VH_BASE_URL`.
- Default tenant: `00000000-0000-4000-8000-000000000001`.
- Schema source of truth: raw `apps/backend/src/migrations/*.sql`.
- iOS is out of scope for this harness.

Documentation pointers:
- `docs/qa/README.md` — how the harness is wired.
- `docs/qa/MODES.md` — report-mode vs fix-mode contract.
- `docs/qa/finding-schema.json` — frontmatter schema for findings.
- `docs/qa-findings/_baseline.md` — repo + deploy snapshot at inception.

## When invoked

### Step 1 — figure out the user's intent

Ask **only if ambiguous**. Common intents:

| User phrasing | Intent |
|---|---|
| "run QA", "kick off the harness", "do a QA pass" | report-mode run |
| "what's broken right now", "list findings" | summarize findings |
| "fix `<finding-id>`", "let's fix the foo bug" | fix-mode session |
| "wipe the QA DB", "reset" | run reset spine only |

Default if ambiguous: report-mode run.

### Step 2 — verify environment

Always run these checks before starting:

1. Confirm working tree is clean (or branch is QA-fix-only).
2. Probe `http://127.0.0.1:5206/api/v1/health` and
   `http://127.0.0.1:3201/api/proxy/api/v1/health`.
3. If either is down, tell the user the exact start command:
   - Backend: `PORT=5206 npm --prefix apps/backend run dev`
   - Admin: `PORT=3201 npm --prefix apps/admin run dev`
4. Verify env vars: `NODE_ENV=qa`,
   `DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test`,
   `VH_QA_RESET_CONFIRM=vhhealth_test`. If missing, print exports.

### Step 3 — run the orchestrator

Default invocation:

```bash
node scripts/qa-orchestrator.mjs
```

Useful variants:

| Goal | Command |
|---|---|
| Skip schema bootstrap (faster, when schema known good) | `node scripts/qa-orchestrator.mjs && # not applicable; reset only via qa-reset.mjs --skip-bootstrap` |
| Stages subset | `node scripts/qa-orchestrator.mjs --stages reset,patient` |
| Live-deploy role sweep | `VH_BASE_URL=https://vh-api.dalekdefender.<...> VH_API_KEY=... node scripts/qa-orchestrator.mjs --include-role` |
| Windows desktop smoke | `node scripts/qa-orchestrator.mjs --include-desktop` |

Artifacts land at `qa-runs/<run_id>/`. **`qa-runs/` is gitignored** —
do not commit it.

### Step 4 — triage failures into findings

For each failing stage, build a finding:

1. Pick a slug: `<area>-<short-symptom>`, e.g. `admin-staff-reactivate-500`.
2. File at `docs/qa-findings/<YYYY-MM-DD>-<slug>.md`.
3. Frontmatter MUST validate against `docs/qa/finding-schema.json`.
   Required keys: `id, run_id, started_at, finished_at, git_sha,
   seed_version, base_url, tenant_id, scenario, command, exit_code,
   severity, area, repro_steps, expected, actual, confidence, status`.
4. Body sections (Markdown):
   - **Symptom** — one paragraph.
   - **Reproduction** — copy-pasteable.
   - **Hypothesis** — what you suspect, marked clearly as a hypothesis.
   - **Artifacts** — links into `qa-runs/<run_id>/`.

Use `seed_version` from `qa-runs/<run_id>/summary.json` (which reads
the latest `qa_seed_meta` row).

If the same failure already has an open finding, append a "Re-observed"
note to the existing file and bump `first_seen_run` if needed —
do not create a duplicate.

### Step 5 — stop

In report-mode the agent stops here. Surface a summary: how many stages
ran, how many passed, paths of new/updated findings, and what the user
should look at first.

**Do not start editing product code.** That requires explicit fix-mode
approval — see below.

## Fix-mode rules

Only enter fix-mode when the user explicitly names a finding to fix
("fix `2026-05-07-foo-bug`" or similar). Then:

1. Confirm working tree is clean.
2. `git checkout -b qa-fix/<finding-id>`.
3. Read the finding. Read the failing stage's stdout/stderr.
4. Make the smallest possible product-code change to fix it.
5. **Do NOT** edit migrations, auth middleware, or RLS code without
   asking the user first.
6. Re-run `node scripts/qa-orchestrator.mjs` and confirm everything
   passes (especially the previously-failing stage).
7. Update finding `status` to `in-fix`, append a "Fix" section.
8. Then default end-of-task git workflow per `feedback_git_workflow.md`:
   commit → push branch → CI → merge --no-ff → push main → delete branch.
9. After merge, update finding `status` to `fixed`, record merge SHA.

## Things to avoid

- Running the harness against `vhhealth` (the dev DB) or any non-loopback
  host — the reset script's six guardrails refuse, but don't try to
  bypass them.
- Editing more than one finding per fix branch.
- Re-using a `run_id` — let the orchestrator generate a new one.
- Treating a `low`/`info` finding as worth a fix-mode session unless
  the user asks.
- Trying to wrap the orchestrator with retries to make a flaky stage
  "pass" — flake is a finding.

## Memory-aware behavior

Per `tools_ai_subscriptions.md`, the user has Claude Max 20x + Codex 20x.
Do not throttle parallel subagents or recommend API-key paths for any
LLM-driven sub-tools used by the harness.

Per `feedback_git_workflow.md`, the default end-of-task git workflow is
commit → push branch → CI → merge --no-ff → push main → delete branch
without asking. Apply this at the end of any fix-mode session.

Per `project_vh_health_dalekdefender.md`, the live deploy is a separate
target. The `--include-role` stage uses live URLs but the rest of the
harness must stay on local smoke env.
