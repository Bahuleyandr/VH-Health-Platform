# OpenAPI Contract Pipeline — Epic Design & Phased Plan

**Status:** DESIGN / PAUSED before implementation (2026-06-24). This is the
epic-level design and decomposition. Each phase gets its own
spec → plan → build cycle when resumed.

**Epic (ROADMAP §0 T2 #5):** A single OpenAPI source of truth that the backend
keeps honest, that generates the Dart (`vhhealth_core`) and admin-TS clients,
and that a CI drift gate enforces — so the API contract can never silently
drift from the clients that consume it.

---

## 1. Why (the bug class this closes)

Silent contract drift between the backend's real API surface and the typed
clients that consume it, producing runtime field-mismatch / wrong-shape
failures that no compiler or CI catches. This is **current and concrete**, not
hypothetical:

- The served OpenAPI spec (`apps/backend/src/docs/swagger.yaml`) is **frozen at
  the 2026-04-18 subtree merge** while `app.js` has had ~128 commits since.
  Whole subsystems shipped after that vintage (billing V2, FHIR, CDS,
  clinical-AI planes, tenants/tenant-context, encounters, med-rec, BCMA) are
  **absent from the spec**.
- The spec is **un-regenerable today**: its generator
  (`generate-complete-swagger.js`) reads a route-discovery dump
  (`all-514-routes-clean.json`) that is **gone from disk and git**, so
  `npm run swagger:generate-complete` exits 1.
- The Dart client tolerates **both** snake_case and camelCase with dual-key
  fallbacks (`json['employee_id'] ?? json['employeeId']`) — a defensive hack
  that exists only because there is no enforced contract.
- The admin path map carries a hand-written comment "Backend mounts pharmacy at
  `/api/v1/pharmacy-orders` (not `/pharmacy`)" — a path that already drifted and
  was patched by hand.
- The three spec copies have already **forked** (`vhhealth_core/swagger/api.yaml`
  md5 `c70deb4a` ≠ backend `4a4479c9`).
- CI is **green on all of this** because Spectral only checks OpenAPI
  well-formedness, never truthfulness.

The closing move mirrors the **Prisma schema-drift gates the repo already
trusts** (`check-schema-drift.mjs` / `ci-schema-drift.mjs`): regenerate the
contract from the source of truth and **fail CI on diff**.

## 2. Verified current state

| Surface | Reality (verified) |
|---|---|
| **Backend spec** | One OpenAPI 3.0.3 doc at `apps/backend/src/docs/swagger.yaml` (byte-identical to `swagger-complete.yaml`), machine-generated from a now-missing dump. `components.schemas` has **only** `{Error, Success, PaginatedResponse}`; every operation's `data` is generic `object`. Reality = **121 mounted `/api/v1` routers across 246 route files**; spec coverage ~40–60% at the wrong vintage. The `{success,message,data}` envelope is the one accurate part. |
| **Admin TS** | `api-types.generated.ts` (407 lines) is **dead code — 0 importers**; its header ("generated from live PostgreSQL schema") disagrees with the only wired generator (`generate:types` → `openapi-typescript` on the stale spec, not pinned). Real contract = **~362 hand-written interfaces** across `src/lib/api/*.ts` + a hand-maintained 629-line `api-config.ts` path map. `getJSON<T>` **unwraps** the envelope (returns `.data`), so generated operation types are at the wrong nesting level — codegen needs **Data-only aliases**. |
| **Dart core** | Real layer = hand-written `packages/vhhealth_core/lib/models/api_models.dart` (1172 lines, manual `fromJson/toJson`). A full OpenAPI→Dart pipeline **exists but is dead** (`swagger_dart_code_generator` + chopper via `build.yaml`, 7 committed files ~77k lines) because its source spec has only the 3 envelope schemas. **0 consumers** in patient/staff — both use a hand-written `VHHttpClient` (401-refresh / retry / cert-pin / acting-as / idempotency) the bare chopper client lacks. Generated files are tracked despite being `.gitignore`'d. |
| **CI hook** | Backend CI runs `swagger:validate` + `spectral lint` (structural only — never diffs vs routes, green on a 2-month-stale spec). The **proven drift precedent** (Prisma regenerate-and-diff gates) sits 20 lines below it. A Forgejo workflow (`.forgejo/workflows/openapi-client-drift.yml`) runs `openapi-typescript` to a throwaway artifact — never diffs the committed in-tree types. Flutter CI runs **no codegen**. `lefthook` has path-scoped hooks — a natural home for a fast local check. |
| **Toolchain** | Pure-Node/Dart path is friction-free: Node 22, Dart 3.11.5, Spectral 6.16 (in CI), `swagger_dart_code_generator` 4.1.1 + chopper committed, `melos codegen` exists, `openapi-typescript` already referenced (needs pinning). **JVM 21 is available locally but a committed ADR (`build.yaml`) says avoid `openapi-generator` — no Java in CI.** `express-list-endpoints@7.1.1` is declared-but-unused and **returned 0 endpoints on Express 5** — a live-router enumerator needs an Express-5-correct traversal first. |

## 3. Recommended approach — Hybrid (code-first skeleton + spec-first enrichment)

- **Code-first skeleton (now):** derive the **path + method inventory** and the
  `{success,message,data}` envelope from the **live Express-5 router** every CI
  run. This can never go stale relative to reality, needs no 246-file
  annotation burden, reuses the proven Prisma drift-gate pattern, and needs no
  JVM.
- **Spec-first enrichment (later, incremental):** layer **hand-authored
  request/response component schemas** on top, one high-value subsystem at a
  time, to upgrade `data: object` into real types. Validators describe inputs
  only and cover ~28/246 areas; Prisma rows ≠ API responses — so typed payloads
  must be authored, not auto-derived.

This is incrementally adoptable (no big-bang client rewrite), locally
CI-gateable, dependency-light, and honors the no-JVM ADR. **Generators stay
pure-Node/Dart**: `openapi-typescript` (pinned) for admin, the already-committed
`swagger_dart_code_generator` for Dart. **Generated artifacts are
commit-and-drift-checked** (matching the Prisma convention) — a pure `git diff`
gate, no generator required in CI.

## 4. Phased decomposition

Each phase is independently shippable, locally gateable, reversible, and never
blocks on the expensive data-shape work. Each gets its own spec → plan → build.

### Phase 1 — Canonical spec + path-set drift gate ★ recommended first
- Collapse the 5+ overlapping/forked spec files to **one canonical artifact**
  (delete `swagger-fixed`/`backup`/`-complete` duplicates — `swagger.yaml` ==
  `swagger-complete.yaml` byte-identical anyway).
- Build a **working Express-5 live-router enumerator** (fix or replace
  `express-list-endpoints`; resolve mounts / aliases / dual-mounts / rewrites)
  that emits the path+method inventory wrapped in the existing
  `Success`/`Error`/`PaginatedResponse` envelope.
- Regenerate the canonical spec and commit it (this also **un-bricks** the
  un-regenerable generator).
- Add a **regenerate-and-diff CI step** in `_reusable-backend-lint-test.yml`
  immediately after the Spectral lint, copying `check-schema-drift.mjs`'s
  fail-on-diff shape, gated to **path-set equality** only.
- Add the same path-scoped check to `lefthook`.
- **Deliverable:** the staleness/path-drift bug class is closed with zero
  data-shape work and no JVM.
- **Key risk:** the Express-5 router enumerator — `express-list-endpoints` v7
  returned 0 endpoints on Express 5; the first task must build/validate a
  correct traversal (and de-dupe alias/dual-mount over-counting).

### Phase 2 — Spec propagation (kill the fork)
- Automate the copy `apps/backend` canonical → `packages/vhhealth_core/swagger/api.yaml`
  as a **gated step** (kill the manual `cp` and the md5 fork).
- Resolve the `.gitignore`-vs-tracked contradiction by adopting the Prisma
  **commit-and-drift-check** convention for generated artifacts.

### Phase 3 — Admin-TS client (paths first; lower risk)
- Pin `openapi-typescript`.
- Generate `api-config.ts` path constants + `PROTECTED_ROUTES` from the
  canonical `paths` object; drift-gate them.
- Make `api-types.generated.ts`'s header truthful **or delete it**; introduce
  **Data-only aliases** so generated types match `getJSON<T>`'s unwrapped
  contract.

### Phase 4 — Dart client
- Wire `melos codegen` into Flutter CI with an up-to-date (drift) gate.
- Keep the generated chopper client **behind a wrapper** that runs through
  `VHHttpClient`'s interceptor stack (per `vhhealth_core/docs/API_CODEGEN.md`).
- Migrate feature-by-feature; retire `api_models.dart` incrementally.

### Phase 5 — Typed data payloads (the long tail)
- Enrich the canonical spec with real request/response **component schemas per
  high-value subsystem** (billing → clinical → payroll → discharge), each behind
  its own drift gate.
- Add **contract tests** so authored schemas can't lie about the live server.
- Clinical-AI's 193-type surface is explicitly **deferred to last** (no spec
  backing today).
