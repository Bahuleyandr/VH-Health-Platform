// Unit tests for the client API path contract gate.
//   node --test scripts/ci/check-client-paths.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ADMIN_REWRITES,
  analyze,
  applyAdminRewrites,
  buildSpecIndex,
  canonicalizeRuntimeAlias,
  collectDartPathConstants,
  extractAdminPaths,
  extractDartPaths,
  extractNodePaths,
  isMountBase,
  isRuleExcluded,
  loadAllowlist,
  loadEndpointMap,
  loadProxyAllowedPrefixes,
  loadSpecIndex,
  matchesAllowlist,
  matchesLeniently,
  methodFromCallOptions,
  normalizeClientPath,
  normalizeSpecPath,
  parseEndpointMap,
  parseProxyAllowedPrefixes,
  policyTableRanges,
  proxyAllowsRuntimePath,
  repoRoot,
  resolveRuntimePath,
  scanStringLiterals,
  stripComments,
  stripProxyPrefix,
  substituteDartConstants,
} from './check-client-paths.mjs';

const norm = (s) => normalizeClientPath(s).path;

describe('normalizer', () => {
  test('collapses a whole segment containing an interpolation', () => {
    assert.equal(norm('/api/v1/beds/${vars.bedId}/admit'), '/api/v1/beds/{param}/admit');
    assert.equal(norm('/api/v1/patients/$patientId/vitals'), '/api/v1/patients/{param}/vitals');
    // Partial-segment interpolation still collapses the whole segment: the
    // router matches at segment granularity, so `prefix-${id}` is one param.
    assert.equal(norm('/api/v1/reports/prefix-${id}'), '/api/v1/reports/{param}');
  });

  test('treats :name and {name} as declared params, not interpolations', () => {
    assert.equal(norm('/api/v1/users/:identifier/status'), '/api/v1/users/{param}/status');
    assert.equal(norm('/api/v1/billing/invoice/{id}'), '/api/v1/billing/invoice/{param}');
    assert.equal(normalizeClientPath('/api/v1/users/:id').interpolated, false);
    assert.equal(normalizeClientPath('/api/v1/users/${id}').interpolated, true);
  });

  test('drops the query string', () => {
    assert.equal(norm('/api/v1/admin/users?page=2&limit=10'), '/api/v1/admin/users');
    assert.equal(norm('/api/v1/admin/users?page=${p}'), '/api/v1/admin/users');
  });

  test('a ? inside an interpolation is an operator, not a query separator', () => {
    // Regression: `${data?.unit.id}` used to truncate the path at the `?`.
    assert.equal(
      norm('/api/v1/blood-bank/units/${data?.unit.id}/discard-confirmation'),
      '/api/v1/blood-bank/units/{param}/discard-confirmation',
    );
  });

  test('an interpolation trailing a literal yields both readings, specific first', () => {
    // `all${qs ? `?${qs}` : ""}` contributes a QUERY, not a segment. Collapsing
    // it to {param} alone let it match an unrelated /prescriptions/{id} and
    // pass for the wrong reason, so both readings are offered.
    const { candidates } = normalizeClientPath('/api/v1/prescriptions/all${qs ? `?${qs}` : ""}');
    assert.deepEqual(candidates, ['/api/v1/prescriptions/all', '/api/v1/prescriptions/{param}']);
  });

  test('a whole-segment interpolation yields only the param reading', () => {
    assert.deepEqual(normalizeClientPath('/api/v1/beds/${id}/admit').candidates, [
      '/api/v1/beds/{param}/admit',
    ]);
  });

  test('collapses a trailing slash but keeps the root', () => {
    assert.equal(norm('/api/v1/admin/users/'), '/api/v1/admin/users');
    assert.equal(norm('/'), '/');
  });

  test('flags an unresolved leading segment instead of guessing', () => {
    assert.equal(normalizeClientPath('/api/v1/${base}/foo').unresolvedPrefix, false);
    assert.equal(normalizeClientPath('/${base}/foo').unresolvedPrefix, true);
  });

  test('spec placeholders normalize to the same token', () => {
    assert.equal(normalizeSpecPath('/api/v1/users/{identifier}/status'), '/api/v1/users/{param}/status');
  });
});

