import {
  expressPathToOpenApi, joinPath, pathParamNames, operationId,
  composeRoutes, buildOpenApiDocument, pathSignature, findEquivalentPathCollisions,
  kebabCase, tagFromSourceFile, tagFromPath, resolveTags,
} from '../../../scripts/openapi/buildSpec.mjs';

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
      { method: 'get', path: '/', srcFile: null },
      { method: 'get', path: '/api/v1/users', srcFile: null },
      { method: 'post', path: '/api/v1/users', srcFile: null },
      { method: 'get', path: '/api/v1/users/{id}', srcFile: null },
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
      { method: 'get', path: '/api/v1/users/{id}', srcFile: 'user/userRoutes.js' },
      { method: 'put', path: '/api/v1/users/{id}', srcFile: 'user/userRoutes.js' },
    ]);
  });

  test('buildOpenApiDocument produces sorted paths, unique operationIds, path params', () => {
    const routes = [
      { method: 'get', path: '/users/{id}' },
      { method: 'get', path: '/a-b' },
      { method: 'get', path: '/a_b' },
    ];
    const doc = buildOpenApiDocument(routes, { openapi: '3.0.3', paths: { IGNORED: true } });
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
    const doc = buildOpenApiDocument(routes, { paths: {} });
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
  const base = { openapi: '3.0.3', components: { schemas: {} } };

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

  test('tagFromSourceFile falls back to the directory for barrel files', () => {
    // admin/index.js registers 46 operations directly; `index` names nothing.
    expect(tagFromSourceFile('admin/index.js')).toBe('admin');
    expect(tagFromSourceFile('portal/index.js')).toBe('portal');
    // A non-audience directory already wins, so its barrel is unaffected.
    expect(tagFromSourceFile('emr/index.js')).toBe('emr');
    // Nothing to fall back to -> let the path derivation take over.
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

  test('tagFromPath keeps an audience segment that is the whole resource', () => {
    // '/api/v1/admin' has nothing after it to descend to — do not strip to nothing.
    expect(tagFromPath('/api/v1/admin')).toBe('admin');
  });

  test('tagFromPath returns null when no usable segment remains', () => {
    expect(tagFromPath('/')).toBeNull();
    expect(tagFromPath('/api/v1/{id}')).toBeNull();
  });

  test('resolveTags prefers an explicit overlay tag over every derivation', () => {
    expect(resolveTags({
      ov: { tags: ['money'] },
      srcFile: 'billing/invoiceRoutes.js',
      path: '/api/v1/billing',
    })).toEqual(['money']);
  });

  test('resolveTags prefers the source module over the URL path', () => {
    expect(resolveTags({
      ov: undefined,
      srcFile: 'admin/tenantRoutes.js',
      path: '/api/v1/admin/tenants',
    })).toEqual(['tenant']);
  });

  test('resolveTags falls back to the path, then to a final default', () => {
    expect(resolveTags({ srcFile: null, path: '/api/v1/reports' })).toEqual(['reports']);
    expect(resolveTags({ srcFile: null, path: '/' })).toEqual(['api']);
  });
});

describe('buildOpenApiDocument tags', () => {
  const base = { openapi: '3.0.3', components: { schemas: {} } };

  it('tags every operation and emits a matching top-level tags array', () => {
    const routes = [
      { method: 'get', path: '/api/v1/users', srcFile: 'user/userRoutes.js' },
      { method: 'get', path: '/api/v1/appointments', srcFile: 'appointment/appointmentRoutes.js' },
    ];
    const doc = buildOpenApiDocument(routes, base, {});
    expect(doc.paths['/api/v1/users'].get.tags).toEqual(['user']);
    expect(doc.paths['/api/v1/appointments'].get.tags).toEqual(['appointment']);
    expect(doc.tags).toEqual([{ name: 'appointment' }, { name: 'user' }]);
  });

  it('emits every used tag at the top level — Spectral operation-tag-defined invariant', () => {
    const routes = [
      { method: 'get', path: '/api/v1/a', srcFile: 'zeta/zetaRoutes.js' },
      { method: 'get', path: '/api/v1/b', srcFile: 'alpha/alphaRoutes.js' },
      { method: 'post', path: '/api/v1/c' }, // no srcFile -> path fallback
    ];
    const doc = buildOpenApiDocument(routes, base, { 'POST /api/v1/c': { tags: ['custom'] } });
    const used = new Set(
      Object.values(doc.paths).flatMap((p) => Object.values(p).flatMap((op) => op.tags)),
    );
    const declared = new Set(doc.tags.map((t) => t.name));
    for (const t of used) expect(declared).toContain(t);
    expect(used.size).toBe(declared.size);
  });

  it('sorts top-level tags by code unit, not locale', () => {
    const routes = [
      { method: 'get', path: '/api/v1/a', srcFile: 'care-pathway/xRoutes.js' },
      { method: 'get', path: '/api/v1/b', srcFile: 'care_team/yRoutes.js' },
      { method: 'get', path: '/api/v1/c', srcFile: 'careplan/zRoutes.js' },
    ];
    const doc = buildOpenApiDocument(routes, base, {});
    const names = doc.tags.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // '-' (0x2D) sorts before letters under code-unit compare; localeCompare
    // commonly ignores it entirely and would order these differently.
    expect(names).toEqual(['care-pathway', 'care-team', 'careplan']);
  });

  it('carries a curated description from the base doc onto the emitted tag', () => {
    const routes = [
      { method: 'get', path: '/api/v1/a', srcFile: 'lab/labRoutes.js' },
      { method: 'get', path: '/api/v1/b', srcFile: 'user/userRoutes.js' },
    ];
    const withDesc = { ...base, tags: [{ name: 'lab', description: 'Lab orders and results.' }] };
    const doc = buildOpenApiDocument(routes, withDesc, {});
    expect(doc.tags).toEqual([
      { name: 'lab', description: 'Lab orders and results.' },
      { name: 'user' },
    ]);
  });

  it('does not emit a curated tag that no operation actually uses', () => {
    const routes = [{ method: 'get', path: '/api/v1/a', srcFile: 'lab/labRoutes.js' }];
    const withDesc = { ...base, tags: [{ name: 'unused', description: 'Nothing uses this.' }] };
    const doc = buildOpenApiDocument(routes, withDesc, {});
    expect(doc.tags).toEqual([{ name: 'lab' }]);
  });

  it('picks the code-unit-smallest source module when equivalent paths collapse', () => {
    // Both register the same URL template under different param names; the
    // collapse must choose deterministically, not by input order.
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
    ], base, {});
    expect(doc.paths['/api/v1/x'].get.tags).toEqual(['reader']);
    expect(doc.paths['/api/v1/x'].post.tags).toEqual(['writer']);
  });
});
