# CLAUDE.md — VHHealth Admin Portal

## Project Overview
Next.js 15 admin dashboard for the VHHealth hospital management system. Used by hospital administrators and super-admins to manage patients, staff, appointments, departments, pharmacy, investigations, and system settings.

## Tech Stack
- **Framework**: Next.js 15 (App Router), React 19, TypeScript
- **State/Data**: TanStack Query v5 + React Context
- **Styling**: Tailwind CSS v4
- **Auth**: JWT stored in localStorage + synced to cookie for SSR middleware
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
      logs/                  # Audit + system logs
      system-logs/           # (legacy, same as logs)
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
  middleware.ts              # SSR auth guard (checks adminToken cookie)
  components/                # Shared UI components
```

## Key Architecture Decisions
- **fetchAdminAPI** auto-prepends `/api/v1` to short paths. Used by most dashboard pages.
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
npm run build  # Production build
npm start      # Production (systemd: vhhealth-admin.service)
```
Public URL: `https://admin.vhhealth.app`

## Environment
`.env.local`:
- `NEXT_PUBLIC_API_URL` — backend URL (default: `https://api.vhhealth.app`)
- `BACKEND_API_KEY` (or legacy `API_KEY`) — **server-only** API key; injected by `/api/proxy` and `/api/login`. Never expose as `NEXT_PUBLIC_*`.
- `NEXT_PUBLIC_ALLOWED_ORIGIN` — CSRF origin allowlist for `/api/login`, `/api/refresh`, `/api/logout`, `/api/proxy` mutations.
- `ADMIN_IP_ALLOWLIST` (optional) — comma-separated list of exact client IPs allowed through `middleware.ts`. Unset → disabled.
- `NEXT_PUBLIC_SENTRY_DSN` — activate Sentry in production. Instrumentation files already wired.
- `JWT_SECRET` — used by `middleware.ts` `jose.jwtVerify` for signature validation. Fails closed in production when unset.

## Related Repos
- **Backend** (Node.js): `../vhhealth-backend` — github.com/Bahuleyandr/vh-health-backend
- **Patient App** (Flutter): `../vhhealth-patient` — github.com/Bahuleyandr/VH-health
- **Staff App** (Flutter): `../vhhealth-staff` — github.com/Bahuleyandr/vhhealth-staff
- **Core Package** (Dart): `../vhhealth-core` — github.com/Bahuleyandr/vhhealth-core

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

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the current A+/S-tier roadmap.
It tracks Phase 1 (security floor), Phase 2 (polish), and Phase 3 (marquee features).
When starting a new Claude session, run `cat docs/ROADMAP.md` and pick any unchecked item.