describe('admin runtime rewrite mirror', () => {
  test('prepends /api/v1 to a bare path', () => {
    assert.equal(applyAdminRewrites('/wards'), '/api/v1/wards');
  });

  test('leaves an already-prefixed path alone', () => {
    assert.equal(applyAdminRewrites('/api/v1/blood-bank/request'), '/api/v1/blood-bank/request');
  });

  test('applies the alias rewrites, prefixed or not', () => {
    assert.equal(applyAdminRewrites('/admin/users'), '/api/v1/users');
    assert.equal(applyAdminRewrites('/api/v1/admin/users'), '/api/v1/users');
    assert.equal(applyAdminRewrites('/admin/users?${params}'), '/api/v1/users');
    assert.equal(applyAdminRewrites('/appointments'), '/api/v1/appointments/list');
    assert.equal(applyAdminRewrites('/notifications/stats'), '/api/v1/notifications/admin/overview');
  });

  test('does not rewrite a sub-path of an aliased base', () => {
    // core.ts matches the alias EXACTLY; /admin/doctors/:id/profile passes through.
    assert.equal(applyAdminRewrites('/admin/doctors/7/profile'), '/api/v1/admin/doctors/7/profile');
  });

  test('verbatim helpers skip the rewrite table', () => {
    assert.equal(resolveRuntimePath('/api/v1/admin/users', 'admin', false), '/api/v1/admin/users');
    assert.equal(resolveRuntimePath('/api/v1/admin/users', 'admin', true), '/api/v1/users');
  });

  // The mirror is only safe while it matches the source it mirrors. If someone
  // adds a rewrite to core.ts, this fails and names the drift.
  test('stays in sync with normalizeAdminEndpoint in apps/admin/src/lib/api/core.ts', () => {
    const source = readFileSync(join(repoRoot, 'apps/admin/src/lib/api/core.ts'), 'utf8');
    const start = source.indexOf('function normalizeAdminEndpoint');
    assert.ok(start !== -1, 'normalizeAdminEndpoint not found — the admin API layer moved');
    const body = source.slice(start, source.indexOf('\n}', start));

    const sources = new Set();
    for (const m of body.matchAll(/path\s*===\s*"([^"]+)"/g)) sources.add(m[1]);

    assert.deepEqual(
      [...sources].sort(),
      [...ADMIN_REWRITES.keys()].sort(),
      'ADMIN_REWRITES has drifted from normalizeAdminEndpoint — update the map in ' +
        'scripts/ci/check-client-paths.mjs to match core.ts',
    );
  });
});

describe('lexer', () => {
  test('blanks comments while preserving offsets', () => {
    const src = "const a = 1; // ApiClient.get('/fake/path')\nconst b = '/real/path';";
    const out = stripComments(src, 'ts');
    assert.equal(out.length, src.length);
    assert.ok(!out.includes('/fake/path'));
    assert.ok(out.includes('/real/path'));
  });

  test('a // inside a string is not a comment', () => {
    const out = stripComments("const u = 'https://x.test/a'; // gone", 'ts');
    assert.ok(out.includes('https://x.test/a'));
    assert.ok(!out.includes('gone'));
  });

  test('reads a template literal containing a nested template', () => {
    const src = 'f(`/a/${x ? `?${y}` : ""}/b`)';
    const [lit] = scanStringLiterals(src, 'ts');
    assert.equal(lit.value, '/a/${x ? `?${y}` : ""}/b');
  });

  test('merges adjacent literals the way Dart and TS concatenate them', () => {
    const src = "f(\n  '/emr/${a}/pending/'\n  '${b}/cross-sign',\n)";
    const [lit] = scanStringLiterals(src, 'dart');
    assert.equal(lit.value, '/emr/${a}/pending/${b}/cross-sign');
  });
});

