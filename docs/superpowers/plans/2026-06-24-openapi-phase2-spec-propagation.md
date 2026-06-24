# OpenAPI Phase 2 — Spec Propagation to `vhhealth_core` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `packages/vhhealth_core/swagger/openapi.json` a gated, byte-identical copy of the canonical `apps/backend/src/docs/openapi.json` (kill the fork), and untrack the dead generated Dart client.

**Architecture:** A pure-Node sync script copies the canonical spec into `vhhealth_core`; a pure-Node check script (byte-compare, no app boot, no DB) gates it; both wire into backend CI, the Forgejo workflow, and lefthook — chaining after Phase 1's routes↔spec gate (routes → spec → core-copy).

**Tech Stack:** Node 22 ESM, GitHub Actions reusable workflow, Forgejo Actions, lefthook. Spec `docs/superpowers/specs/2026-06-24-openapi-phase2-spec-propagation-design.md`.

**Decisions (settled):** JSON verbatim copy (D2-A); untrack the dead client now (D2-B).

---

## File Structure

- Create `apps/backend/scripts/sync-openapi-to-core.mjs` — copy canonical → core.
- Create `apps/backend/scripts/check-core-spec-sync.mjs` — byte-compare gate.
- Create `packages/vhhealth_core/swagger/openapi.json` — the synced copy (generated, committed).
- Delete `packages/vhhealth_core/swagger/api.yaml` — the stale fork.
- Untrack `packages/vhhealth_core/lib/api/generated/**` (git rm --cached; already `.gitignore`'d).
- Modify `apps/backend/package.json` — add `openapi:sync-core` + `openapi:check-core`; add the check to `ci`.
- Modify `.github/workflows/_reusable-backend-lint-test.yml` — add the core-sync check after the OpenAPI drift check.
- Modify `.forgejo/workflows/openapi-client-drift.yml` — add the core-sync check after the spectral step.
- Modify `lefthook.yml` — add a pre-push `openapi-core-sync` hook.
- Modify `packages/vhhealth_core/build.yaml` + `packages/vhhealth_core/docs/API_CODEGEN.md` — fix stale refresh-flow docs.

---

## Task 1: Sync + check scripts, package.json wiring, generate the core copy

**Files:**
- Create: `apps/backend/scripts/sync-openapi-to-core.mjs`, `apps/backend/scripts/check-core-spec-sync.mjs`
- Modify: `apps/backend/package.json`

- [ ] **Step 1: Create the sync script**

```js
#!/usr/bin/env node
// apps/backend/scripts/sync-openapi-to-core.mjs
// Copies the canonical backend OpenAPI spec into the shared Dart package so the
// vhhealth_core Dart client generator (Phase 4) reads ONE source of truth.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendSpec = resolve(__dirname, '..', 'src', 'docs', 'openapi.json');
const coreSpec = resolve(__dirname, '..', '..', '..', 'packages', 'vhhealth_core', 'swagger', 'openapi.json');

if (!existsSync(backendSpec)) {
  console.error(`Source spec missing: ${backendSpec}`);
  console.error('Generate it first: npm --prefix apps/backend run openapi:generate');
  process.exit(2);
}
mkdirSync(dirname(coreSpec), { recursive: true });
writeFileSync(coreSpec, readFileSync(backendSpec));
console.log(`openapi: synced ${backendSpec} -> ${coreSpec}`);
```

- [ ] **Step 2: Create the check script**

```js
#!/usr/bin/env node
// apps/backend/scripts/check-core-spec-sync.mjs
// Fails if packages/vhhealth_core/swagger/openapi.json is not byte-identical to
// the canonical apps/backend/src/docs/openapi.json. Pure file compare — no app
// boot, no DB.
//   0 — synced   1 — drift   2 — a file is missing
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendSpec = resolve(__dirname, '..', 'src', 'docs', 'openapi.json');
const coreSpec = resolve(__dirname, '..', '..', '..', 'packages', 'vhhealth_core', 'swagger', 'openapi.json');

for (const [label, p] of [['backend', backendSpec], ['vhhealth_core', coreSpec]]) {
  if (!existsSync(p)) { console.error(`Missing ${label} spec: ${p}`); process.exit(2); }
}
if (Buffer.compare(readFileSync(backendSpec), readFileSync(coreSpec)) === 0) {
  console.log('✓ vhhealth_core/swagger/openapi.json matches the backend canonical');
  process.exit(0);
}
console.error('✗ vhhealth_core OpenAPI spec is out of sync with the backend canonical');
console.error('');
console.error('Re-sync it:');
console.error('  npm --prefix apps/backend run openapi:sync-core');
console.error('  git add packages/vhhealth_core/swagger/openapi.json');
process.exit(1);
```

- [ ] **Step 3: Wire package.json scripts** — in `apps/backend/package.json`, add after the `"openapi:check"` line:

```
    "openapi:sync-core": "node scripts/sync-openapi-to-core.mjs",
    "openapi:check-core": "node scripts/check-core-spec-sync.mjs",
```

And in the `"ci"` line, insert `&& npm run openapi:check-core` immediately after `&& npm run openapi:check`:
```
    "ci": "npm run lint && npx --yes audit-ci --config .audit-ci.jsonc && npm run openapi:check && npm run openapi:check-core && npx spectral lint src/docs/openapi.json && npm run ci:backend:docker",
```

- [ ] **Step 4: Generate the core copy + verify the gate green-on-clean**

Run:
```bash
cd apps/backend
npm run openapi:sync-core
node scripts/check-core-spec-sync.mjs; echo "exit: $?"
```
Expected: sync prints `synced … -> …`; check prints `✓ … matches …` / `exit: 0`. Confirm `packages/vhhealth_core/swagger/openapi.json` now exists and equals `apps/backend/src/docs/openapi.json` (`cmp -s` is silent).

- [ ] **Step 5: Verify the gate goes RED on drift, then re-sync**

Run:
```bash
cd apps/backend
printf '\n' >> ../../packages/vhhealth_core/swagger/openapi.json
node scripts/check-core-spec-sync.mjs; echo "drift-exit: $?"
npm run openapi:sync-core
node scripts/check-core-spec-sync.mjs; echo "clean-exit: $?"
```
Expected: `drift-exit: 1` (prints the re-sync remediation), then `clean-exit: 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/scripts/sync-openapi-to-core.mjs apps/backend/scripts/check-core-spec-sync.mjs apps/backend/package.json packages/vhhealth_core/swagger/openapi.json
git commit -m "feat(openapi): sync canonical spec into vhhealth_core + drift gate"
```

---

## Task 2: Delete the fork + untrack the dead generated client

**Files:**
- Delete: `packages/vhhealth_core/swagger/api.yaml`
- Untrack: `packages/vhhealth_core/lib/api/generated/**`

- [ ] **Step 1: Delete the stale fork**

```bash
git rm packages/vhhealth_core/swagger/api.yaml
```

- [ ] **Step 2: Untrack the dead generated client** (`.gitignore` line 16 already covers it)

```bash
git rm --cached -r packages/vhhealth_core/lib/api/generated
```

- [ ] **Step 3: Verify** — the files remain on disk (untracked, ignored) and the sync gate is still green:

```bash
ls packages/vhhealth_core/lib/api/generated/ | head -1     # files still present on disk
git status --short packages/vhhealth_core/lib/api/generated/ | head -1   # no output (ignored)
node apps/backend/scripts/check-core-spec-sync.mjs; echo "exit: $?"        # exit: 0
```
Expected: generated files still on disk; `git status` shows nothing for them (ignored); check exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A packages/vhhealth_core/swagger packages/vhhealth_core/lib/api/generated
git commit -m "chore(openapi): drop the vhhealth_core spec fork + untrack the dead generated client"
```

---

## Task 3: Wire the gate into CI, Forgejo, and lefthook

**Files:**
- Modify: `.github/workflows/_reusable-backend-lint-test.yml`, `.forgejo/workflows/openapi-client-drift.yml`, `lefthook.yml`

- [ ] **Step 1: GitHub reusable workflow** — in `.github/workflows/_reusable-backend-lint-test.yml`, immediately after the existing step (lines 88-89):

```yaml
      - name: OpenAPI drift check (regenerate live-router spec + diff)
        run: node scripts/check-openapi-drift.mjs
```
add:
```yaml
      - name: OpenAPI core-spec sync check (vhhealth_core copy matches canonical)
        run: node scripts/check-core-spec-sync.mjs
```

- [ ] **Step 2: Forgejo workflow** — in `.forgejo/workflows/openapi-client-drift.yml`, after the spectral step (lines 66-68):

```yaml
      - name: Lint canonical OpenAPI spec with Spectral
        working-directory: apps/backend
        run: npx spectral lint src/docs/openapi.json
```
add:
```yaml
      - name: vhhealth_core spec-copy sync check
        working-directory: apps/backend
        run: node scripts/check-core-spec-sync.mjs
```

- [ ] **Step 3: lefthook** — in `lefthook.yml`, add a new command under `pre-push:` `commands:` right after the existing `openapi-drift:` block (after line 71's closing `fi`):

```yaml
    openapi-core-sync:
      run: |
        if git diff --name-only @{u}..HEAD 2>/dev/null | grep -qE '^(apps/backend/src/docs/openapi\.json|packages/vhhealth_core/swagger/)'; then
          (cd apps/backend && node scripts/check-core-spec-sync.mjs)
        else
          echo "lefthook pre-push: no OpenAPI spec changes — skipping core-sync check"
        fi
```

- [ ] **Step 4: Validate the YAML parses**

Run: `cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && lefthook validate`
Expected: `All good` (or no parse error). Also confirm the two workflow YAMLs parse with a quick `node -e` YAML check.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/_reusable-backend-lint-test.yml .forgejo/workflows/openapi-client-drift.yml lefthook.yml
git commit -m "ci(openapi): gate the vhhealth_core spec-copy sync (CI + Forgejo + lefthook)"
```

---

## Task 4: Fix stale docs + final verification + finish

**Files:**
- Modify: `packages/vhhealth_core/build.yaml`, `packages/vhhealth_core/docs/API_CODEGEN.md`

- [ ] **Step 1: Fix `build.yaml`'s stale comment** — replace the header line `# Run \`dart run build_runner build --delete-conflicting-outputs\` after / # refreshing \`swagger/api.yaml\` from vh-health-backend/src/docs/swagger-complete.yaml.` with a note pointing at the new flow:

```yaml
# Run `dart run build_runner build --delete-conflicting-outputs` after
# refreshing `swagger/openapi.json` via
# `npm --prefix apps/backend run openapi:sync-core` (synced from the canonical
# apps/backend/src/docs/openapi.json — never edit swagger/openapi.json by hand).
```
(Leave `input_folder: 'swagger/'` — the generator picks up `openapi.json` in that folder.)

- [ ] **Step 2: Fix `API_CODEGEN.md`** — grep it for `swagger-complete.yaml`, `api.yaml`, and manual `cp` instructions, and repoint them to `swagger/openapi.json` synced via `npm --prefix apps/backend run openapi:sync-core`. (Read the file first; update only the refresh-flow lines, not the migration playbook.)

- [ ] **Step 3: Final verification**

Run each:
```bash
cd apps/backend
npx eslint scripts/sync-openapi-to-core.mjs scripts/check-core-spec-sync.mjs   # clean
npm run openapi:check-core; echo "exit: $?"                                     # exit 0
cmp -s src/docs/openapi.json ../../packages/vhhealth_core/swagger/openapi.json && echo IDENTICAL
```
Expected: eslint clean; check exit 0; `IDENTICAL`.

- [ ] **Step 4: Confirm no stray references to the deleted fork**

Run: `cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && grep -rnE "swagger/api\.yaml|swagger-complete" packages/vhhealth_core .github .forgejo --include='*.yaml' --include='*.yml' --include='*.md' --include='*.dart' | grep -v node_modules`
Expected: no results (all repointed).

- [ ] **Step 5: Commit docs**

```bash
git add packages/vhhealth_core/build.yaml packages/vhhealth_core/docs/API_CODEGEN.md
git commit -m "docs(openapi): repoint vhhealth_core codegen docs to the synced openapi.json"
```

- [ ] **Step 6: Finish the branch** — merge `--no-ff` → `main`, push `origin` + `github`, delete branch. Tick ROADMAP §0 T2 #5 (Phase 2 done) + update memory.

---

## Self-Review

- **Spec coverage:** sync script ✓ (Task 1); check script ✓ (Task 1); JSON verbatim copy + delete fork ✓ (Tasks 1-2); untrack dead client ✓ (Task 2); gates CI+Forgejo+lefthook ✓ (Task 3); build.yaml + API_CODEGEN.md docs ✓ (Task 4); testing = gate green/red/green ✓ (Task 1 Steps 4-5). Out-of-scope (build_runner / Dart client) correctly excluded.
- **Placeholder scan:** none — all scripts, commands, and YAML insertions are concrete (API_CODEGEN.md edit is "read-then-repoint the named lines," bounded).
- **Path consistency:** `coreSpec` path `resolve(__dirname,'..','..','..','packages','vhhealth_core','swagger','openapi.json')` identical in both scripts; npm script names `openapi:sync-core`/`openapi:check-core` consistent across package.json, CI, Forgejo, lefthook, and the remediation message.
- **Ordering safety:** the core copy is created (Task 1) before the fork is deleted (Task 2), so `swagger/` is never empty mid-sequence; the gate is wired (Task 3) only after the scripts exist and pass locally.
