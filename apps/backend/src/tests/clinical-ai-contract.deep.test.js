// Live OpenAPI contract deep-test for the REACHABLE, DETERMINISTIC clinical-AI
// control-plane ops — the strict-schema subset that needs NO LLM and NO module
// enablement. This is the runtime contract gate for the clinical-AI overlay
// slice (apps/backend/scripts/openapi/schemas/clinicalAi.mjs): it proves the
// live payloads of the deterministic strict ops actually match the committed
// 200/201 $ref schemas the admin/codegen consumers rely on.
//
// SCOPE — honest coverage boundary:
//   The clinical-AI overlay types ~336 ops, dual-mounted under
//   /api/v1/clinical-ai/control + /api/v1/admin/clinical-ai (+ a clinical-use
//   plane at /api/v1/clinical-ai/clinical). The VAST MAJORITY are LLM-generation
//   ops gated by 3-layer module enablement (clinical_ai_tenant_modules): they
//   403 *_MODULE_DISABLED when off and need a configured LLM when on, so they
//   are NOT cleanly live-assertable. Those LOOSE ClinicalAiDraft* ops are
//   STATICALLY validated only — the contract gate
//   (src/tests/unit/openapiContracts.test.js) proves key→route + ajv-compile,
//   and the slice review verified the loose envelope. They are intentionally
//   absent from this live test, with that reason on the record.
//
//   This file LIVE-asserts the DETERMINISTIC STRICT subset (no LLM, no module
//   gate) against the committed schema, asserting EXACT status (200/201) +
//   assertResponse(full envelope) + a value sanity check for each:
//     • GET  /outcome-scoreboard            — THE key check: empty tenant → every
//                                              *_pct / *_minutes metric is null
//                                              (proves the nullable-metric schema)
//     • GET  /roi                           — deterministic numeric ROI metrics
//     • POST /roi/snapshots                 — persist a snapshot (201)
//     • GET  /roi/snapshots                 — list snapshots
//     • GET  /roi/snapshots/latest          — latest snapshot
//     • POST /knowledge-bases               — create KB (201)
//     • GET  /knowledge-bases               — list KBs
//     • GET  /knowledge-bases/{id}          — get one KB
//     • POST /blood-bank/inventory          — upsert inventory snapshot (201)
//     • GET  /blood-bank/inventory          — list inventory
//     • POST /biomed-devices                — upsert device registry row (201)
//     • GET  /biomed-devices                — list devices
//     • POST /model-registry                — upsert model registry row (201)
//     • GET  /model-registry                — list models
//
// Modelled on discharge-summaries-contract.deep.test.js (auth bootstrap +
// assertResponse + fixture inserts/cleanup with unique prefixes).
//
// PATH PREFIX: the aggregator (clinicalAiRoutes.js) is mounted at BOTH
// /api/v1/clinical-ai/control AND /api/v1/admin/clinical-ai; both literal path
// keys survive in the committed spec. We drive + assert the canonical
// /clinical-ai/control prefix.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { assertResponse } from './helpers/assertSchema.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const BASE = '/api/v1/clinical-ai/control';

// Unique prefixes so this suite never collides with other clinical-AI tests.
const ADMIN_UID = 'ca01ca01-0001-4ca0-8ca0-ca01ca010001';
const KB_NAME = 'CA_CONTRACT_DEEP_TEST_KB';
const MODEL_KEY = 'ca-contract-deep-test-model';
const MODEL_VERSION = 'v0.0.1-test';
const DEVICE_CODE = 'CA-CONTRACT-DEEP-DEV-001';
// A clean, enabled module with ZERO generation/review/safety activity. The
// scoreboard surfaces enabled modules even with no activity (emptyModuleRow),
// so this row deterministically exercises the "no evidence → null" path of the
// nullable-metric schema, isolated from data other suites may have accrued on
// the default tenant.
const EMPTY_MODULE_KEY = 'ca_contract_deep_empty_module';
// Blood-bank rows are keyed (tenant, blood_group, component). Use a less common
// pairing so the row is unambiguously ours for the value sanity check.
const BB_GROUP = 'AB-';
const BB_COMPONENT = 'cryoprecipitate';