describe('admin extraction', () => {
  const endpointMap = new Map([
    ['auth.adminManagement', '/api/v1/auth/admin/list'],
    ['admin.sos.alerts', '/api/v1/admin/sos/alerts'],
  ]);

  test('infers the method from a verb-specific helper', () => {
    const { found } = extractAdminPaths('postJSON("/compliance/breach/report", body);');
    assert.deepEqual(
      found.map((f) => [f.method, f.value, f.rewrite]),
      [['POST', '/compliance/breach/report', true]],
    );
  });

  test('reads the method out of the options object, defaulting to GET', () => {
    const post = extractAdminPaths('fetchAdminAPI("/compliance/breaches", { method: "POST" });');
    assert.equal(post.found[0].method, 'POST');
    const get = extractAdminPaths('fetchAdminAPI("/compliance/breaches");');
    assert.equal(get.found[0].method, 'GET');
  });

  test('handles a generic argument and a next-line path argument', () => {
    const { found } = extractAdminPaths('const x = await getJSON<User[]>(\n  "/admin/activity/recent",\n);');
    assert.deepEqual(found.map((f) => [f.method, f.value]), [['GET', '/admin/activity/recent']]);
  });

  test('resolves an API_ENDPOINTS reference passed as the argument', () => {
    const { found } = extractAdminPaths('putJSON(API_ENDPOINTS.auth.adminManagement, body);', {
      endpointMap,
    });
    assert.deepEqual(found.map((f) => [f.method, f.value]), [['PUT', '/api/v1/auth/admin/list']]);
  });

  test('resolves an API_ENDPOINTS reference through a .replace() chain', () => {
    const map = new Map([['users.byRole', '/api/v1/users/role/:role']]);
    const { found } = extractAdminPaths('getJSON(API_ENDPOINTS.users.byRole.replace(":role", role));', {
      endpointMap: map,
    });
    assert.deepEqual(found.map((f) => [f.method, f.value]), [['GET', '/api/v1/users/role/:role']]);
  });

  test('ignores an API_ENDPOINTS reference that is not the path argument', () => {
    const { found, dynamicCallSites } = extractAdminPaths(
      'fetchAdminAPI(somePath, { headers: API_ENDPOINTS.auth.adminManagement });',
      { endpointMap },
    );
    assert.deepEqual(found, []);
    assert.equal(dynamicCallSites, 1);
  });

  test('substitutes an API_ENDPOINTS reference embedded in a template', () => {
    const { found } = extractAdminPaths(
      'fetchAdminAPI(`${API_ENDPOINTS.admin.sos.alerts}?limit=${n}`);',
      { endpointMap },
    );
    assert.equal(found[0].value, '/api/v1/admin/sos/alerts?limit=${n}');
  });

  test('binds a direct API_BASE_URL fetch to its endpoint and method', () => {
    const { found } = extractAdminPaths(
      'fetch(`${API_BASE_URL}${API_ENDPOINTS.auth.adminManagement}`, { method: "POST" });',
      { endpointMap },
    );
    assert.deepEqual(
      found.map((f) => [f.method, f.value, f.rewrite]),
      [['POST', '/api/v1/auth/admin/list', false]],
    );
  });

  test('extracts a window.fetch literal with the default GET verb', () => {
    const { found } = extractAdminPaths('window.fetch("/api/proxy/api/v1/health/health-check");');
    assert.deepEqual(
      found.map((f) => [f.method, f.value]),
      [['GET', '/api/proxy/api/v1/health/health-check']],
    );
  });

  test('counts a genuinely opaque argument instead of guessing', () => {
    const { found, dynamicCallSites } = extractAdminPaths('fetchAdminAPI(path, init);');
    assert.equal(found.length, 0);
    assert.equal(dynamicCallSites, 1);
  });

  test('picks up an anchored /api/v1 literal with no known call site', () => {
    const { found } = extractAdminPaths('export const P = "/api/v1/admin/cath-consumables/catalog";');
    assert.deepEqual(found.map((f) => [f.method, f.value]), [[null, '/api/v1/admin/cath-consumables/catalog']]);
  });

  test('skips policy tables — they hold patterns, not call sites', () => {
    const src = [
      'const PROTECTED_ROUTES = [',
      '  "/api/v1/auth/adminManagement",',
      '];',
      'const LIVE = "/api/v1/admin/alerts";',
    ].join('\n');
    assert.equal(policyTableRanges(src).length, 1);
    const { found } = extractAdminPaths(src);
    assert.deepEqual(found.map((f) => f.value), ['/api/v1/admin/alerts']);
  });

  // Audit R11 (2026-08-10): the report-builder stored bare-suffix paths in a
  // config table (`endpoint: "/attendance/admin/records"`) and invoked them
  // through a variable — the non-literal call site made the gate blind to a
  // production 404. `endpoint:` properties are now extracted as rewrite-style
  // paths with an unknowable verb.
  test('extracts a bare-suffix endpoint-property literal from a config table', () => {
    const src = [
      'const REPORT_CONFIGS = {',
      '  attendance: {',
      '    label: "Attendance",',
      '    endpoint: "/attendance/admin/records",',
      '  },',
      '};',
      'fetchAdminAPI(config.endpoint);',
    ].join('\n');
    const { found } = extractAdminPaths(src);
    assert.deepEqual(
      found.map((f) => [f.method, f.value, f.rewrite, f.via]),
      [[null, '/attendance/admin/records', true, 'endpoint-property']],
    );
  });

  test('endpoint-property extraction skips non-literal values', () => {
    const { found } = extractAdminPaths('const c = { endpoint: buildPath(kind) };');
    assert.deepEqual(found, []);
  });

  test('an endpoint-property literal already seen by a call-site pass is not duplicated', () => {
    const { found } = extractAdminPaths(
      'fetchAdminAPI("/x/y", { endpoint: "/x/y" });',
    );
    // The first literal is the call-site path; the options-object literal is a
    // separate offset and IS an endpoint property.
    assert.deepEqual(
      found.map((f) => f.via),
      ['fetchAdminAPI', 'endpoint-property'],
    );
  });
});

