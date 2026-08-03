// src/tests/unit/openapiTagInvariants.test.js
//
// Pins the TAG TAXONOMY of the COMMITTED spec (src/docs/openapi.json).
//
// openapiBuildSpec.test.js pins the pure resolution RULES; this pins the
// OUTCOME they produce on the real router graph. The two catch different
// things: a refactor can leave every rule green and still silently re-tag the
// API — e.g. by moving route modules, or by registering routes from a new
// helper that itself lives under src/routes/ (which would become the first
// matching stack frame and capture every route registered through it).
//
// See the KNOWN FRAGILITY block in scripts/generate-openapi.mjs for why tag
// derivation is layout-sensitive and why that is acceptable: it cannot fail
// quietly. These assertions are the tripwire that makes it noisy.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENAPI_TAG_REGISTRY, UNCLASSIFIED_TAG_BUDGET } from '../../../scripts/openapi/base.mjs';
import { UNCLASSIFIED_TAG } from '../../../scripts/openapi/buildSpec.mjs';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const spec = JSON.parse(readFileSync(join(backendRoot, 'src', 'docs', 'openapi.json'), 'utf8'));

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/** [{ method, path, op }] for every operation in the committed spec. */
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => HTTP_METHODS.has(method))
    .map(([method, op]) => ({ method, path, op })),
);

// Audience words: who is CALLING, not what the resource is. None may ever be a
// primary tag — that is the junk drawer this taxonomy exists to avoid.
const AUDIENCE_WORDS = ['admin', 'staff', 'portal'];

