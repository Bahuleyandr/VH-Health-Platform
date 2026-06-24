# OpenAPI Phase 5 (Money) — Typed Request/Response Payloads — Design

**Status:** Approved design (2026-06-24). Sub-project of the OpenAPI contract-pipeline epic (ROADMAP §0 T2 #5; epic spec `2026-06-24-openapi-contract-pipeline-design.md`). Phases 1–3 done; this is the first **Phase 5** slice (typed payloads), scoped to the **money/billing** subsystem.

## Goal

The canonical spec (`apps/backend/src/docs/openapi.json`) is currently **path-only**: every operation has no `requestBody` and a single generic `200 → #/components/schemas/Success` whose `data` is an untyped object. So `openapi-typescript` emits `Record<string, never>` for every payload, and the contract pipeline carries no real types.

Phase 5 (money) attaches **typed request and response payload schemas** to the whole money/billing surface — V1 billing, V2 billing, billing-masters, and the GL ledger reports — so that:
- the spec documents the real money payloads;
- `openapi-typescript` emits real types for them;
- the admin portal consumes those types via a **Data-only alias** (`getJSON<T>` returns the unwrapped `.data`);
- a two-layer contract test proves the hand-authored schemas match the real runtime payloads.

This establishes the **reusable machinery** for all later Phase 5 slices (clinical → payroll → discharge → clinical-AI), which are out of scope here.

## Scope (decided)

- **Subsystem:** whole money/billing surface (~39 response + ~25 request schemas across `billingRoutes.js` (V1), `billingV2Routes.js`, `billingMastersRoutes.js`, `ledgerReportsRoutes.js`).
- **Direction:** **both** request bodies and responses.
- **Request-body fidelity:** V1 billing + billing-masters request schemas derive from their express-validator chains (strict, `additionalProperties:false`). V2 routes have **no validators** — their request schemas are reverse-engineered from the service code + admin TS types, authored **permissively** (`additionalProperties:true`, known fields typed, each carrying a `description` flagging it as not-validator-backed). This is an honest fidelity signal, not a silent guess.
- **Contract verification:** comprehensive — a static gate (always runs) + live assertions woven into the existing money deep tests, reusing their fixtures; new fixtures only where a sub-surface has no existing test.
- **Query parameters are out of scope this phase.** The overlay types request **bodies** + responses only; typing query params (pagination/filter/date-range) is a deliberate future enhancement (the overlay shape leaves room for a `query` key but it is unused here). Existing string path params remain as today.
- **Out of scope (future Phase 5 slices):** clinical, payroll, discharge, clinical-AI (~193 types) payloads; Phase 4 (Dart client gen).

## Architecture & data flow

A new directory `apps/backend/scripts/openapi/schemas/` holds **per-subsystem overlay modules**; the first is `money.mjs`. Each module is pure data:

```js
import { envelope, paginatedEnvelope } from './_helpers.mjs';
export const schemas = {
  TrialBalance: { type: 'object', additionalProperties: false, properties: { /* … */ } },
  TrialBalanceResponse: envelope('TrialBalance'),
  CreateInvoiceRequest: { type: 'object', additionalProperties: false, required: ['patient_uid', 'total_amount'], properties: { /* … */ } },
  // …
};
export const operations = {
  'GET /api/v1/admin/ledger/trial-balance': { response: 'TrialBalanceResponse' },
  'POST /api/v1/billing/invoice':           { request: 'CreateInvoiceRequest', response: 'InvoiceResponse' },
  // …
};
```

`generate-openapi.mjs` imports a registry of these modules (`const SCHEMA_MODULES = [money]`), **deterministically merges** every module's `schemas` into a copy of `OPENAPI_BASE.components.schemas` (sorted keys; **errors on a duplicate schema name** across modules), builds one combined `operations` overlay, and calls `buildOpenApiDocument(routes, augmentedBase, overlay)`.

`buildOperation(method, path, opId, ov)` looks up `${METHOD} ${path}` in the overlay:
- **present** → set `requestBody` (`$ref` request schema, `required: true`) and `responses[200].content['application/json'].schema = { $ref: <ResponseSchema> }`;
- **absent** → unchanged generic `Success` fallback.

Overlay keys reference the **canonical** path (the lexicographically-smallest survivor of the param-equivalent collapse in `buildOpenApiDocument`). The static gate enforces that every overlay key matches a real generated `(method, path)`, so a stale/non-canonical key fails CI rather than silently no-op'ing.

Determinism (code-unit `cmp` sort), the param-collapse, `check-openapi-drift.mjs`, and `check-core-spec-sync.mjs` are all preserved — the modules are committed, so regeneration is stable and the existing gates diff the enriched document.

## Schema-authoring conventions

Three schema kinds per typed endpoint, plus shared helpers in `scripts/openapi/schemas/_helpers.mjs`:

1. **Payload schemas** — the `data` shape itself (`TrialBalance`, `Invoice`, `PaymentResult`, `AgingReport`, …). `additionalProperties: false` so the live contract tests catch **both missing and extra** fields. Reused across endpoints (e.g. `Invoice` for create + detail).
2. **Response envelope schemas** — `<X>Response`, produced by `envelope('<Payload>')`:
   ```js
   export const envelope = (payload) => ({
     type: 'object',
     required: ['success', 'data'],
     properties: {
       success: { type: 'boolean', example: true },
       message: { type: 'string' },
       data: { $ref: `#/components/schemas/${payload}` },
     },
   });
   ```
   Keeping `data` a direct property is what makes the admin Data-only alias a trivial `['data']` index. List endpoints use `paginatedEnvelope('<Payload>')` → `data: { items: [{ $ref }], pagination: { page, limit, total, totalPages } }`.
3. **Request schemas** — `<X>Request`. **V1 billing + masters:** strict (`additionalProperties:false`, `required` from the validator chains). **V2:** permissive (`additionalProperties:true`, known fields typed, `description` flags reverse-engineered-from-service).

**Type conventions:** integer **paise** fields (`*Paise`, `*_minor`) → `type:'integer'`; formatted ₹ display strings → `type:'string'`; enums (`payment_method`, invoice `status`, aging `bucket`, account `type`) → `enum:[…]`; ids → `integer` or `string` + `format:'uuid'` per the actual column. Each payload's fields are cross-checked against **both** the service return and the existing admin TS interface (`apps/admin/src/lib/api/{billing,ledgerReports}.ts`) during authoring; the live contract test is the binding proof.

## Contract verification (two layers)

**Layer 1 — static gate** (`apps/backend/src/tests/unit/openapiMoneyContracts.test.js`, a pure jest unit test: no DB, runs in the normal backend suite + CI automatically — lighter than a new CI-wired script and always exercised):
- Every overlay key resolves to a real `(method, path)` in the generated `openapi.json` (catches stale/non-canonical keys).
- Every `request`/`response` schema named in the overlay exists in `components.schemas` (no dangling `$ref`).
- **ajv** (+ `ajv-formats`; both already `apps/backend` devDeps) compiles every `components.schemas` entry → all schemas are valid JSON Schema and mutually resolvable.
- Spectral 0-errors + openapi-drift 0 + core-sync 0 already gate the enriched doc and keep running.

**Layer 2 — live assertions woven into the existing money deep tests.** A shared helper `apps/backend/src/tests/helpers/assertSchema.js` loads `openapi.json` once and exposes:
- `assertData(schemaName, dataObj)` — ajv-validate a payload against its named schema, for service-return deep tests (e.g. `money-ledger-reports.deep.test.js` → `assertData('TrialBalance', tb)`);
- `assertResponse(method, path, resBody)` — validate a full supertest `res.body` against the operation's response schema, for HTTP deep tests (e.g. `billing.test.js` → `assertResponse('POST', '/api/v1/billing/invoice', res.body)`).

Because payloads are `additionalProperties:false`, any drift between schema and runtime fails the test. New minimal fixtures are authored only for sub-surfaces with no existing test (cash-drawer, payment-links, refunds, masters). Layer 1 ties operation→schema; Layer 2 ties schema→runtime; together they prove operation↔schema↔reality.

## Admin Data-only alias

A small committed helper, `apps/admin/src/lib/openapi-data.ts`:
```ts
import type { paths } from './openapi.generated';
type Ok<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
export type ApiData<P extends keyof paths, M extends keyof paths[P]> =
  Ok<P, M> extends { data?: infer D } ? D : never;        // the unwrapped .data payload
