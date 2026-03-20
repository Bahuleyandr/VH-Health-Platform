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
- **Auth token**: Stored in `localStorage["adminToken"]` AND synced to `adminToken` cookie (for SSR middleware).
- **AuthContext** handles login (stores token + cookie), logout (clears both), and checkAuth (rehydrates on mount).
- **Middleware** checks cookie on `/dashboard/*` routes — redirects to `/login` if missing.

## Auth Flow
1. User submits username + password
2. `adminLogin()` → `POST /api/v1/auth/admin/login` → receives JWT + admin object
3. JWT stored in localStorage + cookie (7-day, SameSite=Lax)
4. All API calls include `Authorization: Bearer <token>` via `getHeaders(token)`
5. Logout clears localStorage + cookie + calls backend logout endpoint

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
- `NEXT_PUBLIC_API_KEY` — API key (default: `vhhealth123`)

## Related Repos
- **Backend** (Node.js): `../vhhealth-backend` — github.com/Bahuleyandr/vh-health-backend
- **Patient App** (Flutter): `../vhhealth-patient` — github.com/Bahuleyandr/VH-health
- **Staff App** (Flutter): `../vhhealth-staff` — github.com/Bahuleyandr/vhhealth-staff
- **Core Package** (Dart): `../vhhealth-core` — github.com/Bahuleyandr/vhhealth-core

## Conventions
- Use `fetchAdminAPI` for dashboard pages (auto-prepends /api/v1)
- Use `getJSON`/`postJSON` with full paths for auth-related calls
- Auth functions (getAuthToken, clearAuthData) live in `api-client.ts` only
- All new pages go under `src/app/(with-auth)/dashboard/`
- Use TanStack Query for data fetching (not raw useEffect + useState)
- Backend response envelope: `{ success, message, data }` — `requestJSON` auto-unwraps `.data`
