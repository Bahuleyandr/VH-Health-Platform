// apps/backend/scripts/openapi/schemas/downtimeStaticMirror.mjs
// Deprecated DB-free legacy ward-pack mirror (src/routes/downtime/staticDowntimeRoutes.js,
// WS2 / REL-5 — B2.5), mounted at /downtime/static — OUTSIDE /api/v1 and outside the regular
// JWT-gated downtime surface on purpose: every handler reads only the filesystem mirror
// wardDowntimePackService writes on each generation pass, so packs stay reachable with the
// DB down. Superseded by the JWT-gated /api/v1/downtime/* surface when the DB is up.

export const operations = {
  'GET /downtime/static': {
    summary: 'Deprecated DB-free downtime mirror index',
    description:
      'Read-only, DB-free legacy mirror index listing the ward packs currently available ' +
      'offline, served straight from a pre-rendered filesystem mirror with no Prisma access so ' +
      'it stays reachable during a database outage. Requires a dedicated x-downtime-token ' +
      'credential (a shared monitoring-token value is accepted on the same header but is never ' +
      'authorized) and fails closed with 401 when no valid dedicated token is presented. On a ' +
      'missing or unreadable mirror it returns 200 with an instructional paper-procedure page ' +
      'rather than a 404/500.',
  },
  'GET /downtime/static/wards/{wardId}': {
    summary: 'Deprecated DB-free downtime pack for one ward',
    description:
      'Read-only, DB-free legacy fetch of one ward\'s pre-rendered downtime pack HTML straight ' +
      'off disk, with the same dedicated x-downtime-token gate and fail-open-200 behavior as ' +
      'the mirror index. `wardId` is validated against a strict numeric-or-UUID pattern before ' +
      'touching the filesystem, and the resolved file path is confirmed to stay inside the ' +
      'mirror directory (path-traversal defence) before it is read.',
    pathParameters: {
      wardId: { type: 'string', minLength: 1, maxLength: 36 },
    },
  },
};
