# CLAUDE.md — VHHealth Admin Portal

## Project Overview

Next.js 16 admin dashboard for the VHHealth hospital management system. Used by hospital administrators and super-admins to manage patients, staff, appointments, departments, pharmacy, investigations, and system settings.

## Deployment

Production runs on the hospital's on-prem **3-node RKE2 Kubernetes cluster**
alongside the backend. GitHub Actions builds the admin container image;
ArgoCD reconciles manifests under `infra/kubernetes/apps/admin/`. Traffic
flows Cloudflare Tunnel → ingress-nginx → `Service/vhhealth-admin`.

Full runbook: [`../../docs/DEPLOYMENT_GUIDE.md`](../../docs/DEPLOYMENT_GUIDE.md).
Hardware spec: [`../../docs/HARDWARE_REQUIREMENTS.md`](../../docs/HARDWARE_REQUIREMENTS.md).

## Tech Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript
- **State/Data**: TanStack Query v5 + React Context
- **Styling**: Tailwind CSS v4
- **Auth**: JWT stored in an httpOnly cookie (`auth_token`); localStorage caches only non-sensitive profile/theme data
- **API Client**: Custom 3-layer abstraction (apiFetch → requestJSON → domain functions)

## Repository Layout

```
src/
  app/
    (public)/login/          # Login page (username + password)
    (with-auth)/dashboard/   # All authenticated pages
      page.tsx               # Main dashboard
      appointments/          # Appointment management
      doctors/               # Doctor CRUD + edit
      departments/           # Department management
      users/                 # Patient management
      admin-management/      # Admin user management
      pharmacy/              # Pharmacy orders
      notifications/         # Notification management
      reporting/             # Analytics + report generation
      uploads/               # File management + HIPAA
      sos/                   # Emergency alert management
      settings/              # System settings
      system-logs/           # System error/audit log viewer
    layout.tsx               # Root layout (imports globals.css + Providers)
    providers.tsx             # QueryClient + AuthProvider + Toaster
  lib/
    api-fetch.ts             # Low-level fetch with auto headers (Origin, x-api-key, Bearer)
    api.ts                   # requestJSON, getJSON, postJSON, putJSON + fetchAdminAPI
    api-client.ts            # Auth lifecycle (login, logout, getAuthToken, clearAuthData)
    api-config.ts            # API_BASE_URL, API_KEY, endpoint constants
    types.ts                 # TypeScript interfaces
  contexts/
    AuthContext.tsx           # Auth state, login/logout, cookie sync
  middleware.ts              # SSR auth guard (checks auth_token cookie)
  components/                # Shared UI components
```

## Key Architecture Decisions

- **fetchAdminAPI** auto-prepends `/api/v1` to short paths and passes them through VERBATIM — the legacy endpoint-rewrite shim was deleted 2026-08-23, so a wrong path 404s loudly instead of being silently rewritten. Used by most dashboard pages.
- **getJSON/postJSON/putJSON** use full paths (e.g., `/api/v1/auth/admin/login`). Used by auth and admin management.
- **Auth token**: Stored in an **httpOnly, Secure, SameSite=Strict** `auth_token` cookie (4h max-age). The browser never sees the token. `localStorage` only holds the non-sensitive `adminUser` profile cache (4h TTL).
- **AuthContext** handles login (cookie set by `/api/login`), logout (cookie cleared by `/api/logout`), and checkAuth (rehydrates profile from cache + `/api/v1/auth/admin/profile`).
- **Middleware** verifies the cookie's JWT signature via `jose.jwtVerify` on `/dashboard/*` and `/api/proxy/*` routes. Fails closed in production when `JWT_SECRET` is unset.

## Auth Flow

1. User submits username + password (optionally followed by a TOTP MFA challenge)
2. `adminLogin()` → `POST /api/login` (Next.js route) → proxies to backend → backend returns JWT
3. `/api/login` sets `auth_token` as an httpOnly cookie (4h, `Secure` in prod, `SameSite=Strict`). The browser never touches the token.
4. All API calls go through `/api/proxy/*` (same-origin, cookie carried). The proxy injects `Authorization: Bearer <token>` + `x-api-key` server-side from `process.env.BACKEND_API_KEY`.
5. On 401, `core.ts` `requestJSON` does a single-flight rotation via `/api/refresh` (server reads cookie, calls backend `/auth/refresh-token`, sets rotated cookie) then retries the original request once. Concurrent 401s share one refresh via a module-level promise. On refresh failure: `adminUser` cache cleared + redirect to `/login`.
6. Logout clears `adminUser` cache + calls `/api/logout` (cookie expired) + backend logout endpoint.