- Decide here whether backend **casing** is normalized to one convention or
  codegen replicates the Dart dual-key tolerance.

## 5. Open decisions (recommended defaults — confirm on resume)

| # | Decision | Recommended default |
|---|---|---|
| D1 | Source-of-truth direction | **Hybrid** (code-first skeleton now, spec-first enrichment later). For Phase 1 this is purely code-first. |
| D2 | v1 scope / first sub-project | **Phase 1** (path-set + envelope drift gate). Typed payloads deferred to Phase 5. |
| D3 | Data-shape source (Phase 5) | **Hand-authored** component schemas per subsystem (validators = inputs only; Prisma rows ≠ responses). |
| D4 | Canonical file topology | **One file** in `apps/backend` → propagated to `vhhealth_core` by a gated copy. Delete the duplicates/forks. |
| D5 | Generated-artifact policy | **Commit-and-drift-check** (matches Prisma; pure git-diff gate, no generator in CI). |
| D6 | Generator choice / JVM | **Pure Node/Dart** — `openapi-typescript` + `swagger_dart_code_generator`. Explicitly **not** `openapi-generator`, despite local JVM 21 (would diverge local-vs-CI and overturn the `build.yaml` ADR). |
| D7 | Envelope/casing convention | Generated clients return the **unwrapped `.data`** (Data-only aliases). Casing normalization decided in Phase 5. |
| D8 | Drift-gate placement + severity | Backend CI (after Spectral) **+ lefthook**; **block** (fail) like the Prisma gate. Flutter codegen+diff added in Phase 4. |
| D9 | Client scope in v1 | **Backend-first** (spec + drift gate only). Admin TS = Phase 3, Dart = Phase 4. |
| D10 | Served prod surface | **Internal-only** (CI artifact + client codegen). Keep `/api-docs` non-prod and the infra swagger router admin-JWT-gated. |

## 6. Cleanup debt to resolve along the way

- Delete the duplicate/forked spec files; keep one canonical (Phase 1 / D4).
- Un-brick or replace the missing-input generator (Phase 1).
- Decide the fate of the **dead** admin `api-types.generated.ts` and the **dead**
  Dart `lib/api/generated/` chopper client — revive under the new pipeline
  (Phases 3/4) or delete as cruft.
- Reconcile `.gitignore`-vs-tracked for generated Dart files (D5).

## 7. Out of scope (YAGNI)

- A public/served production OpenAPI surface (stays internal — D10).
- `openapi-generator` / any JVM toolchain (D6).
- Big-bang client rewrite or full typed-payload coverage in v1 (Phase 5 is
  incremental, subsystem-by-subsystem).
- Backend casing normalization before Phase 5.

## 8. Resume pointer

When resuming: confirm the **Phase 1** scope + the D1–D10 defaults above, then
this enters `writing-plans` for the **Phase 1** implementation plan
(canonical spec + Express-5 enumerator + regenerate-and-diff CI gate + lefthook
hook). The pivotal technical unknown to de-risk first is the **Express-5
router enumerator** (§4 Phase 1 key risk).
