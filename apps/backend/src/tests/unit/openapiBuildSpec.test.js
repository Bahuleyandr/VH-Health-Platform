import {
  expressPathToOpenApi, joinPath, pathParamNames, operationId,
  composeRoutes, buildOpenApiDocument,
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
});