describe('committed OpenAPI spec — tag invariants', () => {
  it('has operations to check (guards against an empty or malformed spec)', () => {
    expect(operations.length).toBeGreaterThan(3000);
  });

  it('gives EVERY operation exactly one primary tag', () => {
    const untagged = operations
      .filter(({ op }) => !Array.isArray(op.tags) || op.tags.length !== 1)
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(untagged).toEqual([]);
  });

  it('declares every tag an operation uses in the top-level tags array', () => {
    // Spectral's `operation-tag-defined` fires once per uncovered operation;
    // this catches it before the lint does, and names the offenders.
    const declared = new Set((spec.tags || []).map((t) => t.name));
    const used = new Set(operations.flatMap(({ op }) => op.tags || []));
    expect([...used].filter((t) => !declared.has(t)).sort()).toEqual([]);
  });

  it('does not declare a top-level tag that no operation uses', () => {
    const used = new Set(operations.flatMap(({ op }) => op.tags || []));
    expect((spec.tags || []).map((t) => t.name).filter((n) => !used.has(n))).toEqual([]);
  });

  it('only uses tags present in the curated registry', () => {
    const registered = new Set(OPENAPI_TAG_REGISTRY.map((t) => t.slug));
    const used = [...new Set(operations.flatMap(({ op }) => op.tags || []))];
    expect(used.filter((t) => !registered.has(t)).sort()).toEqual([]);
  });

  it.each(AUDIENCE_WORDS)('never uses %s as a primary tag', (word) => {
    const offenders = operations
      .filter(({ op }) => (op.tags || []).includes(word))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(offenders).toEqual([]);
  });

  it('keeps unclassified operations within the declared budget', () => {
    const unclassified = operations
      .filter(({ op }) => (op.tags || []).includes(UNCLASSIFIED_TAG))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    // Listed explicitly: this should shrink, and each removal is a real review.
    // The two /api/v1/staff/{identifier} operations left when
    // src/routes/staff/staffRoutes.js declared its domain. What remains is the
    // root liveness pair, which belongs to no subsystem by construction.
    expect(unclassified.sort()).toEqual(['GET /', 'HEAD /']);
    expect(unclassified.length).toBeLessThanOrEqual(UNCLASSIFIED_TAG_BUDGET);
  });

  it('emits top-level tags sorted by code-unit compare', () => {
    // localeCompare is locale-dependent and would flap the spec between
    // machines, false-tripping the drift gate.
    const names = (spec.tags || []).map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('never publishes a slug and its own plural as two tags', () => {
    // How `appointment`/`appointments`, `department`/`departments`,
    // `document`/`documents`, `entitlement`/`entitlements`,
    // `prescription`/`prescriptions` and `dashboard`/`dashboards` all appeared:
    // one side is a real route module, the other is a path- or sibling-directory
    // derivation of the same subject. Splitting one domain across two tags is
    // silent — nothing else fails — so pin it. Singular is the house style.
    const names = new Set((spec.tags || []).map((t) => t.name));
    const pairs = [...names]
      .filter((n) => names.has(`${n}s`))
      .map((n) => `${n} / ${n}s`);
    expect(pairs.sort()).toEqual([]);
  });

  it('uses only lowercase kebab-case slugs', () => {
    // Stops `clinical-ai` / `clinicalAi` / `clinical_ai` / `Clinical AI` from
    // becoming four groups, and keeps the code-unit sort alphabetical.
    const bad = (spec.tags || []).map((t) => t.name).filter((n) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n));
    expect(bad).toEqual([]);
  });

  describe('resolution spot-checks — a silent re-tag breaks these', () => {
    const tagOf = (method, path) => spec.paths[path]?.[method]?.tags?.[0];

    it('attributes a domain-directory module to its directory', () => {
      // src/routes/appointment/appointmentRoutes.js
      expect(tagOf('get', '/api/v1/appointments')).toBe('appointment');
      // src/routes/emr/*
      expect(tagOf('post', '/api/v1/emr/vitals')).toBe('emr');
    });

    it('descends past an AUDIENCE directory to the module that names the domain', () => {
      // src/routes/portal/... -> the file, never `portal`
      expect(tagOf('get', '/api/v1/portal/tpa/claims')).toBe('patient-portal');
    });

    it('skips a RUN of audience path segments to reach the real domain', () => {
      // /api/v1/admin/staff/attendance/... must not resolve to `staff`
      expect(tagOf('get', '/api/v1/admin/staff/attendance/late-arrivals')).toBe('attendance');
    });

    it('honours an explicit markRouterDomain declaration over the URL', () => {
      // src/routes/admin/index.js — a barrel that names nothing, so these would
      // otherwise path-derive to the junk slugs `dashboard`-adjacent verbs
      // (`alerts`, `activity`, `refresh-cache`, `export`, `summary`, `test`).
      expect(tagOf('get', '/api/v1/admin/alerts')).toBe('dashboard');
      expect(tagOf('post', '/api/v1/admin/refresh-cache')).toBe('dashboard');
      expect(tagOf('get', '/api/v1/admin/staff/summary')).toBe('stats');
      expect(tagOf('get', '/api/v1/admin/appointments/summary')).toBe('appointment');
      // src/routes/staff/staffRoutes.js — file name IS the audience word.
      expect(tagOf('get', '/api/v1/staff/list')).toBe('staff-admin');
      expect(tagOf('get', '/api/v1/staff/{identifier}')).toBe('staff-admin');
      // Sibling directories routes/dashboard/ and routes/dashboards/.
      expect(tagOf('get', '/api/v1/dashboards/catalog')).toBe('dashboard');
      // Registered directly on the app, so there is no route module to derive from.
      expect(tagOf('get', '/api/v1/departments/departments-with-doctors')).toBe('department');
    });

    it('spreads the /api/v1/admin/ surface across many domains, not one', () => {
      // The whole point: naive path derivation put all 895 under `admin`.
      const adminOps = operations.filter(({ path }) => path.startsWith('/api/v1/admin/'));
      const tags = new Set(adminOps.flatMap(({ op }) => op.tags || []));
      expect(adminOps.length).toBeGreaterThan(800);
      expect(tags.size).toBeGreaterThan(50);
    });

    it('keeps the largest single tag well under a junk-drawer share', () => {
      // >10% is a REVIEW ALARM rather than a hard rule (a genuinely broad
      // domain may exceed it) — but a sudden jump to a quarter of the API
      // means resolution collapsed, which is a defect.
      const counts = new Map();
      for (const { op } of operations) {
        for (const t of op.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      }
      const largest = Math.max(...counts.values());
      expect(largest / operations.length).toBeLessThan(0.15);
    });
  });
});
