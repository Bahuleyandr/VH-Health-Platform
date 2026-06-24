# OpenAPI Phase 5 (Money) — Typed Payloads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach typed request/response payload schemas to the whole money/billing surface of the canonical OpenAPI spec, so codegen emits real types and a two-layer contract test proves the schemas match runtime.

**Architecture:** Per-subsystem overlay modules (`scripts/openapi/schemas/money.mjs`) export named JSON schemas + an `operations` map keyed by `"<METHOD> <path>"`. `generate-openapi.mjs` merges the schemas into `components.schemas` and passes the overlay to `buildOperation`, which attaches `requestBody`/typed `200` responses (falling back to the generic `Success`). A static jest gate + live deep-test assertions (ajv) verify the schemas; the admin portal consumes the generated types via an `ApiData` "Data-only" alias.

**Tech Stack:** Node 22 ESM, jest (backend: `--experimental-vm-modules`), ajv 8 + ajv-formats (already backend devDeps), openapi-typescript 7.13 (admin), spectral, lefthook. Spec: `docs/superpowers/specs/2026-06-24-openapi-phase5-money-typed-payloads-design.md`.

**Conventions used throughout (read once):**
- Run all backend commands from `apps/backend`, admin from `apps/admin`.
- Regenerate the spec: `node scripts/generate-openapi.mjs` (writes `src/docs/openapi.json`).
- Re-sync the core copy: `npm run openapi:sync-core`.
- The backend jest invocation is `node --experimental-vm-modules node_modules/jest/bin/jest.js <args> --forceExit` (ESM). Shorthand below: `JEST=...`.
- Money is integer **paise** (`*Paise`, `*_minor` → `type:'integer'`); formatted `₹` strings → `type:'string'`.
- Payload schemas use `additionalProperties:false`; V2 request schemas (no validators) use `additionalProperties:true` + a `description` flagging reverse-engineered-from-service.
- Push at task boundaries is NOT required; the final task (T9) merges `--no-ff` to both remotes. Commit after every task.

---

## File Structure

**New files:**
- `apps/backend/scripts/openapi/schemas/_helpers.mjs` — `envelope(payload)`, `paginatedEnvelope(item)` builders. One responsibility: shared envelope shapes.
- `apps/backend/scripts/openapi/schemas/money.mjs` — money `schemas` + `operations` overlay. Grows per sub-surface (T3–T8).
- `apps/backend/src/tests/unit/openapiMoneyContracts.test.js` — Layer-1 static gate (no DB).
- `apps/backend/src/tests/helpers/assertSchema.js` — `assertData` / `assertResponse` ajv helpers for Layer-2.
- `apps/admin/src/lib/openapi-data.ts` — `ApiData` / `ApiBody` generic type helpers.

**Modified files:**
- `apps/backend/scripts/openapi/buildSpec.mjs` — `buildOperation` + `buildOpenApiDocument` overlay support.
- `apps/backend/scripts/generate-openapi.mjs` — schema-module registry + merge.
- `apps/backend/src/docs/openapi.json` — regenerated (typed); committed each task.
- `packages/vhhealth_core/swagger/openapi.json` — re-synced; committed each task.
- `apps/backend/src/tests/money-ledger-reports.deep.test.js`, `billing.test.js`, + V2/masters deep tests — live contract assertions.
- `apps/admin/src/lib/api/ledgerReports.ts`, `billing.ts` — spec-derived `ApiData` aliases (T9).
- `apps/admin/package.json` — `pretype-check`/`pretest`/`predev`/`prebuild` hooks.
- `apps/admin/CLAUDE.md` — one-time `generate:types` setup note.

---

## Task 1: Machinery — helpers, generator overlay, empty money module

**Goal:** Make the generator overlay-capable without changing any output yet (empty `money.mjs` ⇒ byte-identical `openapi.json`).

**Files:**
- Create: `apps/backend/scripts/openapi/schemas/_helpers.mjs`
- Create: `apps/backend/scripts/openapi/schemas/money.mjs`
- Modify: `apps/backend/scripts/openapi/buildSpec.mjs` (`buildOperation`, `buildOpenApiDocument`)
- Modify: `apps/backend/scripts/generate-openapi.mjs`
- Test: `apps/backend/src/tests/unit/openapiBuildSpec.test.js` (existing — extend)

- [ ] **Step 1: Write the failing unit test for overlay attachment**

Append to `apps/backend/src/tests/unit/openapiBuildSpec.test.js`:

```js
import { buildOpenApiDocument } from '../../../scripts/openapi/buildSpec.mjs';

describe('buildOpenApiDocument overlay', () => {
  const base = { openapi: '3.0.3', components: { schemas: {} } };

  it('attaches request + response $refs from the overlay', () => {
    const routes = [{ method: 'post', path: '/api/v1/x' }];
    const overlay = { 'POST /api/v1/x': { request: 'XReq', response: 'XResp' } };
    const doc = buildOpenApiDocument(routes, base, overlay);
    const op = doc.paths['/api/v1/x'].post;
    expect(op.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/XReq' });
    expect(op.responses[200].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/XResp' });
  });

  it('falls back to the generic Success response when no overlay entry exists', () => {
    const routes = [{ method: 'get', path: '/api/v1/y' }];
    const doc = buildOpenApiDocument(routes, base, {});
    const op = doc.paths['/api/v1/y'].get;
    expect(op.responses[200].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Success' });
    expect(op.requestBody).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiBuildSpec.test.js --forceExit`
Expected: FAIL — `buildOpenApiDocument` ignores the third arg; `requestBody` is undefined and response is `Success` in the first test.

- [ ] **Step 3: Add overlay support to `buildSpec.mjs`**

In `apps/backend/scripts/openapi/buildSpec.mjs`, replace `buildOperation` (currently lines ~43-58) with:

```js
/** Build one OpenAPI operation. With an overlay entry, attach typed request/response. */
function buildOperation(method, openApiPath, opId, ov) {
  const op = {
    operationId: opId,
    responses: {
      200: {
        description: 'Successful response',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
      },
    },
  };
  const params = pathParamNames(openApiPath).map((name) => ({
    name, in: 'path', required: true, schema: { type: 'string' },
  }));
  if (params.length) op.parameters = params;
  if (ov && ov.response) {
    op.responses[200].content['application/json'].schema = { $ref: `#/components/schemas/${ov.response}` };
  }
  if (ov && ov.request) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${ov.request}` } } },
    };
  }
  return op;
}
```

And change the `buildOpenApiDocument` signature + the per-method loop. Replace the function signature line `export function buildOpenApiDocument(routes, base) {` with `export function buildOpenApiDocument(routes, base, overlay = {}) {`, and replace the inner loop body that builds `ops`:

```js
  const sortedPaths = {};
  for (const { canonical, methods } of entries) {
    const ops = {};
    for (const method of [...methods].sort()) {
      const ov = overlay[`${method.toUpperCase()} ${canonical}`];
      ops[method] = buildOperation(method, canonical, uniqueOpId(method, canonical), ov);
    }
    sortedPaths[canonical] = ops;
  }
  return { ...base, paths: sortedPaths };
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiBuildSpec.test.js --forceExit`
Expected: PASS (all overlay + fallback cases).

- [ ] **Step 5: Create the shared envelope helpers**

Create `apps/backend/scripts/openapi/schemas/_helpers.mjs`:

```js
// apps/backend/scripts/openapi/schemas/_helpers.mjs
// Shared builders for per-subsystem OpenAPI schema overlay modules.

/** Response envelope { success, message, data: $ref(payload) }. Keeping `data`
 * a direct property makes the admin Data-only alias a trivial ['data'] index. */
export function envelope(payloadSchemaName) {
  return {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { $ref: `#/components/schemas/${payloadSchemaName}` },
    },
  };
}

/** Paginated response envelope: data.items[] of $ref(item) + data.pagination. */
export function paginatedEnvelope(itemSchemaName) {
  return {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        required: ['items', 'pagination'],
        properties: {
          items: { type: 'array', items: { $ref: `#/components/schemas/${itemSchemaName}` } },
          pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer', example: 1 },
              limit: { type: 'integer', example: 20 },
              total: { type: 'integer', example: 100 },
              totalPages: { type: 'integer', example: 5 },
            },
          },
        },
      },
    },
  };
}
```

- [ ] **Step 6: Create the empty money module**

Create `apps/backend/scripts/openapi/schemas/money.mjs`:

```js
// apps/backend/scripts/openapi/schemas/money.mjs
// Typed request/response payload schemas for the money/billing surface.
// Populated per sub-surface in Phase 5 tasks T3–T8.
import { envelope, paginatedEnvelope } from './_helpers.mjs'; // eslint-disable-line no-unused-vars

export const schemas = {};
export const operations = {};
```

- [ ] **Step 7: Wire the module registry + schema merge into `generate-openapi.mjs`**

In `apps/backend/scripts/generate-openapi.mjs`, add after the existing imports (near the top, after the `OPENAPI_BASE` import):

```js
import * as money from './openapi/schemas/money.mjs';

const SCHEMA_MODULES = [money];

/** Merge subsystem schema modules: base schemas first (order preserved), then
 * the union of module schemas sorted by name. Errors on duplicate names so two
 * modules can't silently clobber each other. Returns { schemas, overlay }. */
function mergeSchemaModules(baseSchemas) {
  const added = {};
  const overlay = {};
  for (const mod of SCHEMA_MODULES) {
    for (const [name, schema] of Object.entries(mod.schemas || {})) {
      if (baseSchemas[name] || added[name]) throw new Error(`openapi: duplicate schema name "${name}"`);
      added[name] = schema;
    }
    for (const [key, ov] of Object.entries(mod.operations || {})) {
      if (overlay[key]) throw new Error(`openapi: duplicate operation overlay "${key}"`);
      overlay[key] = ov;
    }
  }
  const sortedAdded = Object.fromEntries(Object.keys(added).sort().map((k) => [k, added[k]]));
  return { schemas: { ...baseSchemas, ...sortedAdded }, overlay };
}
```

Then replace the line `const doc = buildOpenApiDocument(routes, OPENAPI_BASE);` with:

```js
const { schemas: mergedSchemas, overlay } = mergeSchemaModules(OPENAPI_BASE.components.schemas);
const augmentedBase = {
  ...OPENAPI_BASE,
  components: { ...OPENAPI_BASE.components, schemas: mergedSchemas },
};
const doc = buildOpenApiDocument(routes, augmentedBase, overlay);
```

- [ ] **Step 8: Regenerate and confirm byte-identical output**

Run:
```bash
cd apps/backend
node scripts/generate-openapi.mjs
git diff --stat src/docs/openapi.json
```
Expected: **no diff** for `src/docs/openapi.json` (empty `money.mjs` ⇒ identical output — proves the refactor is inert).

- [ ] **Step 9: Re-sync core + run the openapi gates**

Run:
```bash
cd apps/backend
npm run openapi:sync-core && node scripts/check-core-spec-sync.mjs; echo "core: $?"
node scripts/check-openapi-drift.mjs; echo "drift: $?"
npx spectral lint src/docs/openapi.json 2>&1 | tail -1
```
Expected: `core: 0`, `drift: 0`, spectral `0 errors`.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/scripts/openapi/buildSpec.mjs apps/backend/scripts/openapi/schemas/_helpers.mjs apps/backend/scripts/openapi/schemas/money.mjs apps/backend/scripts/generate-openapi.mjs apps/backend/src/tests/unit/openapiBuildSpec.test.js
git commit -m "feat(openapi): overlay machinery for typed payloads (empty money module, inert)"
```

---

## Task 2: Static contract gate, ajv assert helper, admin Data-only alias

**Goal:** Add the always-on Layer-1 gate, the Layer-2 ajv helper, and the admin `ApiData`/`ApiBody` helpers + generated-types pre-hooks. All pass trivially while `money.mjs` is empty.

**Files:**
- Create: `apps/backend/src/tests/unit/openapiMoneyContracts.test.js`
- Create: `apps/backend/src/tests/helpers/assertSchema.js`
- Create: `apps/admin/src/lib/openapi-data.ts`
- Modify: `apps/admin/package.json` (pre-hooks)
- Modify: `apps/admin/CLAUDE.md` (note)

- [ ] **Step 1: Write the Layer-1 static gate test**

Create `apps/backend/src/tests/unit/openapiMoneyContracts.test.js`:

```js
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as money from '../../../scripts/openapi/schemas/money.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(resolve(__dirname, '../../docs/openapi.json'), 'utf8'));

describe('OpenAPI money contract overlay (static gate)', () => {
  it('every overlay key matches a real (METHOD, path) in the generated spec', () => {
    const real = new Set();
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const m of Object.keys(ops)) real.add(`${m.toUpperCase()} ${p}`);
    }
    const missing = Object.keys(money.operations).filter((k) => !real.has(k));
    expect(missing).toEqual([]);
  });

  it('every overlay request/response schema exists in components.schemas', () => {
    const names = new Set(Object.keys(spec.components.schemas));
    const refs = [];
    for (const ov of Object.values(money.operations)) {
      if (ov.request) refs.push(ov.request);
      if (ov.response) refs.push(ov.response);
    }
    const dangling = refs.filter((n) => !names.has(n));
    expect(dangling).toEqual([]);
  });

  it('every components.schemas entry compiles under ajv (valid + resolvable $refs)', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(spec, 'openapi.json');
    for (const name of Object.keys(spec.components.schemas)) {
      expect(ajv.getSchema(`openapi.json#/components/schemas/${name}`)).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run it (passes trivially with empty money module)**

