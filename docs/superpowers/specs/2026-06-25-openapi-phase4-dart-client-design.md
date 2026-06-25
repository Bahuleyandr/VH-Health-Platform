# OpenAPI Phase 4 — Dart Client Codegen (Revive + Gate) — Design

**Status:** Approved design (2026-06-25). Sub-project of the OpenAPI contract-pipeline epic (ROADMAP §0 T2 #5; epic spec `2026-06-24-openapi-contract-pipeline-design.md`). Phases 1–3 + the Phase-5 money slice are done; this is **Phase 4** (Dart client gen).

## Goal

Revive the **dead** Dart codegen pipeline so `melos run codegen` produces a valid Dart API client from the now-partly-typed canonical spec (`packages/vhhealth_core/swagger/openapi.json`), verify the existing chopper-client wrapper compiles against it, and gate it in Flutter CI — so future typed Phase-5 slices automatically flow typed Dart models, and spec↔client drift fails CI.

## Scope (decided)

- **Pipeline-only.** Revive codegen + keep the existing `VhhealthApi` chopper client behind the existing `VHAuthInterceptor` wrapper + add a CI codegen/analyze gate. **No app migration** — `apps/patient` and `apps/staff` keep using the hand-written `VHHttpClient` (which has cert-pinning, idempotency, acting-as, offline-queue that the bare chopper client lacks). The generated client exists + is drift-gated but stays **unconsumed**; adopting it in app call sites is a separate future effort.
- **Out of scope:** migrating any app call site to the generated client; adding typed payloads (that's Phase 5); a served/prod OpenAPI surface (D10 — stays internal).

## Current state (what already exists)

Phase 2 scaffolded most of the toolchain:
- `packages/vhhealth_core/pubspec.yaml` already has `swagger_dart_code_generator: ^4.1.1`, `chopper: ^8.6.0`, `chopper_generator`, `json_serializable`, `build_runner`.
- `packages/vhhealth_core/build.yaml` configures the generator to read `swagger/openapi.json` → emit `lib/api/generated/{api.swagger.dart, api.enums.swagger.dart, client_index.dart}` (generated client class `VhhealthApi`). Has the ADR comment: *use swagger_dart_code_generator (not openapi-generator) — pure Dart, no JVM in CI*.
- `lib/api/vhhealth_api.dart` — barrel re-exporting the 3 generated files.
- `lib/api/vh_auth_interceptor.dart` — `VHAuthInterceptor` (chopper `Interceptor`): attaches `x-api-key` + `Authorization: Bearer <jwt>`, on 401 delegates to the **shared** `VHHttpClient.refreshAuthToken()` (single-flight), retries once.
- `lib/api/generated/` is **gitignored** (Phase-2 decision, avoids ~1 MB churn).
- `swagger/openapi.json` is byte-synced from the backend and gated by Phase-2's `check-core-spec-sync.mjs`.
- `melos run codegen` = `melos exec --depends-on="build_runner" -- "dart run build_runner build --delete-conflicting-outputs"`.
- `.forgejo/workflows/openapi-client-drift.yml` runs the Phase-2 spec-sync check + has a Phase-4 placeholder.

The pipeline is **dead** because, until now, the source spec carried only the 3 envelope schemas. The spec now also carries the typed money payloads, so the generated client gains real money models.

## Architecture & data flow

```
apps/backend/src/docs/openapi.json   (canonical, generated)
        │  npm run openapi:sync-core   (gated: check-core-spec-sync.mjs — Phase 2)
        ▼
packages/vhhealth_core/swagger/openapi.json   (byte-identical copy, committed)
        │  melos run codegen  (build_runner + swagger_dart_code_generator)
        ▼
packages/vhhealth_core/lib/api/generated/{api.swagger.dart, api.enums.swagger.dart, client_index.dart}   (gitignored)
        │  imported by
        ▼
lib/api/vhhealth_api.dart (barrel)  +  lib/api/vh_auth_interceptor.dart (VHAuthInterceptor wrapper)
        ▼
(unconsumed by apps in Phase 4 — apps keep VHHttpClient)
```

## The one genuine risk + spike-first contingency

The spec is now **~2636 paths / 2977 ops / ~1.8 MB**. `swagger_dart_code_generator` may produce a very large client and/or be slow under `build_runner`, or choke. **Implementation Task 1 is a feasibility spike:** run `melos run codegen` on the full current spec and measure (succeeds? output size? build time?).

- **Full-spec generates cleanly in reasonable time (target: succeeds + build_runner < ~5 min)** → proceed full-spec. One canonical spec, simplest, matches D4.
- **Full-spec OOMs / times out / produces unusable Dart** → fall back to a curated **typed-subset sub-spec** (the money operations only) as the codegen input, with its own sync + drift note. This branch is taken **only if the spike forces it**, and is surfaced to the user before committing (it diverges from "one canonical spec").

## Generated-artifact policy (decided — reverses D5's letter for Dart)

Keep `lib/api/generated/` **gitignored** + gate via a **CI codegen-smoke**, NOT commit-and-diff. Rationale: (a) `vhhealth_core`'s `.gitignore` already excludes it (Phase-2), and (b) Phase 3 (admin TS) already reversed D5 the same way (gitignored `openapi.generated.ts` + a CI codegen smoke). The drift signal is the CI gate below — no committed 100k-line artifact. (Backend→core *spec* byte-sync stays separately gated by `check-core-spec-sync.mjs`.)

## CI drift gate

**Primary gate — GitHub `ci-flutter.yml` (via `_reusable-flutter-workspace.yml`):** insert a `melos run codegen` step right after `melos bootstrap`, before `analyze`. New flow: **bootstrap → codegen → format → analyze → test.**

How this gates spec↔client drift even though `analysis_options.yaml` excludes `lib/api/generated/**`:
1. **codegen fails** if the current spec produces invalid Dart (build_runner errors) — catches spec changes that break generation.
2. **analyze fails** if the regenerated `VhhealthApi`/models no longer satisfy the **wrapper** (`vh_auth_interceptor.dart` + the `vhhealth_api.dart` barrel are NOT excluded and import generated symbols) — catches the wrapper drifting from the client.

**Secondary — Forgejo `openapi-client-drift.yml`:** keep its Phase-2 spec-sync check; add the codegen step there **only if the Forgejo runner has the Dart/Flutter toolchain** (verified during implementation). If not, the GitHub `ci-flutter` job is the authoritative Dart gate and a comment in the Forgejo workflow says so.

## Components & files

**Modify (all under `packages/vhhealth_core` + 2 CI files):**
- `build.yaml` — verify/adjust the generator config against the current spec (input/output/options); fix anything the now-typed spec needs.
- `lib/api/vhhealth_api.dart` (barrel) — ensure exports match the emitted filenames.
- `lib/api/vh_auth_interceptor.dart` (wrapper) — make it compile against the regenerated client; fix drift.
- `docs/API_CODEGEN.md` — update to reflect the revived pipeline + the gate.
- `.github/workflows/_reusable-flutter-workspace.yml` — add the `melos run codegen` step.
- `.forgejo/workflows/openapi-client-drift.yml` — Phase-4 codegen step if Dart present (else a comment).
- (If the spike forces the subset fallback: a curated sub-spec file + a sync/drift note. Branch only if needed.)

**Create:**
- A Dart **compose smoke test** under `packages/vhhealth_core/test/` that constructs `VhhealthApi.create(baseUrl: …, interceptors: [VHAuthInterceptor()])` (no network) — proving the generated client + wrapper actually compose. Run under `melos test`.

## Testing

- **Codegen + analyze gate** (the CI step) — the structural proof.
- **Compose smoke test** — instantiates the generated client through the wrapper (no network), so `melos test` fails if the generated client API or the interceptor drift apart.
- `melos analyze` + `melos test` over the whole workspace stay green (patient/staff unaffected).

## Task decomposition

- **T1 — feasibility spike:** run `melos run codegen` on the full spec; measure success/size/time. **Decision gate:** full-spec vs curated typed-subset (surface to user if fallback forced).
- **T2 — revive:** make `build.yaml` + barrel + `VHAuthInterceptor` generate + analyze clean from the current spec; fix any drift the now-typed spec introduced.
- **T3 — compose smoke test** + `API_CODEGEN.md` update.
- **T4 — CI gate:** add the codegen step to `_reusable-flutter-workspace.yml` (+ Forgejo if Dart present).
- **T5 — closeout:** full Flutter gates green (bootstrap → codegen → analyze → test); admin/backend unaffected; merge `--no-ff` → both remotes (Forgejo when the tailnet is back); ROADMAP §0 T2 #5 tick (Phase 4 done) + memory.

## Risks & mitigations

- **Full-spec codegen too large/slow** — mitigated by the T1 spike + the typed-subset fallback (surfaced before committing).
- **Generated symbols change name across generator runs** (e.g. `VhhealthApi.create` signature, model names) — the wrapper + compose smoke test catch it; the barrel re-export is the single seam to fix.
- **Forgejo lacks Dart tooling** — GitHub `ci-flutter` is the authoritative Dart gate; Forgejo keeps spec-sync only (documented).
- **Local-dev friction** (fresh clone has no generated client) — already the status quo (gitignored); `melos run codegen` is the documented one-time step (API_CODEGEN.md).

## Success criteria

- `melos run codegen` produces a valid Dart client from the current `swagger/openapi.json`; the `VhhealthApi` client + `VHAuthInterceptor` wrapper compile.
- The compose smoke test passes; `melos analyze` + `melos test` green across the workspace.
- `ci-flutter` runs codegen before analyze (the gate); a spec change that breaks Dart generation or the wrapper now fails CI.
- Generated client stays gitignored; no app call sites changed.
- Merged `--no-ff` to both remotes (Forgejo when reachable); ROADMAP + memory updated. Deploy stays HELD.