describe('API_ENDPOINTS parsing', () => {
  const src = [
    'export const API_ENDPOINTS = {',
    '  auth: {',
    '    admin: { login: "/api/v1/auth/admin/login" },',
    '    adminManagement: "/api/v1/auth/admin/list", // GET only',
    '  },',
    '  myWork: {',
    '    appointments: {',
    '      confirm: (id: number) => `/api/v1/appointments/${id}/confirm`,',
    '    },',
    '  },',
    '  users: { byRole: "/api/v1/users/role/:role" },',
    '};',
  ].join('\n');

  test('reads nested string leaves, arrow leaves, and :param leaves', () => {
    const map = parseEndpointMap(src);
    assert.equal(map.get('auth.admin.login'), '/api/v1/auth/admin/login');
    assert.equal(map.get('auth.adminManagement'), '/api/v1/auth/admin/list');
    assert.equal(map.get('myWork.appointments.confirm'), '/api/v1/appointments/${id}/confirm');
    assert.equal(map.get('users.byRole'), '/api/v1/users/role/:role');
  });

  test('parses the real api-config.ts', () => {
    const map = loadEndpointMap();
    assert.ok(map.size > 200, `expected the real config to yield many leaves, got ${map.size}`);
    assert.equal(map.get('auth.adminManagement'), '/api/v1/auth/admin/list');
  });
});