// ADMIN bound to the default tenant. ADMIN is on CLINICAL_AI_CONTROL_ROLES
// (requireClinicalAiControl) AND the app-mount requireRole(...), so a single
// desktop token passes both doors. ALLOW_DEFAULT_TENANT='true' makes
// tenantContextMiddleware resolve req.tenantId to DEFAULT_TENANT_ID.
function mkAdmin() {
  const token = generateTestToken('ADMIN', {
    uid: ADMIN_UID,
    id: 990101,
    deviceType: 'desktop',
    phone: '9009020001',
  });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

// Every *_pct / *_minutes / *_distance_pct field the scoreboard schema marks
// nullable. On a module with NO evidence, the service returns null (NOT 0) for
// all of them — "no evidence yet" must never read as "0%". This walk asserts
// that on a single empty per-module row.
function expectModuleRatesNull(row) {
  // Review rates.
  expect(row.reviews.acceptance_rate_pct).toBeNull();
  expect(row.reviews.edit_rate_pct).toBeNull();
  expect(row.reviews.rejection_rate_pct).toBeNull();
  expect(row.reviews.needs_revision_rate_pct).toBeNull();
  expect(row.reviews.used_rate_pct).toBeNull();
  expect(row.reviews.avg_review_latency_minutes).toBeNull();
  // Edit-distance rates.
  expect(row.edits.mean_edit_distance_pct).toBeNull();
  expect(row.edits.median_edit_distance_pct).toBeNull();
  // Safety flag rates.
  expect(row.safety.flag_precision_pct).toBeNull();
  expect(row.safety.flag_override_rate_pct).toBeNull();
  // Counts on an empty row are 0 (not null) — proves the integer/null split.
  expect(row.reviews.total).toBe(0);
  expect(row.reviews.decided).toBe(0);
  expect(row.generations.total).toBe(0);
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_roi_snapshots WHERE tenant_id = $1::uuid AND module_key = $2`,
    DEFAULT_TENANT_ID, 'CA_CONTRACT_DEEP',
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_blood_bank_inventory_snapshots
       WHERE tenant_id = $1::uuid AND blood_group = $2 AND component = $3`,
    DEFAULT_TENANT_ID, BB_GROUP, BB_COMPONENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_biomed_devices WHERE tenant_id = $1::uuid AND device_code = $2`,
    DEFAULT_TENANT_ID, DEVICE_CODE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_model_registry
       WHERE tenant_id = $1::uuid AND model_key = $2 AND version = $3`,
    DEFAULT_TENANT_ID, MODEL_KEY, MODEL_VERSION,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM knowledge_bases WHERE tenant_id = $1::uuid AND name = $2`,
    DEFAULT_TENANT_ID, KB_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_modules WHERE module_key = $1`,
    EMPTY_MODULE_KEY,
  ).catch(() => {});
}