export type ApiBody<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
```
`openapi-typescript` resolves the 200 response to the component type directly (not a `{ $ref }` literal), so `ApiData` is a clean property index — no `$ref`-string parsing.

The proof: `apps/admin/src/lib/api/ledgerReports.ts` + `billing.ts` drop their hand-authored response interfaces and re-export spec-derived aliases, e.g.
```ts
export type TrialBalance = ApiData<'/api/v1/admin/ledger/trial-balance', 'get'>;
```
so the admin types can no longer drift from the spec.

**Generated-types consumption (decided: option a).** `openapi.generated.ts` stays **gitignored** (Phase-3 rationale: don't commit the ~104k-line artifact). Because committed admin code now imports `paths` from it, add npm pre-hooks so the `npm run` flows regenerate first: `pretype-check`, `pretest`, `predev`, `prebuild` each run `generate:types`. CI already runs `generate:types` as an explicit step before type-check/test/build, so CI is covered regardless. Local direct `npx tsc`/editor use needs a one-time `npm run generate:types` — documented in `apps/admin/CLAUDE.md`. (Rejected alternative (b): commit + drift-gate the generated file — zero friction but a 104k-line churn-prone artifact.)

## Task decomposition & ordering

Large (~64 schemas) but built in independently-green increments on shared machinery first. The writing-plans skill expands each into bite-sized TDD steps.

- **T1 — machinery:** `_helpers.mjs` (`envelope`/`paginatedEnvelope`), the `buildSpec.mjs` overlay change + `generate-openapi.mjs` module-merge, an **empty** `money.mjs`. Prove regen output is byte-identical with an empty overlay (drift stays green) before any schema authoring.
- **T2 — gate + alias scaffolding:** the Layer-1 static unit test, `assertSchema.js`, admin `openapi-data.ts`, the option-(a) pre-hooks + CLAUDE.md note. Pass trivially while `money.mjs` is empty.
- **T3–T8 — per sub-surface** (each: author schemas → wire overlay → weave live contract assertions → regen + all gates green):
  - **T3** GL ledger reports (5 ep, ~8 schemas) — cleanest, existing deep test.
  - **T4** V1 billing core — invoice/payment/insurance-claim (~10 schemas, validator-backed requests).
  - **T5** V2 invoices — create/items/itemize/discount/issue/void/tpa-decision/non-payable (~12 schemas).
  - **T6** V2 payments/advances/refunds (~10 schemas).
  - **T7** V2 cash-drawer + payment-links (~9 schemas, new fixtures).
  - **T8** billing-masters — payers/tpas/tariff-plans/tariff-items/packages/links/resolve-price (~10 schemas, validator-backed).
- **T9 — admin adoption + closeout:** convert `ledgerReports.ts` + `billing.ts` to `ApiData` aliases; full gates (backend lint/spectral/drift/core-sync/contract-unit + suite; admin tsc/jest/build); merge `--no-ff` → both remotes; ROADMAP §0 T2 #5 tick (Phase 5 money slice done); memory.

**Ordering rationale:** machinery + cleanest slice (ledger) first to validate the whole pipeline end-to-end (including the admin alias) before the bulkier V2 surface. Each of T3–T8 is independently shippable (regen + gates green), so the big plan stays reviewable.

## File structure

**New:**
- `apps/backend/scripts/openapi/schemas/_helpers.mjs` — `envelope`, `paginatedEnvelope`.
- `apps/backend/scripts/openapi/schemas/money.mjs` — money `schemas` + `operations` overlay.
- `apps/backend/src/tests/unit/openapiMoneyContracts.test.js` — Layer-1 static gate.
- `apps/backend/src/tests/helpers/assertSchema.js` — `assertData` / `assertResponse`.
- `apps/admin/src/lib/openapi-data.ts` — `ApiData` / `ApiBody` helpers.

**Modified:**
- `apps/backend/scripts/openapi/buildSpec.mjs` — `buildOperation`/`buildOpenApiDocument` overlay support.
- `apps/backend/scripts/generate-openapi.mjs` — schema-module registry + merge.
- `apps/backend/src/docs/openapi.json` — regenerated (typed).
- `packages/vhhealth_core/swagger/openapi.json` — re-synced (byte-identical).
- `apps/backend/src/tests/money-ledger-reports.deep.test.js`, `billing.test.js`, + other money deep tests — live contract assertions.
- `apps/admin/src/lib/api/ledgerReports.ts`, `billing.ts` — spec-derived `ApiData` aliases.
- `apps/admin/package.json` — `pretype-check`/`pretest`/`predev`/`prebuild` hooks.
- `apps/admin/CLAUDE.md` — one-time `generate:types` setup note.

## Risks & mitigations

- **V2 request fidelity** — no validators → permissive, flagged schemas. Mitigation: honest `additionalProperties:true` + `description`; responses (the high-value, codegen-consumed side) stay strict and contract-tested.
- **Schema-vs-runtime drift** — mitigated by Layer-2 live contract tests with `additionalProperties:false` payloads (catches missing AND extra fields).
- **Overlay key staleness** (path renames / param-collapse) — mitigated by the Layer-1 static gate (every overlay key must match a real canonical `(method, path)`).
- **Generated-types local friction** — mitigated by npm pre-hooks + a documented one-time `generate:types`; CI generates before consuming.
- **tsc cost of importing the ~104k-line `openapi.generated.ts`** — types-only (erased at build); acceptable single-file parse cost; noted.

## Success criteria

- The money surface (V1 + V2 + masters + ledger) carries typed `requestBody` (where in scope) + typed `200` responses in `openapi.json`; `openapi-typescript` emits real types for them.
- Layer-1 static gate + Layer-2 live contract tests green; spectral 0-errors; openapi-drift 0; core-sync 0.
- `ledgerReports.ts` + `billing.ts` consume spec-derived `ApiData` aliases (no hand-authored response interfaces left).
- Admin tsc + jest + next build green; backend suite green.
- Merged `--no-ff` to both remotes; ROADMAP ticked; memory updated. Deploy stays HELD.