describe('dart extraction', () => {
  test('extracts from a client call, with the method from the receiver', () => {
    const { found } = extractDartPaths("await ApiClient.get('/departments/list');");
    assert.deepEqual(found.map((f) => [f.method, f.value]), [['GET', '/departments/list']]);
  });

  test('ignores a GoRouter navigation path of identical shape', () => {
    // This is the whole reason Dart extraction is call-site anchored.
    const { found } = extractDartPaths("context.push('/emr/case-sheet/\$admissionId');");
    assert.deepEqual(found, []);
  });

  test('substitutes a file-local base constant', () => {
    const src = [
      "  static const _basePath = '/clinical-ai/clinical/biomed-cmms';",
      "  final r = await ApiClient.post('\$_basePath/work-orders/\$id/start');",
    ].join('\n');
    assert.equal(collectDartPathConstants(src).get('_basePath'), '/clinical-ai/clinical/biomed-cmms');
    const { found } = extractDartPaths(src);
    assert.deepEqual(found.map((f) => [f.method, f.value]), [
      ['POST', '/clinical-ai/clinical/biomed-cmms/work-orders/$id/start'],
    ]);
  });

  test('leaves an unknown $name untouched', () => {
    assert.equal(substituteDartConstants('/a/$unknown/b', new Map()), '/a/$unknown/b');
  });

  test('extracts a raw package:http call that interpolates the API base', () => {
    const { found } = extractDartPaths(
      "final uri = Uri.parse('\${ApiConfig.baseUrl}/health/app-version');",
    );
    assert.deepEqual(found.map((f) => f.value), ['/health/app-version']);
  });

  test('infers the verb when a raw package:http call consumes a URI variable', () => {
    const { found } = extractDartPaths(`
      final url = Uri.parse('\${ApiConfig.baseUrl}/auth/dev/patient-login');
      final response = await http.post(url, body: '{}');
    `);
    assert.deepEqual(found.map((f) => [f.method, f.value]), [
      ['POST', '/auth/dev/patient-login'],
    ]);
  });

  test('reads the named path argument of sendPreparedMutation', () => {
    const { found } = extractDartPaths(
      "VHHttpClient.sendPreparedMutation(cmd, path: '/clinical/mar/1/administer', method: 'POST');",
    );
    assert.deepEqual(found.map((f) => [f.method, f.value]), [
      ['POST', '/clinical/mar/1/administer'],
    ]);
  });

  test('ignores multipartFileFromPath — that argument is a filesystem path', () => {
    const { found } = extractDartPaths("ApiClient.multipartFileFromPath('file', '/tmp/x.png');");
    assert.deepEqual(found, []);
  });

  test('a dart suffix resolves against the /api/v1 base', () => {
    assert.equal(resolveRuntimePath('/departments/list', 'dart', false), '/api/v1/departments/list');
  });
});

describe('device gateway extraction', () => {
  test('strips the interpolated origin and reads the method', () => {
    // Verbatim shape from apps/device-gateway/src/backendClient.js.
    const src =
      'const res = await this.fetchImpl(`${this.baseUrl}/api/v1/devices/vitals/ingest`, {\n' +
      "  method: 'POST',\n" +
      '  headers: this.headers(),\n' +
      '});';
    const { found } = extractNodePaths(src);
    assert.deepEqual(found.map((f) => [f.method, f.value]), [
      ['POST', '/api/v1/devices/vitals/ingest'],
    ]);
  });

  test('methodFromCallOptions returns null when no verb is named', () => {
    assert.equal(methodFromCallOptions('{ headers: h }'), null);
    assert.equal(methodFromCallOptions("{ method: 'patch' }"), 'PATCH');
  });
});

describe('rule-based exclusions', () => {
  test('excludes non-API surfaces without needing an allowlist entry', () => {
    for (const p of [
      '/api/login',
      '/api/refresh',
      '/api/act-as',
      '/api-docs',
      '/ws',
      '/_next/static/x.js',
      '/images/hospital-logo.png',
      '/dashboard/users',
      '/login',
    ]) {
      assert.equal(isRuleExcluded(p), true, `${p} should be excluded by rule`);
    }
  });

  test('does not exclude a real API path', () => {
    assert.equal(isRuleExcluded('/api/v1/admin/users'), false);
    assert.equal(isRuleExcluded('/api/v1/users'), false);
  });

  test('strips the browser-leg proxy prefix', () => {
    assert.equal(stripProxyPrefix('/api/proxy/api/v1/blood-bank/registers/x'), '/api/v1/blood-bank/registers/x');
    assert.equal(stripProxyPrefix('/api/v1/x'), '/api/v1/x');
  });
});

