# OpenAPI Phase 2 — Spec Propagation to `vhhealth_core` — Design

**Status:** APPROVED design (2026-06-24). Part of the OpenAPI contract pipeline epic — see `docs/superpowers/specs/2026-06-24-openapi-contract-pipeline-design.md` (Phase 2). Phase 1 (canonical spec + path-set drift gate) is DONE (`main 79be4946`); route-collision cleanup DONE (`main c93e096c`, collisions 0).

## 1. Goal

Make `vhhealth_core`'s OpenAPI spec a **gated, byte-identical copy** of the backend canonical (`apps/backend/src/docs/openapi.json`), killing the fork, and resolve the generated-artifact tracking contradiction.

## 2. Why (verified current state)

- `packages/vhhealth_core/swagger/api.yaml` (984 KB) is the **stale Render-era swagger** (md5 `c70deb4a`) — fully diverged from the canonical `openapi.json` (md5 `dd0ebbe9`). Its `build.yaml` even references the now-deleted `swagger-complete.yaml`.
- `swagger_dart_code_generator` 4.1.1 reads the `swagger/` folder → `lib/api/generated/` (7 files, the **dead** chopper client, 0 consumers in patient/staff).
- `lib/api/generated/` is in `.gitignore` (line 16) **but** the 7 files are committed (tracked) — they predate the ignore rule. A contradiction.

## 3. Decisions (settled)

- **D2-A — Spec copy format: JSON.** Copy `openapi.json` verbatim → `packages/vhhealth_core/swagger/openapi.json` (byte-for-byte). Simplest + most robust drift gate (pure byte-compare, no conversion). `swagger_dart_code_generator` reads JSON. Delete the old `api.yaml` fork.
- **D2-B — Dead generated client: untrack now.** `git rm --cached -r packages/vhhealth_core/lib/api/generated/` so `.gitignore` takes effect; Phase 4 regenerates fresh when the client is wired. (Committing a regenerated 77k-line client now would be Phase-4 work.)

## 4. Architecture

Data flow: backend routes → `generate-openapi.mjs` → `openapi.json` *(gated by `check-openapi-drift`)* → **`sync-openapi-to-core.mjs`** → `vhhealth_core/swagger/openapi.json` *(gated by new `check-core-spec-sync`)* → *[Phase 4: `build_runner` → Dart client]*.

Two independent gates chain: routes↔backend-spec (Phase 1) and backend-spec↔core-spec (Phase 2). The core-sync check is a **pure file compare of two committed files** — no app boot, no DB, no codegen — so it runs anywhere cheaply.

## 5. Components

- **`apps/backend/scripts/sync-openapi-to-core.mjs`** — reads `apps/backend/src/docs/openapi.json`, writes `packages/vhhealth_core/swagger/openapi.json` byte-for-byte (preserving the trailing newline). npm script `openapi:sync-core`. Idempotent; fails loud if the source is missing.
- **`apps/backend/scripts/check-core-spec-sync.mjs`** — asserts the two files are byte-identical; exit 0 = synced, 1 = drift (prints a `run: npm --prefix apps/backend run openapi:sync-core` remediation), 2 = a file is missing. npm script `openapi:check-core`.
- **`packages/vhhealth_core/swagger/openapi.json`** — the synced copy (created by the sync script, committed). **Delete `packages/vhhealth_core/swagger/api.yaml`** (the fork).
- **Untrack** `packages/vhhealth_core/lib/api/generated/**` (`git rm --cached -r`; already `.gitignore`'d).
- **Gates:** add `node scripts/check-core-spec-sync.mjs` to `.github/workflows/_reusable-backend-lint-test.yml` (right after the OpenAPI drift check); restore a spec-copy gate in `.forgejo/workflows/openapi-client-drift.yml` (Phase 1 slimmed it — it installs backend deps, so the pure-Node check runs there); extend the `lefthook.yml` `openapi-drift` pre-push hook to also run the core-sync check.
- **Docs:** fix `packages/vhhealth_core/build.yaml`'s stale comment (`swagger-complete.yaml` → `openapi.json`; note the folder now holds `openapi.json`); fix `packages/vhhealth_core/docs/API_CODEGEN.md`'s refresh-flow note (manual `cp` → `npm run openapi:sync-core`).

## 6. Error handling

- `sync-openapi-to-core.mjs`: if the source `openapi.json` is missing → exit non-zero with a clear message (the backend spec must be generated first).
- `check-core-spec-sync.mjs`: exit 1 on drift with the exact remediation command; exit 2 if either file is absent (infra error, distinct from drift).

## 7. Testing

Mirror Phase 1's gate test (the gate is the test): run `openapi:sync-core` → `openapi:check-core` exits 0; mutate the core copy → `openapi:check-core` exits 1 (drift, with remediation text); re-sync → exits 0. No new jest suite required (the scripts are I/O-only); the CI + lefthook gates are the durable enforcement.

## 8. Out of scope (Phase 4)

Running `build_runner`, regenerating/wiring the Dart client, the `VHHttpClient` interceptor wrapper, and the final generated-artifact tracking policy for the *revived* client. Phase 3 (admin-TS client) is independent and separately scoped.