Run: `cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiMoneyContracts.test.js --forceExit`
Expected: PASS (3 tests — no overlay keys yet, base schemas compile).

- [ ] **Step 3: Create the Layer-2 ajv assert helper**

Create `apps/backend/src/tests/helpers/assertSchema.js`:

```js
// Live contract assertions: validate real runtime payloads against the spec.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(resolve(__dirname, '../../docs/openapi.json'), 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, 'openapi.json');

/** Validate an inner `data` payload against a named component schema. */
export function assertData(schemaName, data) {
  const validate = ajv.getSchema(`openapi.json#/components/schemas/${schemaName}`);
  if (!validate) throw new Error(`assertData: schema "${schemaName}" not found in spec`);
  if (!validate(data)) {
    throw new Error(`assertData("${schemaName}") failed:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}

/** Validate a full supertest res.body against the operation's 200 response schema. */
export function assertResponse(method, path, body) {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  const ref = op?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
  if (!ref) throw new Error(`assertResponse: no 200 json schema for ${method} ${path}`);
  const name = ref.replace('#/components/schemas/', '');
  const validate = ajv.getSchema(`openapi.json#/components/schemas/${name}`);
  if (!validate(body)) {
    throw new Error(`assertResponse(${method} ${path} -> ${name}) failed:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}
```

- [ ] **Step 4: Create the admin Data-only alias helper**

Create `apps/admin/src/lib/openapi-data.ts`:

```ts
// Spec-derived type helpers. `paths` comes from the generated (gitignored)
// openapi.generated.ts — run `npm run generate:types` if your editor can't find it.
import type { paths } from './openapi.generated';

type Ok<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;

/** The unwrapped `.data` payload type for a path+method (what getJSON<T> returns). */
export type ApiData<P extends keyof paths, M extends keyof paths[P]> =
  Ok<P, M> extends { data?: infer D } ? D : never;

/** The request body type for a path+method. */
export type ApiBody<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
```

- [ ] **Step 5: Add the generated-types pre-hooks to admin `package.json`**

In `apps/admin/package.json` `"scripts"`, add these four keys (keep alphabetical-ish near the existing scripts; exact placement is not important):

```json
    "predev": "npm run generate:types",
    "prebuild": "npm run generate:types",
    "pretest": "npm run generate:types",
    "pretype-check": "npm run generate:types",
```

- [ ] **Step 6: Generate the types, then type-check the alias**

Run:
```bash
cd apps/admin
npm run generate:types
npx tsc --noEmit 2>&1 | tail -5; echo "tsc: ${PIPESTATUS[0]}"
```
Expected: `tsc: 0` (the `openapi-data.ts` helpers compile against the generated `paths`; `ApiData` resolves to `Record<string, never>` for the still-untyped operations — that's fine, it's unused so far).

- [ ] **Step 7: Document the one-time codegen step in admin CLAUDE.md**

In `apps/admin/CLAUDE.md`, under the `## Testing` section (or a new `## Codegen` note), add:

```markdown
## Generated API types

`src/lib/openapi.generated.ts` is generated from the backend canonical spec and is
**gitignored**. `npm run dev|build|test|type-check` regenerate it first (via the
`pre*` hooks). If you run `npx tsc`/your editor directly on a fresh checkout, run
`npm run generate:types` once. Consumers import spec-derived types via
`src/lib/openapi-data.ts` (`ApiData`/`ApiBody`).
```

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/tests/unit/openapiMoneyContracts.test.js apps/backend/src/tests/helpers/assertSchema.js apps/admin/src/lib/openapi-data.ts apps/admin/package.json apps/admin/CLAUDE.md
git commit -m "feat(openapi): static contract gate + ajv assert helper + admin ApiData alias"
```

---

## Task 3: GL ledger reports (worked template — all schemas concrete)

**Goal:** Type the 5 read-only GL ledger endpoints end-to-end. This is the fully-worked template the bulk sub-surfaces (T4–T8) copy. Field shapes verified against `ledgerReportsService.js` returns + `apps/admin/src/lib/api/ledgerReports.ts`.

**Files:**
- Modify: `apps/backend/scripts/openapi/schemas/money.mjs` (add ledger schemas + operations)
- Modify: `apps/backend/src/tests/money-ledger-reports.deep.test.js` (live assertions)
- Regenerate: `apps/backend/src/docs/openapi.json`, `packages/vhhealth_core/swagger/openapi.json`

- [ ] **Step 1: Add the ledger schemas + operations to `money.mjs`**

Replace the body of `apps/backend/scripts/openapi/schemas/money.mjs` (keep the import line) with:

```js
import { envelope } from './_helpers.mjs';

export const schemas = {
  // ---- GL ledger reports (read-only) ----
  TrialBalanceAccount: {
    type: 'object', additionalProperties: false,
    required: ['code', 'type', 'balancePaise', 'balance'],
    properties: {
      code: { type: 'string', example: 'PATIENT_AR' },
      type: { type: 'string', enum: ['ASSET', 'LIABILITY', 'REVENUE', 'EQUITY', 'CONTRA'] },
      balancePaise: { type: 'integer', example: 100000 },
      balance: { type: 'string', example: '₹1,000.00' },
    },
  },
  TrialBalance: {
    type: 'object', additionalProperties: false,
    required: ['accounts', 'signedTotalPaise', 'balanced'],
    properties: {
      accounts: { type: 'array', items: { $ref: '#/components/schemas/TrialBalanceAccount' } },
      signedTotalPaise: { type: 'integer', example: 0 },
      balanced: { type: 'boolean', example: true },
    },
  },
  TrialBalanceResponse: envelope('TrialBalance'),

  AgingBucket: {
    type: 'object', additionalProperties: false,
    required: ['bucket', 'invoiceCount', 'totalPaise', 'total'],
    properties: {
      bucket: { type: 'string', enum: ['0-30', '31-60', '61-90', '90+'] },
      invoiceCount: { type: 'integer', example: 3 },
      totalPaise: { type: 'integer', example: 250000 },
      total: { type: 'string', example: '₹2,500.00' },
    },
  },
  AgingReport: {
    type: 'object', additionalProperties: false,
    required: ['buckets', 'grandTotalPaise', 'grandTotal'],
    properties: {
      buckets: { type: 'array', items: { $ref: '#/components/schemas/AgingBucket' } },
      grandTotalPaise: { type: 'integer', example: 250000 },
      grandTotal: { type: 'string', example: '₹2,500.00' },
    },
  },
  AgingReportResponse: envelope('AgingReport'),

  DrawerPosition: {
    type: 'object', additionalProperties: false,
    required: ['drawerSessionId', 'netPaise', 'net'],
    properties: {
      drawerSessionId: { type: 'integer', example: 12 },
      netPaise: { type: 'integer', example: 50000 },
      net: { type: 'string', example: '₹500.00' },
    },
  },
  CashPosition: {
    type: 'object', additionalProperties: false,
    required: ['cashTotalPaise', 'cashTotal', 'bankTotalPaise', 'bankTotal', 'byDrawer'],
    properties: {
      cashTotalPaise: { type: 'integer', example: 50000 },
      cashTotal: { type: 'string', example: '₹500.00' },
      bankTotalPaise: { type: 'integer', example: 0 },
      bankTotal: { type: 'string', example: '₹0.00' },
      byDrawer: { type: 'array', items: { $ref: '#/components/schemas/DrawerPosition' } },
    },
  },
  CashPositionResponse: envelope('CashPosition'),

  DailyCollectionDay: {
    type: 'object', additionalProperties: false,
    required: ['day', 'collectedPaise', 'collected'],
    properties: {
      day: { type: 'string', example: '2026-06-24' },
      collectedPaise: { type: 'integer', example: 75000 },
      collected: { type: 'string', example: '₹750.00' },
    },
  },
  DailyCollection: {
    type: 'object', additionalProperties: false,
    required: ['days', 'totalPaise', 'total'],
    properties: {
      days: { type: 'array', items: { $ref: '#/components/schemas/DailyCollectionDay' } },
      totalPaise: { type: 'integer', example: 75000 },
      total: { type: 'string', example: '₹750.00' },
    },
  },
  DailyCollectionResponse: envelope('DailyCollection'),
};

export const operations = {
  'GET /api/v1/admin/ledger/trial-balance': { response: 'TrialBalanceResponse' },
  'GET /api/v1/admin/ledger/ar-aging': { response: 'AgingReportResponse' },
  'GET /api/v1/admin/ledger/insurer-aging': { response: 'AgingReportResponse' },
  'GET /api/v1/admin/ledger/cash-position': { response: 'CashPositionResponse' },
  'GET /api/v1/admin/ledger/daily-collection': { response: 'DailyCollectionResponse' },
};
```

- [ ] **Step 2: Regenerate + run the static gate (proves overlay keys + schemas are valid)**

Run:
```bash
cd apps/backend
node scripts/generate-openapi.mjs
node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiMoneyContracts.test.js --forceExit
```
Expected: regenerate succeeds; static gate PASS (the 5 ledger overlay keys match real GET paths; all referenced schemas exist + compile). **If "every overlay key matches a real path" fails**, the printed key is wrong — confirm the exact path in `src/docs/openapi.json` (param-collapse may have altered it) and fix the overlay key.

- [ ] **Step 3: Add live contract assertions to the ledger deep test (write the failing assertion first)**

In `apps/backend/src/tests/money-ledger-reports.deep.test.js`, add the import at the top:

```js
import { assertData } from './helpers/assertSchema.js';
```

Then add `assertData(...)` after each service call in the existing `Phase 5a — GL report functions` describe block:
- after `const tb = await trialBalance(TENANT);` → `assertData('TrialBalance', tb);`
- after `const aging = await arAging(TENANT);` → `assertData('AgingReport', aging);`
- after the `insurerAging(...)` call → `assertData('AgingReport', <result>);`
- after the `cashPosition(...)` call → `assertData('CashPosition', <result>);`
- after the `dailyCollection(...)` call → `assertData('DailyCollection', <result>);`

(If a report function isn't yet exercised in the file, add a minimal `it(...)` that calls it with `TENANT` + the existing fixtures and asserts via `assertData`.)

- [ ] **Step 4: Run the ledger deep test (needs the QA DB)**

Bring up the QA DB if needed: `node apps/backend/scripts/qa-cluster-up.mjs`. Then:
```bash
cd apps/backend
DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" node --experimental-vm-modules node_modules/jest/bin/jest.js money-ledger-reports.deep --forceExit
```
Expected: PASS. **If `assertData` fails with `additionalProperties`/missing-field errors**, the schema in `money.mjs` disagrees with the real service return — adjust the schema field list to match `ledgerReportsService.js`, regenerate (`node scripts/generate-openapi.mjs`), re-run. Iterate until green (this is the schema↔runtime proof).

- [ ] **Step 5: Re-sync core + full openapi gates**

Run:
```bash
cd apps/backend
npm run openapi:sync-core && node scripts/check-core-spec-sync.mjs; echo "core: $?"
node scripts/check-openapi-drift.mjs; echo "drift: $?"
npx spectral lint src/docs/openapi.json 2>&1 | tail -1
```
Expected: `core: 0`, `drift: 0`, spectral `0 errors`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/scripts/openapi/schemas/money.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/money-ledger-reports.deep.test.js
git commit -m "feat(openapi): typed payloads for GL ledger reports (5 endpoints)"
```

---

## The per-sub-surface recipe (T4–T8)

Tasks 4–8 each apply this identical recipe. Repeat it in full for each task; the schema field lists are authored by reading the cited service return + cross-checking the cited admin TS interface, and the live contract test is the binding proof of correctness.

**Recipe steps (per task):**
1. **Author payload schemas** in `apps/backend/scripts/openapi/schemas/money.mjs` `schemas` — one per response `data` shape (and shared row schemas). Mirror the service return at the cited `file`. `additionalProperties:false`. Add the matching `<X>Response = envelope('<X>')` (or `paginatedEnvelope` for list endpoints).
2. **Author request schemas** for each POST/PUT/PATCH. **Validator-backed sub-surfaces (V1, masters):** strict (`additionalProperties:false`, `required` from the validator chain). **V2:** permissive (`additionalProperties:true`, known fields typed, add `description: 'Reverse-engineered from <serviceFn>; not validator-backed.'`).
3. **Add overlay entries** to `operations` keyed `"<METHOD> <canonical-path>"` → `{ request?, response }`.
4. **Regenerate** `node scripts/generate-openapi.mjs`; **run the static gate** (`openapiMoneyContracts.test.js`). Fix any overlay-key/dangling-ref failures.
5. **Add live contract assertions** to the cited deep test: service-return tests use `assertData('<Payload>', result)`; supertest tests use `assertResponse('<METHOD>', '<path>', res.body)`. For sub-surfaces with no existing deep test, create a minimal one with fixtures.
6. **Run the deep test** (QA DB up). Iterate schema↔runtime until green.
7. **Re-sync core + gates:** `npm run openapi:sync-core && node scripts/check-core-spec-sync.mjs`; `node scripts/check-openapi-drift.mjs`; `npx spectral lint src/docs/openapi.json | tail -1`. Expect core 0 / drift 0 / spectral 0 errors.
8. **Commit** the `money.mjs`, both `openapi.json` copies, and the touched deep test.

---

## Task 4: V1 billing core (invoice / payment / insurance claim)

**Goal:** Type the V1 billing endpoints. Requests are validator-backed (strict).

**Endpoints (from `apps/backend/src/routes/billing/billingRoutes.js`) + sources to mirror:**
| METHOD path | request schema (validator) | response payload (service) |
|---|---|---|
| `POST /api/v1/billing/invoice` | `CreateInvoiceRequest` (`requiredUUID('patient_uid')`, `requiredNumber('total_amount')` + optional `appointment_id,type,items,subtotal,tax_amount,discount_amount,payment_method,notes,due_date`) | `Invoice` (mirror `billingService.createInvoice` return, ~`billingService.js:116-137`) |
| `GET /api/v1/billing/invoice/{id}` | — | `InvoiceDetail` (Invoice + `payment_transactions[]` + `insurance_claim?`) |
| `GET /api/v1/billing/invoices/patient/{patientUid}` | — | paginated `Invoice` (`paginatedEnvelope('Invoice')`) |
| `POST /api/v1/billing/invoice/{id}/payment` | `RecordPaymentRequest` (`requiredNumber('amount')`, `requiredEnum('payment_method',['CASH','CARD','UPI','INSURANCE','CHEQUE'])`, optional `transaction_ref`) | `PaymentResult` (`{ transaction, updatedInvoice, newStatus }`, mirror `recordPayment` ~`billingService.js:161-180`) |
| `GET /api/v1/billing/revenue` | — | `RevenueStats` (mirror `getRevenueStats`; cross-check admin `RevenueStats`/`RevenueSummary`) |
| `POST /api/v1/billing/insurance/claim` | `SubmitClaimRequest` (`requiredUUID('patient_uid')`, `requiredString('policy_number',50)`, `requiredNumber('claim_amount')` + optional `invoice_id,insurance_provider,documents`) | `InsuranceClaim` (cross-check admin `InsuranceClaim`) |
| `GET /api/v1/billing/insurance/claims` | — | paginated `InsuranceClaim` |
| `PUT /api/v1/billing/insurance/claim/{id}` | `UpdateClaimRequest` (optional `status,approved_amount,reason,rejection_reason,documents,payment_reference,non_payable_amount,disallowed_reason`) | `InsuranceClaim` |
| `POST /api/v1/billing/insurance/claim/{id}/enhancement` | `EnhancementClaimRequest` (`requiredNumber('enhancement_amount')` + optional `justification,clinical_justification`) | `InsuranceClaim` |

**Cross-check interfaces:** `apps/admin/src/lib/api/billing.ts` — `Invoice`, `InvoiceDetail`, `PaymentTransaction`, `RecordPaymentPayload`, `InsuranceClaim`, `SubmitClaimPayload`, `UpdateClaimPayload`, `RevenueSummary`, `RevenueStats`.
**Deep test for live assertions:** `apps/backend/src/tests/billing.test.js` (supertest → use `assertResponse`). Add new `it`s for the read endpoints if absent.

- [ ] **Step 1:** Apply recipe step 1–2 (payload + request schemas) using the table above. Use `paginatedEnvelope('Invoice')` / `paginatedEnvelope('InsuranceClaim')` for the list endpoints.
- [ ] **Step 2:** Apply recipe step 3 (overlay entries).
- [ ] **Step 3:** Apply recipe step 4 (regenerate + static gate). Expected: PASS.
- [ ] **Step 4:** Apply recipe step 5–6 — in `billing.test.js`, after each successful request assert `assertResponse('<METHOD>','<path>', res.body)` (e.g. after the create-invoice success case → `assertResponse('POST','/api/v1/billing/invoice', res.body)`). Run `... jest billing --forceExit` against the QA DB. Iterate schema↔runtime until green.
- [ ] **Step 5:** Apply recipe step 7 (core/drift/spectral gates). Expected: core 0 / drift 0 / spectral 0 errors.
- [ ] **Step 6:** Apply recipe step 8 — commit:
```bash
git add apps/backend/scripts/openapi/schemas/money.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/billing.test.js
git commit -m "feat(openapi): typed payloads for V1 billing (invoice/payment/insurance claim)"
```

---

## Task 5: V2 invoices (draft / items / itemize / discount / issue / void / tpa-decision)

**Goal:** Type the V2 invoice lifecycle. Requests are V2 (no validators) → permissive + flagged.

**Endpoints (from `apps/backend/src/routes/billing/billingV2Routes.js`) + sources to mirror (`billingV2Service.js`):**
| METHOD path | request (permissive) | response payload |
|---|---|---|
| `GET /api/v1/billing/v2/services` | — | paginated `ServiceMaster` |
| `POST /api/v1/billing/v2/services` | `CreateServiceMasterRequest` (`code,description,category,default_price,gst_rate,hsn_sac`) | `ServiceMaster` |
| `PATCH /api/v1/billing/v2/services/{id}` | `UpdateServiceMasterRequest` (patch subset) | `ServiceMaster` |
| `POST /api/v1/billing/v2/invoices` | `CreateDraftInvoiceRequest` (`invoice_type,patient_uid?,appointment_id?,admission_id?,items?`) | `InvoiceV2` (mirror `createDraftInvoice` return) |
| `GET /api/v1/billing/v2/invoices` | — | paginated `InvoiceV2` |
| `GET /api/v1/billing/v2/invoices/{id}` | — | `InvoiceV2Detail` (invoice + `items[]: InvoiceItem` + totals from `recomputeInvoiceTotals`: `subtotal,cgst,sgst,igst,discount,total,paid,due`) |
| `POST /api/v1/billing/v2/invoices/{id}/items` | `AddInvoiceItemRequest` (`service_code,category,quantity,unit_price_minor,...`) | `InvoiceItem` |
| `DELETE /api/v1/billing/v2/invoices/{id}/items/{itemId}` | — | `InvoiceV2Detail` (or `{ removed: boolean }` — mirror actual return) |
| `POST /api/v1/billing/v2/invoices/{id}/itemize` | `ItemizeRequest` (`emit_package,emit_pharmacy,emit_ward_indents,emit_lab,emit_consults,emit_theatre` booleans) | `InvoiceV2Detail` |
| `POST /api/v1/billing/v2/invoices/{id}/items/{itemId}/tpa-decision` | `TpaDecisionRequest` (`decision,non_payable_reason`) | `InvoiceItem` |
| `GET /api/v1/billing/v2/invoices/{id}/non-payable` | — | `NonPayableBreakdown` (mirror `getInvoiceNonPayableBreakdown`) |
| `POST /api/v1/billing/v2/invoices/{id}/discount` | `ApplyDiscountRequest` (`amount,reason`) | `InvoiceV2Detail` |
| `POST /api/v1/billing/v2/invoices/{id}/issue` | — | `InvoiceV2Detail` (status ISSUED) |
| `POST /api/v1/billing/v2/invoices/{id}/void` | `VoidInvoiceRequest` (`reason`) | `InvoiceV2Detail` |

(PDF endpoints `/tax-invoice-pdf`, `/receipt-pdf` return `application/pdf` — **leave them out of the overlay**; they're binary, not JSON.)

**Cross-check:** none in admin yet (V2 not surfaced in admin clients) → mirror `billingV2Service.js` returns directly; the live contract test is the proof.
**Deep test:** search `apps/backend/src/tests/` for a V2 billing/invoice test; if present use `assertResponse`. If absent, create `apps/backend/src/tests/billing-v2-contract.deep.test.js` with a fixture that creates a draft invoice → adds an item → issues, asserting each response via `assertResponse`.

- [ ] **Step 1:** Recipe step 1 — payload schemas (`ServiceMaster`, `InvoiceV2`, `InvoiceItem`, `InvoiceV2Detail`, `NonPayableBreakdown`) mirroring `billingV2Service.js`. `additionalProperties:false`.
- [ ] **Step 2:** Recipe step 2 — request schemas, all **permissive** (`additionalProperties:true` + `description: 'Reverse-engineered from billingV2Service; not validator-backed.'`).
- [ ] **Step 3:** Recipe step 3 — overlay entries (exclude PDF endpoints).
- [ ] **Step 4:** Recipe step 4 — regenerate + static gate. PASS.
- [ ] **Step 5:** Recipe step 5–6 — live assertions in the V2 deep test (create or extend). Iterate schema↔runtime to green.
- [ ] **Step 6:** Recipe step 7 — core/drift/spectral gates green.
- [ ] **Step 7:** Recipe step 8 — commit:
```bash
git add apps/backend/scripts/openapi/schemas/money.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/
git commit -m "feat(openapi): typed payloads for V2 invoices (lifecycle)"
```

---

## Task 6: V2 payments / advances / refunds

**Goal:** Type the V2 money-movement endpoints. Requests permissive + flagged.

**Endpoints (`billingV2Routes.js`) + sources (`billingV2Service.js`):**
| METHOD path | request (permissive) | response payload |
|---|---|---|
| `POST /api/v1/billing/v2/payments` | `CollectPaymentRequest` (`invoice_id,patient_uid,amount,mode,reference`) | `PaymentV2` (mirror `collectPayment`) |
| `POST /api/v1/billing/v2/payments/{id}/reverse` | `ReversePaymentRequest` (`reason`) | `PaymentV2` |
| `POST /api/v1/billing/v2/advances` | `CollectAdvanceRequest` (`amount,mode,reference`) | `Advance` |
| `GET /api/v1/billing/v2/advances` | — | paginated `Advance` |
| `POST /api/v1/billing/v2/advances/{id}/settle` | `SettleAdvanceRequest` (`invoice_id,amount`) | `AdvanceSettlement` |
| `POST /api/v1/billing/v2/refunds` | `RaiseRefundRequest` (`amount,mode,reason`) | `Refund` |
| `GET /api/v1/billing/v2/refunds` | — | paginated `Refund` |
| `POST /api/v1/billing/v2/refunds/{id}/approve` | — | `Refund` |
| `POST /api/v1/billing/v2/refunds/{id}/reject` | `RejectRefundRequest` (`rejection_reason`) | `Refund` |
| `POST /api/v1/billing/v2/refunds/{id}/pay` | `PayRefundRequest` (`reference`) | `Refund` |
| `GET /api/v1/billing/v2/reports/daily-collection` | — | `V2DailyCollection` (mirror `billing.dailyCollection`) |
| `GET /api/v1/billing/v2/reports/outstanding` | — | `OutstandingReport` (mirror `billing.outstandingBills`) |

**Deep test:** existing money-movement/ledger deep tests already exercise collect/reverse/advance/refund (the ledger Phase-3a tests). Add `assertData('<Payload>', result)` where they call services; or `assertResponse` in a V2 contract deep test.

- [ ] **Step 1:** Recipe step 1 — payload schemas (`PaymentV2`, `Advance`, `AdvanceSettlement`, `Refund`, `V2DailyCollection`, `OutstandingReport`).
- [ ] **Step 2:** Recipe step 2 — permissive request schemas (flagged).
- [ ] **Step 3:** Recipe step 3 — overlay entries.
- [ ] **Step 4:** Recipe step 4 — regenerate + static gate. PASS.
- [ ] **Step 5:** Recipe step 5–6 — live assertions. Iterate to green.
- [ ] **Step 6:** Recipe step 7 — gates green.
- [ ] **Step 7:** Recipe step 8 — commit:
```bash
git add apps/backend/scripts/openapi/schemas/money.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/
git commit -m "feat(openapi): typed payloads for V2 payments/advances/refunds"
```

---

## Task 7: V2 cash-drawer + payment-links

**Goal:** Type the cash-drawer + payment-link endpoints. Requests permissive + flagged. **New fixtures required** (no existing deep test).

**Endpoints (`billingV2Routes.js`) + sources (`cashDrawerService`, `paymentLinksService`):**
| METHOD path | request (permissive) | response payload |
|---|---|---|
| `POST /api/v1/billing/v2/cash-drawer/sessions/open` | `OpenDrawerRequest` (`cashier_uid,shift,opening_float`) | `CashDrawerSession` |
| `POST /api/v1/billing/v2/cash-drawer/sessions/{id}/close` | `CloseDrawerRequest` (`counted_denominations,variance_reason`) | `CashDrawerSession` |
| `POST /api/v1/billing/v2/cash-drawer/sessions/{id}/review` | `ReviewDrawerRequest` (`review_notes`) | `CashDrawerSession` |
| `GET /api/v1/billing/v2/cash-drawer/sessions` | — | paginated `CashDrawerSession` |
| `GET /api/v1/billing/v2/cash-drawer/sessions/{id}` | — | `CashDrawerSession` |
| `POST /api/v1/billing/v2/payment-links` | `CreatePaymentLinkRequest` (`invoice_id,patient_uid,amount,currency,provider,expires_in_hours,notes`) | `PaymentLink` |
| `GET /api/v1/billing/v2/payment-links` | — | paginated `PaymentLink` |
| `GET /api/v1/billing/v2/payment-links/{token}` | — | `PaymentLink` |
| `POST /api/v1/billing/v2/payment-links/{token}/send` | `SendPaymentLinkRequest` (`channels,patient_phone,patient_email`) | `PaymentLink` |
| `POST /api/v1/billing/v2/payment-links/{token}/mark-paid` | `MarkLinkPaidRequest` (`paid_via,paid_reference`) | `PaymentLink` |
| `POST /api/v1/billing/v2/payment-links/{token}/cancel` | `CancelPaymentLinkRequest` (`reason`) | `PaymentLink` |

(`POST /payment-links/run-expire-stale` returns a count summary → `ExpireStaleResult`.)

- [ ] **Step 1:** Recipe step 1 — payload schemas (`CashDrawerSession`, `PaymentLink`, `ExpireStaleResult`) mirroring the services.
- [ ] **Step 2:** Recipe step 2 — permissive request schemas (flagged).
- [ ] **Step 3:** Recipe step 3 — overlay entries.
- [ ] **Step 4:** Recipe step 4 — regenerate + static gate. PASS.
- [ ] **Step 5:** Recipe step 5 — create `apps/backend/src/tests/billing-cashdrawer-paymentlinks.deep.test.js`: open a drawer session → assert; create a payment-link → assert; using `assertResponse`. Recipe step 6 — run against QA DB, iterate to green.
- [ ] **Step 6:** Recipe step 7 — gates green.
- [ ] **Step 7:** Recipe step 8 — commit:
```bash
git add apps/backend/scripts/openapi/schemas/money.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/billing-cashdrawer-paymentlinks.deep.test.js
git commit -m "feat(openapi): typed payloads for V2 cash-drawer + payment-links"
```

---

## Task 8: Billing masters

**Goal:** Type the billing-masters endpoints. Requests validator-light but explicit in the routes → strict where the route lists fields.

**Endpoints (`apps/backend/src/routes/admin/billingMastersRoutes.js`) + sources (`billingMastersService`):**
| METHOD path | request | response payload |
|---|---|---|
| `PUT /api/v1/admin/billing-masters/payers` | `UpsertPayerRequest` (`id?,payer_code,display_name,payer_kind,registration_number?,contact_email?,contact_phone?,address?,status?,ehr_external_id?,metadata?`) | `Payer` |
| `GET /api/v1/admin/billing-masters/payers` | — | paginated `Payer` |
| `PUT /api/v1/admin/billing-masters/tpas` | `UpsertTpaRequest` (`id?,tpa_code,display_name,parent_payer_id?,irda_license_number?,...`) | `Tpa` |
| `GET /api/v1/admin/billing-masters/tpas` | — | paginated `Tpa` |
| `PUT /api/v1/admin/billing-masters/tariff-plans` | `UpsertTariffPlanRequest` (`id?,plan_code,display_name,description?,is_default?,currency?,effective_from?,effective_to?,status?,metadata?`) | `TariffPlan` |
| `GET /api/v1/admin/billing-masters/tariff-plans` | — | paginated `TariffPlan` |
| `PUT /api/v1/admin/billing-masters/tariff-items` | `UpsertTariffItemRequest` (`id?,tariff_plan_id,service_code,service_kind,display_name,unit_price_minor,unit_label?,taxable?,tax_rate_pct?,effective_from?,effective_to?,metadata?`) | `TariffItem` |
| `GET /api/v1/admin/billing-masters/tariff-plans/{planId}/items` | — | paginated `TariffItem` |
| `PUT /api/v1/admin/billing-masters/packages` | `UpsertPackageRequest` (`id?,package_code,display_name,description?,base_specialty?,base_procedure_code?,duration_days?,fixed_price_minor?,currency?,status?,exclusion_notes?,inclusion_notes?,metadata?`) | `BillingPackage` |
| `GET /api/v1/admin/billing-masters/packages` | — | paginated `BillingPackage` |
| `POST /api/v1/admin/billing-masters/packages/{packageId}/items` | `AddPackageItemRequest` (`service_code,service_kind,display_name,quantity,unit_price_minor,is_included?,notes?,metadata?`) | `PackageItem` |
| `GET /api/v1/admin/billing-masters/packages/{packageId}/items` | — | paginated `PackageItem` |
| `POST /api/v1/admin/billing-masters/payer-tariff-links` | `LinkPayerTariffRequest` (`payer_id,tpa_id?,tariff_plan_id,is_primary?,effective_from?,effective_to?,status?,metadata?`) | `PayerTariffLink` |
| `GET /api/v1/admin/billing-masters/payer-tariff-links` | — | paginated `PayerTariffLink` |
| `GET /api/v1/admin/billing-masters/resolve-price` | — | `ResolvedPrice` (mirror `resolveServicePrice`) |

Request schemas: these routes list explicit body fields → author **strict** (`additionalProperties:false`). `metadata` → `{ type: 'object', additionalProperties: true }`.

- [ ] **Step 1:** Recipe step 1 — payload schemas (`Payer`, `Tpa`, `TariffPlan`, `TariffItem`, `BillingPackage`, `PackageItem`, `PayerTariffLink`, `ResolvedPrice`).
- [ ] **Step 2:** Recipe step 2 — strict request schemas from the route field lists.
- [ ] **Step 3:** Recipe step 3 — overlay entries.
- [ ] **Step 4:** Recipe step 4 — regenerate + static gate. PASS.
- [ ] **Step 5:** Recipe step 5 — create `apps/backend/src/tests/billing-masters.deep.test.js`: upsert a payer → assert; upsert a tariff-plan → assert; using `assertResponse`. Recipe step 6 — iterate to green.
- [ ] **Step 6:** Recipe step 7 — gates green.
- [ ] **Step 7:** Recipe step 8 — commit:
```bash
git add apps/backend/scripts/openapi/schemas/money.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/billing-masters.deep.test.js
git commit -m "feat(openapi): typed payloads for billing masters"
```

---

## Task 9: Admin adoption + closeout

**Goal:** Convert the money admin clients to spec-derived types, run the full gate set, merge to both remotes.

**Files:**
- Modify: `apps/admin/src/lib/api/ledgerReports.ts`, `apps/admin/src/lib/api/billing.ts`

- [ ] **Step 1: Convert `ledgerReports.ts` to spec-derived aliases**

Replace the hand-authored response interfaces in `apps/admin/src/lib/api/ledgerReports.ts` with `ApiData` aliases (keep the function signatures + call sites):

```ts
import type { ApiData } from '@/lib/openapi-data';

export type TrialBalance = ApiData<'/api/v1/admin/ledger/trial-balance', 'get'>;
export type AgingReport = ApiData<'/api/v1/admin/ledger/ar-aging', 'get'>;
export type CashPosition = ApiData<'/api/v1/admin/ledger/cash-position', 'get'>;
export type DailyCollection = ApiData<'/api/v1/admin/ledger/daily-collection', 'get'>;
```

Remove the now-redundant `TrialBalanceAccount`/`AgingBucket`/`DrawerPosition`/`DailyCollectionDay` interfaces **only if** nothing imports them directly; if they are imported elsewhere, derive them too (e.g. `export type TrialBalanceAccount = TrialBalance['accounts'][number];`). Keep every exported NAME that has an importer.

- [ ] **Step 2: Convert `billing.ts` response types to spec-derived aliases**

In `apps/admin/src/lib/api/billing.ts`, replace the hand-authored response interfaces with `ApiData` aliases for the typed endpoints, e.g.:

```ts
import type { ApiData } from '@/lib/openapi-data';
export type Invoice = ApiData<'/api/v1/billing/invoice/{id}', 'get'>;     // InvoiceDetail-shaped
export type RevenueStats = ApiData<'/api/v1/billing/revenue', 'get'>;
export type InsuranceClaim = ApiData<'/api/v1/billing/insurance/claims', 'get'>['items'][number];
```
Keep every exported name with an importer (derive sub-types via indexed access as above). Request payload types may use `ApiBody<...>` where helpful. **Do not change call sites or function signatures** — only the type definitions.

- [ ] **Step 3: Admin gates**

Run:
```bash
cd apps/admin
npm run generate:types
npx tsc --noEmit 2>&1 | tail -8; echo "tsc: ${PIPESTATUS[0]}"
npm test 2>&1 | tail -8
npx next build 2>&1 | tail -6; echo "build: ${PIPESTATUS[0]}"
```
Expected: `tsc: 0`; full jest green; `build: 0`. **If tsc errors** on a removed interface, add an indexed-access alias for it (Step 1/2) — the spec type is the source now.

- [ ] **Step 4: Backend full gate**

Bring up the QA DB (`node apps/backend/scripts/qa-cluster-up.mjs`). Run:
```bash
cd apps/backend
npm run lint 2>&1 | tail -2
npx spectral lint src/docs/openapi.json 2>&1 | tail -1
node scripts/check-openapi-drift.mjs; echo "drift: $?"
node scripts/check-core-spec-sync.mjs; echo "core: $?"
node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiMoneyContracts.test.js openapiBuildSpec --forceExit
```
Plus run the touched money deep tests (`money-ledger-reports.deep`, `billing`, the new V2/masters/cash-drawer deep tests) against the QA DB. Expected: lint clean; spectral 0 errors; drift 0; core 0; all contract/deep tests green.

- [ ] **Step 5: Authoritative chunked backend gate (optional but recommended for the money deep tests)**

Run the chunked runner as `postgres` (the authoritative backend gate per the repo's CI memory):
```bash
cd apps/backend && node scripts/run-ci-jest.mjs
```
Expected: all chunks pass.

- [ ] **Step 6: Commit, merge, push both remotes, delete branch**

```bash
git add apps/admin/src/lib/api/ledgerReports.ts apps/admin/src/lib/api/billing.ts
git commit -m "feat(admin): consume spec-derived ApiData types for money clients"
# from the feature branch:
git checkout main
git merge --no-ff <branch> -m "Merge: OpenAPI Phase 5 (money) typed payloads"
git push github main && git push origin main
git branch -d <branch>
```

- [ ] **Step 7: Tick ROADMAP + update memory**

- In `docs/ROADMAP.md` §0 T2 #5, mark the Phase 5 money slice done (cite the merge SHA), and note Phases 4 + clinical/payroll/discharge Phase-5 slices remain.
- Update memory `project_vh_health_openapi_pipeline.md` + its `MEMORY.md` index line: Phase 5 (money) done, the overlay-module mechanism, the `ApiData` alias + pre-hooks, the static+live contract gate. Commit the ROADMAP change on main and push both remotes.

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Overlay machinery (spec §Architecture) → T1. Schema conventions (§Schema-authoring) → T3 template + T4–T8 recipe. Static gate (§Contract Layer 1) → T2. Live assertions (§Contract Layer 2) → T2 helper + T3–T8 usage. Data-only alias + option-(a) pre-hooks (§Admin) → T2 + T9. Scope decomposition (§Task decomposition) → T1–T9. Query params out of scope → honored (overlay only sets `request`/`response`). Both remotes + ROADMAP + memory (§Success criteria) → T9.
- No spec requirement is unmapped.

**2. Placeholder scan** — T1–T3 + T9 contain complete, copy-pasteable code. T4–T8 are deliberately recipe-driven: the **exact endpoints, request fields, response-source files, cross-check interfaces, overlay keys, and the contract assertion** are all specified; the per-field JSON is authored by mirroring the cited service return, with the live `assertData`/`assertResponse` test as the binding correctness gate (so an inexact field list fails CI, not silently ships). This is the correct granularity for "author N schemas to match runtime" — fabricating ~50 exact schemas without re-reading each service would be guesswork. The recipe is repeated in each task (not referenced), per the skill.

**3. Type consistency** — `envelope`/`paginatedEnvelope` signatures match across T1 (definition) and T3–T8 (use). `assertData(name, data)` / `assertResponse(method, path, body)` signatures match between T2 (definition) and T3–T8 (use). `ApiData<P,M>` / `ApiBody<P,M>` match between T2 (definition) and T9 (use). Overlay key format `"<METHOD> <path>"` is consistent across the generator (T1), the static gate (T2), and every overlay entry (T3–T8). Schema names referenced in overlays (e.g. `TrialBalanceResponse`, `Invoice`, `Payer`) are all defined in their task's `schemas`.

**4. Ordering safety** — T1 proves the refactor inert (byte-identical) before any schema authoring; T2's gate/helpers pass trivially on the empty module; T3 is the cleanest slice (read-only, existing test) and validates the whole pipeline incl. the admin alias surface before the bulk V2 work; each T3–T8 is independently green (regen + gates); T9 flips admin consumption + merges. The generated `openapi.generated.ts` stays gitignored; the T2 pre-hooks make every `npm run` flow regenerate it before consuming.