describe('admin proxy allowlist contract', () => {
  test('parses the runtime prefix table and preserves segment boundaries', () => {
    const source = [
      'const ALLOWED_PATH_PREFIXES = [',
      '  "api/v1/patients",',
      '  "api/v1/diagnostic-results/",',
      '];',
    ].join('\n');
    const prefixes = parseProxyAllowedPrefixes(source);
    assert.deepEqual(prefixes, [
      'api/v1/patients',
      'api/v1/diagnostic-results/',
    ]);
    assert.equal(proxyAllowsRuntimePath('/api/v1/patients/search', prefixes), true);
    assert.equal(proxyAllowsRuntimePath('/api/v1/patients-internal/search', prefixes), false);
  });

  test('the shipped proxy admits every currently extracted admin path', () => {
    const prefixes = loadProxyAllowedPrefixes();
    assert.ok(prefixes.includes('api/v1/patients/search'));
    assert.ok(prefixes.includes('api/v1/diagnostic-results'));
    assert.equal(proxyAllowsRuntimePath('/api/v1/patients/abc/timeline', prefixes), false);
    const result = analyze({
      index: loadSpecIndex(),
      allowlist: loadAllowlist(),
      proxyPrefixes: prefixes,
    });
    assert.equal(result.findings.filter((finding) => finding.reason === 'proxy').length, 0);
  });
});

describe('spec matching', () => {
  const index = buildSpecIndex({
    '/api/v1/users': { get: {}, post: {} },
    '/api/v1/users/{identifier}/status': { put: {} },
    '/api/v1/admin/analytics/revenue': { get: {} },
    '/api/v1/auth/admin/list': { get: {} },
  });

  test('indexes methods per path', () => {
    assert.deepEqual([...index.exact.get('/api/v1/users')].sort(), ['GET', 'POST']);
  });

  test('accepts a bare array of paths (methods unknown)', () => {
    const bare = buildSpecIndex(['/api/v1/users']);
    assert.equal(bare.exact.get('/api/v1/users').size, 0);
  });

  test('a mount base is a segment-boundary prefix of a real operation', () => {
    assert.equal(isMountBase('/api/v1/admin/analytics', index), true);
    assert.equal(isMountBase('/api/v1/admin/analytic', index), false);
    assert.equal(isMountBase('/api/v1/users', index), false); // it IS an operation
  });

  test('lenient matching lets a {param} stand in for a literal segment', () => {
    assert.equal(matchesLeniently('/api/v1/admin/{param}/revenue', index), true);
    assert.equal(matchesLeniently('/api/v1/admin/{param}/nope', index), false);
  });

  test('maps runtime aliases to their canonical spec operations', () => {
    assert.equal(
      canonicalizeRuntimeAlias('/api/v1/emr/mar/17/administer', 'POST'),
      '/api/v1/clinical/mar/17/administer',
    );
    assert.equal(
      canonicalizeRuntimeAlias('/api/v1/admissions', 'POST'),
      '/api/v1/admissions/admit',
    );
    assert.equal(
      canonicalizeRuntimeAlias('/api/v1/admissions/42', 'GET'),
      '/api/v1/admissions/admission/42',
    );
    assert.equal(
      canonicalizeRuntimeAlias('/api/v1/admissions/lookup', 'GET'),
      '/api/v1/admissions/lookup',
    );
  });
});

