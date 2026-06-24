# OpenAPI Phase 3 — Admin Path-Drift Gate + Pipeline Hygiene — Design

**Status:** APPROVED design (2026-06-24). Part of the OpenAPI contract pipeline epic — see `docs/superpowers/specs/2026-06-24-openapi-contract-pipeline-design.md` (Phase 3). Phase 1 (canonical spec + drift gate) + collision cleanup + Phase 2 (spec→vhhealth_core) are DONE (`main aa888dcc`).

## 1. Goal

Gate the admin portal's hand-curated API path map against the canonical OpenAPI spec (kill the silent path-drift bug class), and make the generated-types pipeline honest + hermetic. The **typed** admin client is deferred to Phase 5, where per-endpoint payload schemas make generation worthwhile.

## 2. Why (verified current state)

- The admin's endpoints are opaque path strings in a single hand-maintained map `apps/admin/src/lib/api-config.ts` (`API_ENDPOINTS`, ~279 leaves = 262 literal strings + 17 `(param) => template` arrow fns, 22 human-semantic groups, depth ≤4). Response typing is hand-rolled: each call site passes `getJSON<HandWrittenDTO>` where `T` is the **inner unwrapped `data`** (`core.ts:187-194`, `fetchAdminAPI:276-284` both return `body.data`). ~264 hand-written DTOs across `src/lib/api/`.
- **PATH drift is real:** ~41 api-config leaves are truly absent from the 2613-path spec — dead `*/routes` placeholders (`/staff/routes`, `/sos/routes`, `/rbac/routes`, `/investigations/routes`), stale renames (`/departments/comparison` vs spec `/departments/stats/comparison`), wrong pharmacy paths (`/medications/staff|admin` vs `/medications/{id}`), `/verify`. ~14 more are legitimate nav/mount bases (children exist, no own operation). This is the `pharmacy mounts at /pharmacy-orders not /pharmacy` class.
- **The generated-types pipeline is broken:** `generate:types` runs `npx openapi-typescript ../backend/src/docs/openapi.json -o src/lib/api-types.generated.ts`, but (a) `openapi-typescript` is unpinned (bare `npx`), (b) the output path is occupied by a 407-line hand-curated DB-mirror with a **false provenance header** ("generated from the Postgres schema") and **0 importers** (dead code), (c) running the script clobbers that with a ~103k-line orphan.
- **Dominating constraint:** the spec is path-only. Every operation `$ref`s the single `Success` schema whose `data` is a propertyless `object` → `openapi-typescript` emits `Record<string, never>` for all 2952 operations. So generated *types* are strictly worse than the hand-written DTOs **until Phase 5** attaches payload schemas.

## 3. Decisions (settled)

- **D3-A — Path map: GATE, not generate.** Keep the human-curated tree; add a jest subset test. Auto-generation is intractable (editorial groups, 50/262 keys diverge from the URL tail, one backend route reused under multiple curated keys) and would break all 44 call sites.
- **D3-B — Generated types: pin + redirect + gitignore + CI smoke.** Pin `openapi-typescript` exactly; redirect `generate:types` output to a **gitignored** `src/lib/openapi.generated.ts` (not committed — 103k lines, no consumer yet); delete the dead DB-mirror; add a CI codegen smoke (run the generator, prove the spec stays codegen-able). No committed artifact, no churn, no drift gate over an unimported file.
- **D3-C — Data-only type alias: DEFER to Phase 5.** Today it yields generic `{}` for all 2952 ops and would masquerade as coverage. Lands with the first real typed payloads.

## 4. Architecture

`openapi.json` → **[path gate: `API_ENDPOINTS` ⊆ spec `paths`]** (jest) + **[codegen smoke: `openapi-typescript` succeeds]** (CI) → *[Phase 5: payload schemas → typed client + Data alias]*. The path gate is a one-directional subset check (admin ⊆ spec), not a full bijection — the spec legitimately has thousands of paths the admin doesn't call.

## 5. Components

- **`apps/admin/src/__tests__/lib/api-config-spec-subset.test.ts`** — imports `API_ENDPOINTS`; recursively walks it; for each `(param) => template` arrow fn, invokes it with a sentinel arg; normalizes `:param` and `${sentinel}` → `{X}`; reads `apps/backend/src/docs/openapi.json` via `fs` (relative to `__dirname`); asserts each normalized leaf path exists in the spec's `paths`, OR is covered by an explicit inline `ALLOWLIST` (the ~14 nav/mount bases + `/api-docs` + `/ws` + non-`/api/v1` infra). Failure prints the offending api-config key→path pairs.
- **`apps/admin/src/lib/api-config.ts`** — fix the ~41 broken leaves so the gate passes. Each fix is cross-checked against the backend route registration (grep `apps/backend/src/routes/**`), not just the spec, before deleting/renaming.
- **`apps/admin/package.json`** — add `openapi-typescript` as an exact devDependency (`7.13.0`); change `generate:types` output to `src/lib/openapi.generated.ts`.
- **`apps/admin/.gitignore`** — add `src/lib/openapi.generated.ts`.
- **Delete** `apps/admin/src/lib/api-types.generated.ts` (0 importers, false provenance).
- **`.github/workflows/_reusable-admin-ci.yml`** — add a "Generate admin OpenAPI types (codegen smoke)" step running `npm run generate:types` (proves the spec is codegen-able; the gitignored output is discarded).

## 6. Error handling

- The jest test fails with a clear, deduplicated list of `API_ENDPOINTS` paths absent from the spec, and instructs whether to fix the path or add it to `ALLOWLIST` (with the rule: allowlist only nav/mount bases + non-API infra, never a real-but-wrong API path).
- The codegen smoke fails (non-zero) if `openapi-typescript` can't parse the spec — a tripwire that the spec stays generatable.

## 7. Testing

The path-drift test **is** the gate (rides the existing admin `npm test` + the `admin-jest` lefthook hook — no new CI wiring). The ~41 api-config fixes are verified by admin jest (full suite) + `tsc --noEmit` + `next build` (no call site breaks). The codegen smoke is verified by running `npm run generate:types` locally to confirm it succeeds and writes the gitignored file.

## 8. Out of scope (Phase 5)

The Data-only type alias, adopting generated types at any call site, typed per-endpoint payloads, and any drift gate over the (unimported) generated types file. The Dart client is Phase 4.
