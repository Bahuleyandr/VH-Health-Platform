# VH Health Admin Portal

Next.js admin portal for hospital operations, user management, appointments,
uploads, investigations, payroll, audit, and Clinical AI governance.

## Local Commands

```bash
npm ci
npm run dev
npm run lint
npm run type-check
npm test
npm run build
npm run check:clinical-ai-bundle
```

The dev server runs on `http://localhost:3001`.

## Environment

Typical local/CI values:

```bash
NEXT_PUBLIC_API_URL=http://localhost:5000
NEXT_PUBLIC_WS_URL=ws://localhost:5000
# Server-only backend key — injected by /api/proxy + /api/login. NEVER use a
# NEXT_PUBLIC_ prefix (Next.js inlines those into the client bundle).
BACKEND_API_KEY=test-api-key
NEXT_PUBLIC_APP_ORIGIN=http://localhost:3001
NEXT_PUBLIC_APP_NAME="VHHealth Admin"
```

Do not commit real secrets. Production API keys, JWT/session secrets, and Sentry
DSNs belong in the deployment secret store or GitHub Actions secrets.

## Test Surface

- `npm run lint` uses direct ESLint, not deprecated `next lint`.
- `npm run type-check` runs `tsc --noEmit`.
- `npm test` runs Jest.
- `npm run build` runs the production Next build.
- `npm run check:clinical-ai-bundle` guards the heavy Clinical AI route against
  static panel imports and enforces a route JS budget when `.next` build
  artifacts include the route.
- `npm run test:e2e` runs Playwright local smoke journeys. Authenticated
  journeys currently depend on seeded local backend/admin fixture data.

## Clinical AI Bundle Guard

The Clinical AI dashboard intentionally loads module panels through
`next/dynamic` plus viewport-triggered rendering. The guard in
`scripts/check-clinical-ai-bundle.mjs` fails if the page starts statically
importing heavy module panels again.

Override the default route budget when needed:

```bash
ADMIN_CLINICAL_AI_ROUTE_JS_BUDGET_KB=220 npm run check:clinical-ai-bundle
```

## Documentation

| Topic | Document |
| --- | --- |
| Admin conventions | [`CLAUDE.md`](CLAUDE.md) |
| Historical code audit | [`CODE_AUDIT.md`](CODE_AUDIT.md) |
| Release gate | [`../../docs/RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md) |
| Smoke journeys | [`../../docs/SMOKE_E2E_JOURNEYS.md`](../../docs/SMOKE_E2E_JOURNEYS.md) |
| Platform remediation | [`../../docs/PLATFORM_REMEDIATION_PLAN.md`](../../docs/PLATFORM_REMEDIATION_PLAN.md) |

The old admin roadmap and scratch refactor-plan documents were removed because
the major god-page splits they described have landed. New admin work should be
tracked in a focused issue/branch plan or the root remediation tracker.