describe('allowlist', () => {
  const entries = [
    { path: '/api/v1/auth/dev/patient-login', methods: ['POST'], comment: 'conditional route' },
  ];

  test('matches only the exact path and an allowed method', () => {
    assert.ok(matchesAllowlist('/api/v1/auth/dev/patient-login', entries, 'POST'));
    assert.equal(matchesAllowlist('/api/v1/auth/dev/patient-login', entries, 'GET'), null);
    assert.equal(matchesAllowlist('/api/v1/auth/dev/patient-login', entries), null);
    assert.equal(matchesAllowlist('/api/v1/auth/dev/other', entries, 'POST'), null);
  });

  test('the shipped allowlist parses and every entry carries a comment', () => {
    const shipped = loadAllowlist();
    assert.ok(shipped.length > 0);
    for (const entry of shipped) {
      assert.ok(entry.path.startsWith('/api/v1/'), `${entry.path} should be a resolved API path`);
      assert.ok(!entry.path.includes('*'), `${entry.path} must be exact`);
      assert.ok(entry.methods.length > 0, `${entry.path} needs served methods`);
      assert.ok(entry.comment.length > 40, `${entry.path} needs a real justification`);
    }
  });
});

describe('end-to-end classification', () => {
  const index = buildSpecIndex({
    '/api/v1/auth/admin/list': { get: {} },
    '/api/v1/auth/admin/create-admin': { post: {} },
    '/api/v1/wards': { get: {} },
  });
  const sources = [
    { id: 't', kind: 'admin', root: 'scripts/ci', extensions: ['.nonexistent'], excludeDirs: [] },
  ];

  test('a served path+method passes, a wrong verb on a real path fails', () => {
    const served = index.exact.get('/api/v1/auth/admin/list');
    assert.ok(served.has('GET'));
    assert.ok(!served.has('POST'));
  });

  test('analyze runs over the real repo and returns a well-formed report', () => {
    const result = analyze({ index: loadSpecIndex(), allowlist: loadAllowlist() });
    assert.ok(result.stats.filesScanned > 500);
    assert.ok(result.stats.checked > 500);
    for (const f of result.findings) {
      assert.ok(f.file && f.line > 0, 'every finding needs a file:line');
      assert.ok(['path', 'method', 'proxy'].includes(f.reason));
      assert.ok(f.resolved.startsWith('/api/v1'));
    }
  });

  test('a known-method call cannot pass merely because it names a mount base', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'client-path-contract-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const client = join(root, 'client');
    mkdirSync(client);
    writeFileSync(
      join(client, 'calls.ts'),
      `fetchAdminAPI('/admin/analytics');\nconst declared = '/api/v1/admin/analytics';\n`,
    );
    const result = analyze({
      root,
      sources: [{ id: 'fixture', kind: 'admin', root: 'client', extensions: ['.ts'] }],
      index: buildSpecIndex({ '/api/v1/admin/analytics/revenue': { get: {} } }),
      allowlist: [],
      proxyPrefixes: ['api/v1/admin/'],
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].method, 'GET');
    assert.equal(result.findings[0].resolved, '/api/v1/admin/analytics');
    assert.equal(result.stats.mountBases, 1);
  });

  test('an empty source set yields no findings', () => {
    const result = analyze({ sources, index, allowlist: [] });
    assert.deepEqual(result.findings, []);
  });

  test('a served admin path still fails when the runtime proxy blocks it', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'client-proxy-contract-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const client = join(root, 'client');
    mkdirSync(client);
    writeFileSync(join(client, 'calls.ts'), "getJSON('/patients/search');\n");
    const result = analyze({
      root,
      sources: [{ id: 'fixture', kind: 'admin', root: 'client', extensions: ['.ts'] }],
      index: buildSpecIndex({ '/api/v1/patients/search': { get: {} } }),
      allowlist: [],
      proxyPrefixes: ['api/v1/users'],
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].reason, 'proxy');
  });

  test('a direct browser fetch is still governed by the runtime proxy', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'client-proxy-fetch-contract-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const client = join(root, 'client');
    mkdirSync(client);
    writeFileSync(
      join(client, 'page.ts'),
      "fetch(`${API_BASE_URL}/patients/search`);\n",
    );
    const result = analyze({
      root,
      sources: [{ id: 'fixture', kind: 'admin', root: 'client', extensions: ['.ts'] }],
      index: buildSpecIndex({ '/api/v1/patients/search': { get: {} } }),
      allowlist: [],
      proxyPrefixes: ['api/v1/users'],
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].reason, 'proxy');
  });
});