describe('Clinical AI — live OpenAPI contract deep test (reachable strict ops)', () => {
  let admin;

  beforeAll(async () => {
    await cleanup();
    // Seed a clean ENABLED module with zero activity. The scoreboard surfaces
    // enabled modules even with no activity, giving us a deterministic empty
    // row to assert the null-rate contract on — independent of whatever the
    // default tenant accrued from other suites.
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_ai_modules (module_key, display_name, enabled)
       VALUES ($1, 'CA Contract Deep Empty Module', true)
       ON CONFLICT (module_key) DO UPDATE SET enabled = true`,
      EMPTY_MODULE_KEY,
    );
    admin = mkAdmin();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60000);

  // -------------------------------------------------------------------------
  // THE key live check: empty-tenant outcome-scoreboard must validate against
  // ClinicalAiOutcomeScoreboardResponse, with every metric rate null.
  // -------------------------------------------------------------------------
  it('GET /outcome-scoreboard — empty module: nullable metrics validate, all rates null', async () => {
    // Filter to the seeded zero-activity module. The full envelope validates
    // against ClinicalAiOutcomeScoreboardResponse, and the single returned
    // module row exercises the nullable-metric path: every rate is null (not 0)
    // because there is no evidence yet. This is THE key live check that proves
    // the committed nullable-metric schema is right.
    const res = await admin.get(`${BASE}/outcome-scoreboard?module_key=${EMPTY_MODULE_KEY}`);
    expect(res.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/outcome-scoreboard`, res.body);

    const sb = res.body.data;
    expect(sb.tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(sb.module_key).toBe(EMPTY_MODULE_KEY);
    expect(typeof sb.definitions).toBe('object');
    expect(sb.read_only).toBe(true);
    expect(sb.decision_support_only).toBe(true);

    // Exactly one row — our seeded empty enabled module.
    expect(Array.isArray(sb.modules)).toBe(true);
    const row = sb.modules.find((m) => m.module_key === EMPTY_MODULE_KEY);
    expect(row).toBeDefined();
    expect(row.enabled).toBe(true);
    // The headline assertion: no evidence → every rate is null, not 0.
    expectModuleRatesNull(row);
  });

  // Also exercise the UNFILTERED scoreboard so the full module-array branch of
  // the schema is validated live (the filtered case above empties the array).
  it('GET /outcome-scoreboard — unfiltered: full envelope validates', async () => {
    const res = await admin.get(`${BASE}/outcome-scoreboard?period_days=30`);
    expect(res.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/outcome-scoreboard`, res.body);
    expect(res.body.data.module_key).toBe('ALL');
    expect(res.body.data.period_days).toBe(30);
  });

  // -------------------------------------------------------------------------
  // ROI — deterministic numeric metrics (rates are non-null 0 on empty, per the
  // ROI service contract). Lifecycle: GET /roi → POST snapshot → GET list →
  // GET latest.
  // -------------------------------------------------------------------------
  it('GET /roi — deterministic ROI metrics validate', async () => {
    const res = await admin.get(`${BASE}/roi?period_days=30`);
    expect(res.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/roi`, res.body);

    const m = res.body.data;
    expect(m.tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(m.module_key).toBe('ALL');
    expect(m.period_days).toBe(30);
    expect(Array.isArray(m.by_module)).toBe(true);
    expect(Array.isArray(m.highlights)).toBe(true);
    // ROI rates are plain non-null numbers (0 on empty), unlike the scoreboard.
    expect(typeof m.acceptance_rate_pct).toBe('number');
    expect(typeof m.generation_count).toBe('number');
    expect(m.read_only).toBe(true);
  });

  it('POST /roi/snapshots → GET /roi/snapshots → GET /roi/snapshots/latest validate', async () => {
    // Create (201). module_key tags the snapshot for cleanup.
    const created = await admin.post(`${BASE}/roi/snapshots`).send({
      period_days: 30,
      module_key: 'CA_CONTRACT_DEEP',
    });
    expect(created.statusCode).toBe(201);
    assertResponse('POST', `${BASE}/roi/snapshots`, created.body);
    expect(created.body.data.snapshot).not.toBeNull();
    expect(created.body.data.snapshot.module_key).toBe('CA_CONTRACT_DEEP');
    expect(created.body.data.snapshot.tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(created.body.data.metrics.tenant_id).toBe(DEFAULT_TENANT_ID);
    const snapshotId = created.body.data.snapshot.id;
    expect(snapshotId).toBeDefined();

    // List.
    const list = await admin.get(`${BASE}/roi/snapshots?module_key=CA_CONTRACT_DEEP&limit=50`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/roi/snapshots`, list.body);
    expect(Array.isArray(list.body.data.snapshots)).toBe(true);
    const mine = list.body.data.snapshots.find((s) => s.id === snapshotId);
    expect(mine).toBeDefined();
    expect(mine.module_key).toBe('CA_CONTRACT_DEEP');

    // Latest.
    const latest = await admin.get(`${BASE}/roi/snapshots/latest?module_key=CA_CONTRACT_DEEP`);
    expect(latest.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/roi/snapshots/latest`, latest.body);
    expect(latest.body.data.snapshot).not.toBeNull();
    expect(latest.body.data.snapshot.id).toBe(snapshotId);
  });

  // -------------------------------------------------------------------------
  // Knowledge-base CRUD — POST create (201) → GET list → GET by id.
  // -------------------------------------------------------------------------
  it('POST /knowledge-bases → GET /knowledge-bases → GET /knowledge-bases/{id} validate', async () => {
    // Create with a real CHECK-constrained kb_type.
    const created = await admin.post(`${BASE}/knowledge-bases`).send({
      name: KB_NAME,
      description: 'Contract deep-test knowledge base',
      kb_type: 'clinical_guideline',
    });
    expect(created.statusCode).toBe(201);
    assertResponse('POST', `${BASE}/knowledge-bases`, created.body);
    expect(created.body.data.name).toBe(KB_NAME);
    expect(created.body.data.kb_type).toBe('clinical_guideline');
    expect(created.body.data.status).toBe('active');
    expect(created.body.data.tenant_id).toBe(DEFAULT_TENANT_ID);
    const kbId = created.body.data.id;
    expect(kbId).toBeDefined();

    // List.
    const list = await admin.get(`${BASE}/knowledge-bases?kb_type=clinical_guideline&limit=100`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/knowledge-bases`, list.body);
    expect(Array.isArray(list.body.data.knowledge_bases)).toBe(true);
    const mine = list.body.data.knowledge_bases.find((k) => k.id === kbId);
    expect(mine).toBeDefined();
    expect(mine.name).toBe(KB_NAME);

    // Get by id (additionally surfaces document_count / chunk_count).
    const one = await admin.get(`${BASE}/knowledge-bases/${kbId}`);
    expect(one.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/knowledge-bases/{id}`, one.body);
    expect(one.body.data.id).toBe(kbId);
    expect(one.body.data.name).toBe(KB_NAME);
  });

  // -------------------------------------------------------------------------
  // Blood-bank inventory — POST upsert (201) → GET list. blood_group +
  // component are hard service-allowlist enums (400 before INSERT).
  // -------------------------------------------------------------------------
  it('POST /blood-bank/inventory → GET /blood-bank/inventory validate', async () => {
    const created = await admin.post(`${BASE}/blood-bank/inventory`).send({
      blood_group: BB_GROUP,
      component: BB_COMPONENT,
      units_available: 12,
      units_committed: 3,
      minimum_stock_level: 5,
    });
    expect(created.statusCode).toBe(201);
    assertResponse('POST', `${BASE}/blood-bank/inventory`, created.body);
    expect(created.body.data).not.toBeNull();
    expect(created.body.data.blood_group).toBe(BB_GROUP);
    expect(created.body.data.component).toBe(BB_COMPONENT);
    expect(created.body.data.units_available).toBe(12);
    expect(created.body.data.units_committed).toBe(3);

    const list = await admin.get(`${BASE}/blood-bank/inventory?blood_group=${encodeURIComponent(BB_GROUP)}&component=${BB_COMPONENT}`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/blood-bank/inventory`, list.body);
    expect(Array.isArray(list.body.data.inventory)).toBe(true);
    const mine = list.body.data.inventory.find(
      (r) => r.blood_group === BB_GROUP && r.component === BB_COMPONENT,
    );
    expect(mine).toBeDefined();
    expect(mine.units_available).toBe(12);
  });

  // -------------------------------------------------------------------------
  // Biomed device registry — POST upsert (201) → GET list. device_type +
  // status are DB-CHECK-grade enums.
  // -------------------------------------------------------------------------
  it('POST /biomed-devices → GET /biomed-devices validate', async () => {
    const created = await admin.post(`${BASE}/biomed-devices`).send({
      device_code: DEVICE_CODE,
      device_type: 'ventilator',
      manufacturer: 'ContractDeepTest Medical',
      model: 'CDT-100',
      usage_hours: 1200,
      fault_events_last_90d: 2,
    });
    expect(created.statusCode).toBe(201);
    assertResponse('POST', `${BASE}/biomed-devices`, created.body);
    expect(created.body.data).not.toBeNull();
    expect(created.body.data.device_code).toBe(DEVICE_CODE);
    expect(created.body.data.device_type).toBe('ventilator');
    expect(created.body.data.status).toBe('in_service');

    const list = await admin.get(`${BASE}/biomed-devices?device_type=ventilator&limit=100`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/biomed-devices`, list.body);
    expect(Array.isArray(list.body.data.devices)).toBe(true);
    const mine = list.body.data.devices.find((d) => d.device_code === DEVICE_CODE);
    expect(mine).toBeDefined();
    expect(mine.device_type).toBe('ventilator');
  });

  // -------------------------------------------------------------------------
  // Model registry — POST upsert (201) → GET list. stage + approval_status are
  // DB-CHECK-grade enums; the upsert leaves them at their column defaults.
  // -------------------------------------------------------------------------
  it('POST /model-registry → GET /model-registry validate', async () => {
    const created = await admin.post(`${BASE}/model-registry`).send({
      model_key: MODEL_KEY,
      version: MODEL_VERSION,
      provider: 'local',
      purpose: 'contract deep test',
      owner: 'qa',
    });
    expect(created.statusCode).toBe(201);
    assertResponse('POST', `${BASE}/model-registry`, created.body);
    expect(created.body.data).not.toBeNull();
    expect(created.body.data.model_key).toBe(MODEL_KEY);
    expect(created.body.data.version).toBe(MODEL_VERSION);
    // stage + approval_status must be inside their committed enum sets.
    expect(['sandbox', 'staging', 'production', 'deprecated', 'quarantined', 'unknown'])
      .toContain(created.body.data.stage);
    expect(['pending', 'approved', 'revoked', 'rejected', 'pending_retirement'])
      .toContain(created.body.data.approval_status);
    const modelId = created.body.data.id;

    const list = await admin.get(`${BASE}/model-registry?model_key=${MODEL_KEY}&limit=100`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', `${BASE}/model-registry`, list.body);
    expect(Array.isArray(list.body.data.models)).toBe(true);
    const mine = list.body.data.models.find((m) => m.id === modelId);
    expect(mine).toBeDefined();
    expect(mine.model_key).toBe(MODEL_KEY);
  });
});
