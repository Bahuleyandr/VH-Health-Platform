import {
  expressPathToOpenApi, joinPath, pathParamNames, operationId,
  composeRoutes, buildOpenApiDocument, pathSignature, findEquivalentPathCollisions,
  kebabCase, tagFromSourceFile, tagFromPath, resolveTags, UNCLASSIFIED_TAG,
} from '../../../scripts/openapi/buildSpec.mjs';
import { markRouterDomain, getRouterDomain } from '../../config/openapiDomain.js';

// Every tag an operation uses must be declared, so tests that build a document
// declare the slugs they exercise. `reg()` keeps that noise out of each test.
const reg = (...slugs) => slugs.map((s) => (typeof s === 'string' ? { slug: s } : s));

describe('openapi buildSpec helpers', () => {
  test('expressPathToOpenApi converts :param and *splat to {brace}', () => {
    expect(expressPathToOpenApi('/users/:id')).toBe('/users/{id}');
    expect(expressPathToOpenApi('/a/:x/b/:y')).toBe('/a/{x}/b/{y}');
    expect(expressPathToOpenApi('/files/*splat')).toBe('/files/{splat}');
    expect(expressPathToOpenApi('/already/{id}')).toBe('/already/{id}');
  });

  test('joinPath normalizes slashes and root', () => {
    expect(joinPath('/api/v1/users', '/')).toBe('/api/v1/users');
    expect(joinPath('/api/v1/users', '/:id')).toBe('/api/v1/users/:id');
    expect(joinPath('', '/')).toBe('/');
    expect(joinPath('/a/', 'b')).toBe('/a/b');
  });

  test('pathParamNames + operationId', () => {
    expect(pathParamNames('/users/{id}/notes/{noteId}')).toEqual(['id', 'noteId']);
    expect(operationId('GET', '/users/{id}')).toBe('get_users_by_id');
    expect(operationId('POST', '/')).toBe('post_root');
  });

  test('composeRoutes walks mount edges and sorts + dedupes', () => {
    const root = { id: 'root' };
    const usersR = { id: 'users' };
    const route = (methods) => ({ methods });
    const routerRoutes = new Map([
      [root, [{ relPath: '/', route: route({ get: true }) }]],
      [usersR, [
        { relPath: '/', route: route({ get: true, post: true }) },
        { relPath: '/:id', route: route({ get: true }) },
      ]],
    ]);
    const edges = new Map([[root, [{ prefix: '/api/v1/users', child: usersR }]]]);
    expect(composeRoutes({ routerRoutes, edges, root })).toEqual([
      { method: 'get', path: '/', srcFile: null, domain: null },
      { method: 'get', path: '/api/v1/users', srcFile: null, domain: null },
      { method: 'post', path: '/api/v1/users', srcFile: null, domain: null },
      { method: 'get', path: '/api/v1/users/{id}', srcFile: null, domain: null },
    ]);
  });

  test('composeRoutes carries the registering module through to every operation', () => {
    const root = { id: 'root' };
    const usersR = { id: 'users' };
    const routerRoutes = new Map([
      [usersR, [{ relPath: '/:id', route: { methods: { get: true, put: true } }, srcFile: 'user/userRoutes.js' }]],
    ]);
    const edges = new Map([[root, [{ prefix: '/api/v1/users', child: usersR }]]]);
    expect(composeRoutes({ routerRoutes, edges, root })).toEqual([
      { method: 'get', path: '/api/v1/users/{id}', srcFile: 'user/userRoutes.js', domain: null },
      { method: 'put', path: '/api/v1/users/{id}', srcFile: 'user/userRoutes.js', domain: null },
    ]);
  });

  test('composeRoutes inherits a declared domain and lets the NEAREST child override it', () => {
    const root = { id: 'root' };
    const parent = { id: 'parent' };
    const child = { id: 'child' };
    const routerRoutes = new Map([
      [parent, [{ relPath: '/p', route: { methods: { get: true } } }]],
      [child, [{ relPath: '/c', route: { methods: { get: true } } }]],
    ]);
    const edges = new Map([
      [root, [{ prefix: '/api/v1/outer', child: parent }]],
      [parent, [{ prefix: '/inner', child }]],
    ]);
    // parent declares `outer`; the child re-declares `inner-domain` and wins for
    // its own routes, while the parent's own routes keep `outer`.
    const routerDomains = new Map([[parent, 'outer'], [child, 'inner-domain']]);
    expect(composeRoutes({ routerRoutes, edges, root, routerDomains })).toEqual([
      { method: 'get', path: '/api/v1/outer/inner/c', srcFile: null, domain: 'inner-domain' },
      { method: 'get', path: '/api/v1/outer/p', srcFile: null, domain: 'outer' },
    ]);
  });

  test('buildOpenApiDocument produces sorted paths, unique operationIds, path params', () => {
    const routes = [
      { method: 'get', path: '/users/{id}' },
      { method: 'get', path: '/a-b' },
      { method: 'get', path: '/a_b' },
    ];
    const doc = buildOpenApiDocument(routes, {
      openapi: '3.0.3', paths: { IGNORED: true }, tagRegistry: reg('users', 'a-b'),
    });
    expect(Object.keys(doc.paths)).toEqual(['/a-b', '/a_b', '/users/{id}']);
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((op) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(doc.paths['/users/{id}'].get.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    expect(doc.paths['/users/{id}'].get.responses['200'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/Success' });
  });

  test('pathSignature strips param names', () => {
    expect(pathSignature('/d/{id}')).toBe('/d/{}');
    expect(pathSignature('/d/{deptId}/x/{y}')).toBe('/d/{}/x/{}');
    expect(pathSignature('/d/plain')).toBe('/d/plain');
  });

  test('buildOpenApiDocument collapses param-equivalent paths to one canonical', () => {
    const routes = [
      { method: 'get', path: '/d/{id}' },
      { method: 'post', path: '/d/{deptId}' },
    ];
    const doc = buildOpenApiDocument(routes, { paths: {}, tagRegistry: reg('d') });
    // '{deptId}' < '{id}' lexicographically -> canonical, union of methods
    expect(Object.keys(doc.paths)).toEqual(['/d/{deptId}']);
    expect(Object.keys(doc.paths['/d/{deptId}']).sort()).toEqual(['get', 'post']);
  });

  test('findEquivalentPathCollisions reports param-equivalent groups', () => {
    const routes = [
      { method: 'get', path: '/d/{id}' },
      { method: 'get', path: '/d/{deptId}' },
      { method: 'get', path: '/x' },
    ];
    expect(findEquivalentPathCollisions(routes)).toEqual([
      { signature: '/d/{}', paths: ['/d/{deptId}', '/d/{id}'] },
    ]);
  });
});

describe('buildOpenApiDocument overlay', () => {
  const base = {
    openapi: '3.0.3',
    components: { schemas: {} },
    tagRegistry: reg('x', 'y'),
  };

  it('attaches request + response $refs from the overlay', () => {
    const routes = [{ method: 'post', path: '/api/v1/x' }];
    const overlay = { 'POST /api/v1/x': { request: 'XReq', response: 'XResp' } };
    const doc = buildOpenApiDocument(routes, base, overlay);
    const op = doc.paths['/api/v1/x'].post;
    expect(op.requestBody.required).toBe(true);
    expect(op.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/XReq' });
    expect(op.responses[200].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/XResp' });
  });

  it('allows an overlay to document an optional request body', () => {
    const routes = [{ method: 'post', path: '/api/v1/x' }];
    const overlay = {
      'POST /api/v1/x': { request: 'XReq', requestRequired: false },
    };
    const doc = buildOpenApiDocument(routes, base, overlay);
    expect(doc.paths['/api/v1/x'].post.requestBody.required).toBe(false);
  });

  it('attaches exact non-JSON request content from the overlay', () => {
    const routes = [{ method: 'post', path: '/api/v1/x' }];
    const overlay = {
      'POST /api/v1/x': {
        requestContent: {
          'application/x-www-form-urlencoded': 'XFormRequest',
          'application/json': 'XJsonRequest',
        },
      },
    };
    const doc = buildOpenApiDocument(routes, base, overlay);
    expect(doc.paths['/api/v1/x'].post.requestBody).toEqual({
      required: true,
      content: {
        'application/x-www-form-urlencoded': {
          schema: { $ref: '#/components/schemas/XFormRequest' },
        },
        'application/json': {
          schema: { $ref: '#/components/schemas/XJsonRequest' },
        },
      },
    });
  });

  it('attaches overlay query parameters after path parameters', () => {
    const routes = [{ method: 'get', path: '/api/v1/x/{id}' }];
    const overlay = {
      'GET /api/v1/x/{id}': {
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
        ],
      },
    };
    const doc = buildOpenApiDocument(routes, base, overlay);
    const op = doc.paths['/api/v1/x/{id}'].get;
    expect(op.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
    ]);
  });

  it('allows an overlay to replace an inferred path parameter schema without duplication', () => {
    const routes = [{ method: 'get', path: '/api/v1/x/{id}' }];
    const overlay = {
      'GET /api/v1/x/{id}': {
        pathParameters: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    };
    const doc = buildOpenApiDocument(routes, base, overlay);
    expect(doc.paths['/api/v1/x/{id}'].get.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    ]);
  });

  it('allows an overlay to select the successful response status', () => {
    const routes = [{ method: 'post', path: '/api/v1/x' }];
    const overlay = {
      'POST /api/v1/x': {
        response: 'XResp',
        responseStatus: 201,
        responseDescription: 'Created X.',
      },
    };
    const doc = buildOpenApiDocument(routes, base, overlay);
    const responses = doc.paths['/api/v1/x'].post.responses;
    expect(Object.keys(responses)).toEqual(['201']);
    expect(responses[201].description).toBe('Created X.');
    expect(responses[201].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/XResp',
    });
  });

  it('documents vendor-media success bytes and additional lifecycle responses', () => {
    const routes = [{ method: 'get', path: '/api/v1/x' }];
    const overlay = {
      'GET /api/v1/x': {
        response: 'SignedBytes',
        responseContentType: 'application/vnd.example.signed+json',
        additionalResponses: {
          304: { description: 'Not modified' },
          410: { description: 'Revoked' },
        },
      },
    };
    const doc = buildOpenApiDocument(routes, base, overlay);
    const responses = doc.paths['/api/v1/x'].get.responses;
    expect(responses[200].content).toEqual({
      'application/vnd.example.signed+json': {
        schema: { $ref: '#/components/schemas/SignedBytes' },
      },
    });
    expect(responses[304]).toEqual({ description: 'Not modified' });
    expect(responses[410]).toEqual({ description: 'Revoked' });
  });

  it('attaches overlay summary, description, and response description', () => {
    const routes = [{ method: 'get', path: '/api/v1/x' }];
    const overlay = {
      'GET /api/v1/x': {
        summary: 'List X',
        description: 'Only safe X rows are visible.',
        responseDescription: 'Safe X rows.',
      },
    };
    const doc = buildOpenApiDocument(routes, base, overlay);
    const op = doc.paths['/api/v1/x'].get;
    expect(op.summary).toBe('List X');
    expect(op.description).toBe('Only safe X rows are visible.');
    expect(op.responses[200].description).toBe('Safe X rows.');
  });

  it('allows an overlay to require API key and bearer authentication together', () => {
    const routes = [{ method: 'post', path: '/api/v1/x' }];
    const overlay = {
      'POST /api/v1/x': {
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
      },
    };
    const doc = buildOpenApiDocument(routes, base, overlay);

    expect(doc.paths['/api/v1/x'].post.security).toEqual([
      { ApiKeyAuth: [], BearerAuth: [] },
    ]);
  });

  it('falls back to the generic Success response when no overlay entry exists', () => {
    const routes = [{ method: 'get', path: '/api/v1/y' }];
    const doc = buildOpenApiDocument(routes, base, {});
    const op = doc.paths['/api/v1/y'].get;
    expect(op.responses[200].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Success' });
    expect(op.requestBody).toBeUndefined();
  });
});

describe('openapi tag derivation', () => {
  test('kebabCase normalizes camelCase and separators', () => {
    expect(kebabCase('carePathway')).toBe('care-pathway');
    expect(kebabCase('clinicalAI')).toBe('clinical-ai');
    expect(kebabCase('blood_bank')).toBe('blood-bank');
    expect(kebabCase('emr')).toBe('emr');
  });

  test('kebabCase splits an acronym run from the word after it', () => {
    // Without this, tierAAssistantsRoutes.js produced the unreadable published
    // tag `tier-aassistants` — caught by the curated registry review.
    expect(kebabCase('tierAAssistants')).toBe('tier-a-assistants');
    expect(kebabCase('tierGPublicHealth')).toBe('tier-g-public-health');
    expect(kebabCase('HL7Message')).toBe('hl7-message');
    // A trailing acronym has no following word and is left intact.
    expect(kebabCase('exportPDF')).toBe('export-pdf');
  });

  test('tagFromSourceFile uses the domain directory when there is one', () => {
    expect(tagFromSourceFile('appointment/appointmentRoutes.js')).toBe('appointment');
    expect(tagFromSourceFile('bloodbank/donorRoutes.js')).toBe('bloodbank');
    expect(tagFromSourceFile('emr/nested/deepRoutes.js')).toBe('emr');
  });

  test('tagFromSourceFile descends past AUDIENCE directories to the real subsystem', () => {
    // src/routes/admin/ alone holds 895 operations — the directory names who is
    // calling, not what the resource is, so the file name carries the domain.
    expect(tagFromSourceFile('admin/tenantRoutes.js')).toBe('tenant');
    expect(tagFromSourceFile('staff/rosterRoutes.js')).toBe('roster');
    expect(tagFromSourceFile('portal/tpaClaimRoutes.js')).toBe('tpa-claim');
  });

  test('tagFromSourceFile never yields an audience word as a primary tag', () => {
    // A barrel under an audience dir names nothing — not `index`, and NOT the
    // audience. `admin`/`staff`/`portal` say who is calling, not what it is.
    expect(tagFromSourceFile('admin/index.js')).toBeNull();
    expect(tagFromSourceFile('portal/index.js')).toBeNull();
    // The FILE name can also be the bare audience word — same non-signal.
    expect(tagFromSourceFile('staff/staffRoutes.js')).toBeNull();
    // A non-audience directory already wins, so its barrel is unaffected.
    expect(tagFromSourceFile('emr/index.js')).toBe('emr');
    expect(tagFromSourceFile('index.js')).toBeNull();
  });

  test('tagFromSourceFile handles top-level route files and strips the Routes suffix', () => {
    expect(tagFromSourceFile('carePathwayRoutes.js')).toBe('care-pathway');
    expect(tagFromSourceFile('sosRoutes.js')).toBe('sos');
    expect(tagFromSourceFile(null)).toBeNull();
    expect(tagFromSourceFile('')).toBeNull();
  });

  test('tagFromPath skips the version prefix and any audience segment', () => {
    expect(tagFromPath('/api/v1/appointments/{id}')).toBe('appointments');
    expect(tagFromPath('/api/v1/admin/clinical-ai/models')).toBe('clinical-ai');
    expect(tagFromPath('/api/v1/staff/roster')).toBe('roster');
    expect(tagFromPath('/api/v2/billing')).toBe('billing');
  });

  test('tagFromPath skips a RUN of audience segments to reach the real domain', () => {
    // Two stacked audience prefixes; stopping after the first would yield `staff`.
    expect(tagFromPath('/api/v1/admin/staff/attendance/late-arrivals')).toBe('attendance');
  });

  test('tagFromPath returns null rather than emit a bare audience tag', () => {
    // Nothing after the audience segment to descend to — do NOT fall back to it.
    expect(tagFromPath('/api/v1/admin')).toBeNull();
    expect(tagFromPath('/api/v1/staff')).toBeNull();
    expect(tagFromPath('/api/v1/staff/{identifier}')).toBeNull();
  });

  test('tagFromPath returns null when no usable segment remains', () => {
    expect(tagFromPath('/')).toBeNull();
    expect(tagFromPath('/api/v1/{id}')).toBeNull();
  });

  test('resolveTags prefers an explicit overlay tag over every derivation', () => {
    expect(resolveTags({
      ov: { tags: ['money'] },
      domain: 'billing',
      srcFile: 'billing/invoiceRoutes.js',
      path: '/api/v1/billing',
    })).toEqual(['money']);
    // singular `ov.tag` is accepted too
    expect(resolveTags({ ov: { tag: 'money' }, path: '/api/v1/billing' })).toEqual(['money']);
  });

  test('resolveTags prefers an explicit router domain over the filename bootstrap', () => {
    // The declared domain pins the published tag, so a file move cannot change it.
    expect(resolveTags({
      domain: 'appointments',
      srcFile: 'legacy/oldNameRoutes.js',
      path: '/api/v1/legacy',
    })).toEqual(['appointments']);
  });

  test('resolveTags falls back module -> path -> unclassified', () => {
    expect(resolveTags({ srcFile: 'admin/tenantRoutes.js', path: '/api/v1/admin/tenants' }))
      .toEqual(['tenant']);
    expect(resolveTags({ srcFile: null, path: '/api/v1/reports' })).toEqual(['reports']);
    expect(resolveTags({ srcFile: null, path: '/' })).toEqual([UNCLASSIFIED_TAG]);
  });

  test('resolveTags never invents a domain for an audience-only signal', () => {
    expect(resolveTags({ srcFile: 'staff/staffRoutes.js', path: '/api/v1/staff/{identifier}' }))
      .toEqual([UNCLASSIFIED_TAG]);
  });
});

describe('markRouterDomain', () => {
  test('declares a domain the generator can read back', () => {
    const router = () => {};
    expect(getRouterDomain(router)).toBeNull();
    expect(markRouterDomain(router, 'care-pathways')).toBe(router);
    expect(getRouterDomain(router)).toBe('care-pathways');
  });

  test('rejects a slug that is not lowercase kebab-case', () => {
    const router = () => {};
    for (const bad of ['Clinical AI', 'clinicalAi', 'clinical_ai', '', '-x', 'x-']) {
      expect(() => markRouterDomain(router, bad)).toThrow(/kebab-case/);
    }
  });

  test('rejects a non-router', () => {
    expect(() => markRouterDomain(null, 'lab')).toThrow(/Express router/);
  });

  test('the declaration is non-enumerable so it cannot leak into serialization', () => {
    const router = {};
    markRouterDomain(router, 'lab');
    expect(Object.keys(router)).toEqual([]);
    expect(JSON.stringify(router)).toBe('{}');
  });
});

describe('buildOpenApiDocument tags', () => {
  const baseWith = (...slugs) => ({
    openapi: '3.0.3', components: { schemas: {} }, tagRegistry: reg(...slugs),
  });

  it('tags every operation and emits a matching top-level tags array', () => {
    const routes = [
      { method: 'get', path: '/api/v1/users', srcFile: 'user/userRoutes.js' },
      { method: 'get', path: '/api/v1/appointments', srcFile: 'appointment/appointmentRoutes.js' },
    ];
    const doc = buildOpenApiDocument(routes, baseWith('user', 'appointment'), {});
    expect(doc.paths['/api/v1/users'].get.tags).toEqual(['user']);
    expect(doc.paths['/api/v1/appointments'].get.tags).toEqual(['appointment']);
    expect(doc.tags).toEqual([{ name: 'appointment' }, { name: 'user' }]);
  });

  it('gives every operation exactly ONE primary tag', () => {
    const doc = buildOpenApiDocument([
      { method: 'get', path: '/api/v1/a', srcFile: 'lab/labRoutes.js' },
      { method: 'post', path: '/api/v1/b' },
    ], baseWith('lab', 'b'), {});
    for (const p of Object.values(doc.paths)) {
      for (const op of Object.values(p)) expect(op.tags).toHaveLength(1);
    }
  });

  it('emits every used tag at the top level — Spectral operation-tag-defined invariant', () => {
    const routes = [
      { method: 'get', path: '/api/v1/a', srcFile: 'zeta/zetaRoutes.js' },
      { method: 'get', path: '/api/v1/b', srcFile: 'alpha/alphaRoutes.js' },
      { method: 'post', path: '/api/v1/c' }, // no srcFile -> path fallback
    ];
    const doc = buildOpenApiDocument(routes, baseWith('zeta', 'alpha', 'custom'), {
      'POST /api/v1/c': { tags: ['custom'] },
    });
    const used = new Set(
      Object.values(doc.paths).flatMap((p) => Object.values(p).flatMap((op) => op.tags)),
    );
    const declared = new Set(doc.tags.map((t) => t.name));
    for (const t of used) expect(declared).toContain(t);
    expect(used.size).toBe(declared.size);
  });

  it('THROWS on a tag slug that is not in the curated registry', () => {
    // This is what stops a renamed route module from silently republishing the
    // API under a new taxonomy, and what keeps slug spellings from diverging.
    expect(() => buildOpenApiDocument(
      [{ method: 'get', path: '/api/v1/a', srcFile: 'newlyRenamed/xRoutes.js' }],
      baseWith('lab'),
      {},
    )).toThrow(/not declared in OPENAPI_TAG_REGISTRY[\s\S]*newly-renamed/);
  });

  it('THROWS when unclassified operations exceed the declared budget', () => {
    const base = { ...baseWith(UNCLASSIFIED_TAG), unclassifiedTagBudget: 1 };
    const twoUnclassified = [
      { method: 'get', path: '/' },
      { method: 'head', path: '/' },
    ];
    expect(() => buildOpenApiDocument(twoUnclassified, base, {}))
      .toThrow(/over the declared budget of 1/);
    // At budget it passes.
    expect(() => buildOpenApiDocument(
      [{ method: 'get', path: '/' }], base, {},
    )).not.toThrow();
  });

  it('sorts top-level tags by code unit, not locale', () => {
    const routes = [
      { method: 'get', path: '/api/v1/a', srcFile: 'care-pathway/xRoutes.js' },
      { method: 'get', path: '/api/v1/b', srcFile: 'care_team/yRoutes.js' },
      { method: 'get', path: '/api/v1/c', srcFile: 'careplan/zRoutes.js' },
    ];
    const doc = buildOpenApiDocument(routes, baseWith('care-pathway', 'care-team', 'careplan'), {});
    const names = doc.tags.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // '-' (0x2D) sorts before letters under code-unit compare; localeCompare
    // commonly ignores it entirely and would order these differently.
    expect(names).toEqual(['care-pathway', 'care-team', 'careplan']);
  });

  it('carries a curated description from the registry onto the emitted tag', () => {
    const routes = [
      { method: 'get', path: '/api/v1/a', srcFile: 'lab/labRoutes.js' },
      { method: 'get', path: '/api/v1/b', srcFile: 'user/userRoutes.js' },
    ];
    const base = {
      openapi: '3.0.3',
      components: { schemas: {} },
      tagRegistry: [{ slug: 'lab', description: 'Lab orders and results.' }, { slug: 'user' }],
    };
    const doc = buildOpenApiDocument(routes, base, {});
    expect(doc.tags).toEqual([
      { name: 'lab', description: 'Lab orders and results.' },
      { name: 'user' },
    ]);
  });

  it('does not emit a registered tag that no operation actually uses', () => {
    const routes = [{ method: 'get', path: '/api/v1/a', srcFile: 'lab/labRoutes.js' }];
    const doc = buildOpenApiDocument(routes, baseWith('lab', 'unused'), {});
    expect(doc.tags).toEqual([{ name: 'lab' }]);
  });

  it('keeps generator-side curation inputs out of the emitted document', () => {
    const doc = buildOpenApiDocument(
      [{ method: 'get', path: '/api/v1/a', srcFile: 'lab/labRoutes.js' }],
      { ...baseWith('lab'), unclassifiedTagBudget: 0 },
      {},
    );
    expect(doc.tagRegistry).toBeUndefined();
    expect(doc.unclassifiedTagBudget).toBeUndefined();
  });

  it('picks the code-unit-smallest source module when equivalent paths collapse', () => {
    // Both register the same URL template under different param names; the
    // collapse must choose deterministically, not by input order.
    const base = baseWith('alpha', 'zeta');
    const forward = buildOpenApiDocument([
      { method: 'get', path: '/d/{id}', srcFile: 'zeta/zetaRoutes.js' },
      { method: 'get', path: '/d/{deptId}', srcFile: 'alpha/alphaRoutes.js' },
    ], base, {});
    const reversed = buildOpenApiDocument([
      { method: 'get', path: '/d/{deptId}', srcFile: 'alpha/alphaRoutes.js' },
      { method: 'get', path: '/d/{id}', srcFile: 'zeta/zetaRoutes.js' },
    ], base, {});
    expect(forward.paths['/d/{deptId}'].get.tags).toEqual(['alpha']);
    expect(reversed).toEqual(forward);
  });

  it('attributes each method independently when one path spans two modules', () => {
    const doc = buildOpenApiDocument([
      { method: 'get', path: '/api/v1/x', srcFile: 'reader/readRoutes.js' },
      { method: 'post', path: '/api/v1/x', srcFile: 'writer/writeRoutes.js' },
    ], baseWith('reader', 'writer'), {});
    expect(doc.paths['/api/v1/x'].get.tags).toEqual(['reader']);
    expect(doc.paths['/api/v1/x'].post.tags).toEqual(['writer']);
  });

  it('lets a declared router domain win over the filename bootstrap', () => {
    const doc = buildOpenApiDocument([
      { method: 'get', path: '/api/v1/x', srcFile: 'legacy/oldRoutes.js', domain: 'appointments' },
    ], baseWith('appointments', 'legacy'), {});
    expect(doc.paths['/api/v1/x'].get.tags).toEqual(['appointments']);
  });
});
