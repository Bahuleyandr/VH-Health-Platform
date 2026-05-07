# QA harness — modes of operation

The harness has two modes. **Report mode is the default** and the only
mode the orchestrator runs unattended. Fix mode is per-finding, gated by
human approval, and never automatic.

## report-mode (default)

What it does:

- Runs `scripts/qa-orchestrator.mjs` end-to-end.
- Captures `qa-runs/<run_id>/{stage}/{stdout.txt,stderr.txt,meta.json}`.
- For each failed stage, opens / appends a finding under
  `docs/qa-findings/<date>-<slug>.md`, with frontmatter validating
  against `docs/qa/finding-schema.json`.
- Stops there. Does not edit product code, does not modify migrations,
  does not change config.

The only writes report-mode is allowed to make:

- `qa-runs/**` (gitignored)
- `docs/qa-findings/<date>-*.md` (committed)
- A row in `qa_seed_meta` (the reset spine writes this)

If any tool wants to do something outside that list while in report
mode, it must stop and ask. No exceptions.

## fix-mode (gated, per-finding)

Workflow:

1. Pick **one** finding from `docs/qa-findings/`.
2. Human approves the fix attempt — explicitly, in the conversation
   ("yes, fix `2026-05-07-foo-bug`").
3. Agent creates a branch named `qa-fix/<finding-id>`.
4. Agent edits product code to address only that finding. No
   tangential refactors, no opportunistic cleanup.
5. Agent re-runs `scripts/qa-orchestrator.mjs` against the fixed branch.
   The orchestrator **must** pass, including the previously-failing
   stage.
6. Agent updates the finding's `status` to `in-fix`, adds the diff
   summary, and pushes the branch.
7. Human merges through the standard end-of-task git workflow
   (`commit → push → CI → merge --no-ff → push main → delete branch`).
8. After merge, agent updates the finding's `status` to `fixed`,
   records the merge SHA in `linked_issues`, and re-runs orchestrator
   on `main` to confirm.

What fix-mode is NOT allowed to do:

- Modify migrations under `apps/backend/src/migrations/` without
  explicit human approval.
- Touch security-sensitive code (`apps/backend/src/middleware/auth*`,
  `apps/backend/src/utils/AppError.js`, RLS / `setTenant` paths)
  without explicit human approval.
- Edit more than one finding per branch.
- Skip the post-fix orchestrator pass.

## Severity → mode hint

The harness writes `severity` in the finding's frontmatter. Severity is
a hint, not authority — humans approve.

| Severity | Hint |
|---|---|
| `critical` | Immediate fix candidate. Likely fix-mode now. |
| `high` | Fix soon, schedule the fix-mode session. |
| `medium` | Triage and batch with similar findings. |
| `low` | Worth keeping; may stay open indefinitely. |
| `info` | Observation; close as `wont-fix` after recording. |

## Status transitions

```
                 (report-mode)               (fix-mode merged)
   ┌─ open ─────────────────────────► in-fix ────────────────► fixed
   │                                       │
   │                                       └──► wont-fix
   │
   ├─ duplicate     (close, link to canonical id)
   └─ false-positive (close with reason in body)
```

## Operational loop (each cycle)

1. **Run** (report-mode).
   ```bash
   node scripts/qa-orchestrator.mjs
   ```
   On success: nothing to do, surface a green-pass note and stop.
   On failure: continue to step 2.

2. **Triage**. For each failing stage in `qa-runs/<run_id>/summary.json`:
   - Read `qa-runs/<run_id>/<stage>/{stdout,stderr}.txt`.
   - Decide: new finding, duplicate of an existing finding, or
     false-positive.
   - For new findings, write the Markdown under `docs/qa-findings/`
     with frontmatter validating against
     `docs/qa/finding-schema.json`.
   - For duplicates, append a "Re-observed in `<run_id>`" line to the
     existing finding.

3. **Stop here in report-mode.** Do not edit product code. Surface a
   summary listing new findings + duplicates touched.

4. **(Optional) Fix-mode session.** Only if the user explicitly names
   one finding to fix:
   - `git checkout -b qa-fix/<finding-id>`
   - Smallest possible product-code change.
   - Do not modify `apps/backend/src/migrations/`, auth middleware,
     or RLS code without explicit human confirmation.
   - Re-run `node scripts/qa-orchestrator.mjs`. Must pass.
   - Update finding `status` to `in-fix`.
   - Commit → push branch → CI → merge `--no-ff` → push main → delete
     branch (per `feedback_git_workflow.md`).
   - After merge: update finding `status` to `fixed`, record merge SHA
     in `linked_issues`.

5. **(Optional) Cycle retro.** Per
   `feedback_decision_protocol.md`, offer the cycle-retro agent at the
   end of a feature, day, sprint, or build cycle.

## Anti-patterns

- Wrapping `qa-orchestrator.mjs` in a retry loop to make a flaky stage
  pass — flake is a finding.
- Editing more than one finding per fix branch — ratchet, don't bundle.
- Skipping the post-fix orchestrator pass to "save time."
- Closing a finding without recording the merge SHA — orphan
  reproductions are how regressions sneak back.
- Running fix-mode autonomously — it is gated by explicit user
  approval per finding. No exceptions.
