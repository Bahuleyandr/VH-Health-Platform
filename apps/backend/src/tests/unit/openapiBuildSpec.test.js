import {
  expressPathToOpenApi, joinPath, pathParamNames, operationId,
  composeRoutes, buildOpenApiDocument, pathSignature, findEquivalentPathCollisions,
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
      { method: 'get', path: '/' },
      { method: 'get', path: '/api/v1/users' },
      { method: 'post', path: '/api/v1/users' },
      { method: 'get', path: '/api/v1/users/{id}' },
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