## API Client Layers

```
apiFetch (api-fetch.ts)     — raw fetch, adds headers
  ↓
requestJSON (api.ts)        — JSON parse, 401 redirect, error handling
  ↓
getJSON/postJSON (api.ts)   — convenience wrappers
fetchAdminAPI (api.ts)      — back-compat, auto-adds /api/v1 prefix
```

## Running

```bash
npm run dev    # Development (port 3001)
npm run build  # Production build (also runs inside the container image build)
```

Production is Kubernetes-managed — do not run `npm start` on a host. The
published image (`ghcr.io/.../admin:<tag>`) is referenced by the manifest in
`infra/kubernetes/apps/admin/`; ArgoCD rolls out on image update. See
[`../../docs/DEPLOYMENT_GUIDE.md`](../../docs/DEPLOYMENT_GUIDE.md).

Public URL: `https://admin.vhhealth.app` — via Cloudflare Tunnel →
ingress-nginx → `Service/vhhealth-admin`.

## Environment

`.env.local`:

- `NEXT_PUBLIC_API_URL` — backend URL (default: `https://api.vhhealth.app`)
- `BACKEND_API_KEY` (or legacy `API_KEY`) — **server-only** API key; injected by `/api/proxy` and `/api/login`. Never expose as `NEXT_PUBLIC_*`.
- `NEXT_PUBLIC_ALLOWED_ORIGIN` — CSRF origin allowlist for `/api/login`, `/api/refresh`, `/api/logout`, `/api/proxy` mutations.
- `ADMIN_IP_ALLOWLIST` — comma-separated exact client IPs or IPv4 CIDR ranges allowed through `middleware.ts`. Optional in development; required in production, where an empty/missing value fails closed.
- `NEXT_PUBLIC_SENTRY_DSN` — activate Sentry in production. Instrumentation files already wired.
- `JWT_SECRET` — used by `middleware.ts` `jose.jwtVerify` for signature validation. Fails closed in production when unset.

## Sibling apps (same monorepo)

See the [root `CLAUDE.md`](../../CLAUDE.md) for the cross-stack layout. Other apps in the same repo:

- `apps/backend` — Node/Express API
- `apps/patient` — Flutter patient app
- `apps/staff` — Flutter staff app
- `packages/vhhealth_core` — shared Dart package

The five separate source repos these were merged from are archived on GitHub as of 2026-04-18.

## God-page refactor pattern (added 2026-04-15)

Pages that grow past ~500 LOC get split into a `components/` subfolder with
one file per logical seam. The page itself becomes a thin tab orchestrator
(<80 LOC). Established pattern, already applied to:

- `dashboard/housekeeping/page.tsx` (1268→65 LOC, 7 components)
- `dashboard/pharmacy/page.tsx` (889→58 LOC, 7 components)
- `dashboard/investigations/page.tsx` (961→56 LOC, 6 components)
- `dashboard/billing/page.tsx` (976→50 LOC, 4 components)

Rules:

- Each tab is its own `"use client"` file under `components/`.
- Shared UI primitives (StatCard, StatusBadge, formatters) live in
  `components/shared.tsx` or `components/helpers.tsx`.
- Shared TypeScript interfaces in `components/types.ts`.
- Modals co-located in their owning tab if used in one place, separate
  file if shared (e.g. `OrderDetailModal.tsx`, `DetailPanel.tsx`).
- Page.tsx: imports + tab state + tab-switcher + tab routing only.

The old one-off refactoring plan/sketch docs were removed after the largest
splits landed. Keep this pattern here as the durable rule for future admin
pages instead of creating long-lived scratch roadmaps.

## Testing

- **Unit/component**: Jest. `npm test` — **141 suites / 1764 tests passing**
  (measured 2026-08-27 on Node 26.5.0 — the pinned runtime for every JS stack
  in this repo; confirm `node --version` before treating a red run as signal,
  because the backend corpus is known to fabricate failures on older Node and
  nothing pins this one to a different interpreter). `testMatch` is
  `src/__tests__/**/*.test.ts{,x}`, so the suite count is exactly the file
  count. Re-derive both before editing this line — do not adjust the prose:

  ```bash
  find src/__tests__ -name '*.test.ts' -o -name '*.test.tsx' | wc -l   # 141 suites
  npx jest --silent --ci                                               # authoritative test total
  ```

