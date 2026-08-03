// src/config/openapiDomain.js
//
// Declares the OpenAPI DOMAIN a router belongs to — the canonical slug used as
// that router's operations' primary `tags` entry in the generated spec.
//
// Why declare it instead of letting the generator infer it:
//   The generator can bootstrap a tag from the route module's filename, but
//   that couples the PUBLISHED API contract to file layout — renaming or moving
//   a route file would silently change the documented taxonomy. Declaring the
//   slug here pins it in code, so it survives moves, renames and re-mounts.
//
// It also disambiguates re-mounted routers. `clinicalAiAdminRoutes` is mounted
// at BOTH /api/v1/admin/clinical-ai and /api/v1/clinical-ai/control, and
// several distinct routers share the /api/v1/emr prefix — so URL ancestry
// cannot name the domain, but the router itself can.
//
// Usage, at the bottom of a route module next to the export:
//     import { markRouterDomain } from '../../config/openapiDomain.js';
//     markRouterDomain(router, 'appointments');
//     export default router;
//
// The slug MUST already exist in OPENAPI_TAG_REGISTRY
// (apps/backend/scripts/openapi/base.mjs) — generation fails on an unregistered
// slug, which is what stops `clinical-ai` / `clinicalAi` / `clinical_ai` from
// becoming three different groups.
//
// Precedence when the spec is generated (most specific first):
//   1. a per-operation overlay `ov.tags` / `ov.tag`
//   2. THIS declaration (nearest, most specific tagged router wins)
//   3. the route module filename (bootstrap only)
//   4. the URL path, audience segments skipped
//   5. `unclassified`

/** Canonical slug shape: lowercase ASCII kebab-case. Matches the code-unit sort
 * the spec generator uses everywhere, so declared slugs order predictably. */
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Tag `router` with the OpenAPI domain slug its operations belong to.
 * Returns the router so it can be used inline.
 */
export function markRouterDomain(router, slug) {
  if (!router || (typeof router !== 'function' && typeof router !== 'object')) {
    throw new TypeError('markRouterDomain: expected an Express router');
  }
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new TypeError(
      `markRouterDomain: slug must be lowercase kebab-case, got ${JSON.stringify(slug)}`,
    );
  }
  Object.defineProperty(router, '__openapiDomain', {
    value: slug,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return router;
}

/** Read a router's declared domain, or null. */
export function getRouterDomain(router) {
  const slug = router && router.__openapiDomain;
  return typeof slug === 'string' && slug ? slug : null;
}