- **E2E**: Playwright. `@playwright/test` is a pinned devDependency
  (added batch 41); `npx playwright install chromium` once per clone.
  `npm run test:e2e` runs against an existing `npm run dev` on :3001.
  Two projects:
  - `setup` — runs `e2e/auth.setup.ts` once, logs in as the seeded
    `playwright-admin` test user (ADMIN role, no MFA), writes
    `playwright/.auth/admin.json` storage state. DB seed SQL in the
    file header.
  - `chromium` — depends on setup and reuses that storage state for every
    spec except `e2e/smoke.spec.ts`, which opts out via
    `test.use({ storageState: { cookies: [], origins: [] } })` so its
    redirect assertions fire. `testIgnore` keeps `auth.setup.ts` out.

  There are **8 spec files** plus the one setup file (`ls e2e/*.spec.ts | wc -l`
  — re-derive, do not trust this list if it disagrees):

  | Spec                                  | Covers                                              | `test()` blocks                  |
  | ------------------------------------- | --------------------------------------------------- | -------------------------------- |
  | `smoke.spec.ts`                       | unauthenticated redirect + login surface            | 5                                |
  | `authenticated.spec.ts`               | logged-in dashboard journeys                        | 7                                |
  | `route-crawl.spec.ts`                 | every dashboard route, discovered from the app tree | 1 (loops over discovered routes) |
  | `table-controls.spec.ts`              | shared table search/filter/paginate controls        | 2 (each loops over a route list) |
  | `sprint-pages.spec.ts`                | sprint 1–10 page reachability                       | 10                               |
  | `sprint-data.spec.ts`                 | sprint 1–10 data rendering                          | 10                               |
  | `discharge-compose.spec.ts`           | discharge summary composer                          | 3                                |
  | `continuity-facility-context.spec.ts` | continuity console facility scoping                 | 2                                |

  The `test()`-block column is a static count of literal blocks; the two
  data-driven specs expand to more cases at run time, so it is a floor, not a
  test total. `npm run smoke:routes` drives `route-crawl` + `authenticated`;
  `npm run smoke:tables` drives `table-controls`.

## Generated API types

`src/lib/openapi.generated.ts` is generated from the backend canonical spec
(`../backend/src/docs/openapi.json`) by `npm run generate:types` and is
**gitignored**. `npm run dev|build|test|type-check` regenerate it first (via the
`pre*` hooks). If you run `npx tsc` or your editor directly on a fresh checkout,
run `npm run generate:types` once. Consumers import spec-derived types via
`src/lib/openapi-data.ts` — `ApiData<'<path>', '<method>'>` (the unwrapped
`.data` payload, matching `getJSON<T>`) and `ApiBody<'<path>', '<method>'>` (the
request body). Don't hand-author response interfaces that the spec already types.

## Conventions

- Use `fetchAdminAPI` for dashboard pages (auto-prepends /api/v1)
- Use `getJSON`/`postJSON` with full paths for auth-related calls
- **Never** read/write `localStorage.getItem("adminToken")` — the token is httpOnly. The proxy handles auth server-side; client code passes nothing.
- Use shared `LoadingSpinner` + `EmptyState` from `@/components/` instead of ad-hoc loading/empty UI.
- Wrap new feature groups in `PageErrorBoundary` (already applied at `(with-auth)/layout.tsx`) — errors get reported to Sentry + show a recoverable fallback, never the raw message to the user.
- Use `exportToCsv({ filename, columns, rows })` from `@/lib/exportToCsv` for any "download CSV" action — handles escaping, CRLF, UTF-8 BOM.
- All new pages go under `src/app/(with-auth)/dashboard/`
- Use TanStack Query for data fetching (not raw useEffect + useState)
- Backend response envelope: `{ success, message, data }` — `requestJSON` auto-unwraps `.data`

## Future Directions

Use the root [`../../docs/ROADMAP.md`](../../docs/ROADMAP.md)
and [`../../docs/RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md) for
current platform priorities. For admin-specific work, create a focused
branch/issue plan and keep durable conventions in this file.
