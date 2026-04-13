# Admin Portal Roadmap — A+/S-Tier

> Source of truth for next-step work. Next.js app for hospital administration.

**Current grade:** C+. Modern stack (App Router, TanStack Query) with good patterns in places, but critical gaps: bed management is a localStorage mock with "Backend API coming soon" comment; 975+ line client components; 4 tests total; no MFA; 7-day JWT in `localStorage` (XSS risk).

---

## Phase 1 — A+ Security Floor ✅

- [x] **Replace bed-management localStorage mock.** Wired to backend `/beds` CRUD via TanStack Query.
- [x] **MFA (TOTP) on login.** Challenge step + enrollment + recovery codes UI shipped.
- [x] **Shorten JWT TTL to 4h + refresh token.** `/api/refresh` route rotates the httpOnly cookie server-side; `core.ts` 401 handler does single-flight refresh + retry, redirecting to login only on failure.
- [x] **Move token storage out of `localStorage`.** Already on httpOnly `auth_token` cookie; legacy `localStorage.getItem("adminToken")` purged across 12 files. Also fixed a latent bug in `ProtectedRoute` that gated auth on a key nothing writes.
- [x] **Split god-components (Phase 1 scope).** `PermissionsMatrix.tsx` 413→112L orchestrator + 4 sub-files. `system-audit/page.tsx` 1041→67L orchestrator + 5 sub-files. `DashboardClient.tsx` 973→746L (types/skeleton/helpers extracted; deeper per-section split still open — see Phase 2).

## Phase 2 — A+ Polish

- [ ] **Test coverage ≥60%.** Currently 4 unit tests + 1 new auth-flow suite (`src/__tests__/lib/auth-flow.test.ts`). Add: MFA challenge flow, role change audit, bed CRUD, pharmacy stock adjustment.
- [ ] **Data-table features.** Pagination + sort + filter exist; **CSV export utility shipped** (`src/lib/exportToCsv.ts`). Still open: bulk-edit, keyboard shortcuts.
- [x] **IP allowlist middleware.** `src/middleware.ts` gates `/dashboard/*` and `/api/proxy/*` behind `ADMIN_IP_ALLOWLIST` env var. Opt-in — unset means no allowlist.
- [x] **Error boundaries + empty states.** `PageErrorBoundary` now reports to Sentry + hides raw errors from users. New `LoadingSpinner` + `EmptyState` shared components. `(with-auth)/layout.tsx` wraps all authenticated pages.
- [x] **Sentry integration.** Already wired — `@sentry/nextjs` v10, 3 instrumentation files, `withSentryConfig`, CSP entry, error boundary hook. Set `NEXT_PUBLIC_SENTRY_DSN` in prod to activate.
- [ ] **Deeper `DashboardClient.tsx` split.** 746L today; extract StatsGrid, NotificationsDrawer, CommandPalette, ActivityFeed as stateless children with explicit prop surfaces. Needs judgment on prop design.

## Phase 3 — S-Tier Marquee

### 3A (admin slice). Real-time KPI dashboard
SSE subscriber to backend real-time fabric. Live tiles: bed occupancy %, ED wait time, avg TAT, staff utilisation, pharmacy stock-out rate. Recharts for trend lines; WebSocket for tile updates. Replace polling dashboard.

### 3F. Integrated revenue cycle
Admin views for: insurance claim submission queue (837 EDI), denial reason dashboard, AR aging, patient payment portal admin (view installments, waive fees with audit). Depends on backend revenue-cycle implementation.

### 3Γ. Compliance & accreditation dashboards
NABH / JCI indicator tracking: hand-hygiene compliance, medication error rate, HAI rate, surgical-site infection rate, patient-identification error rate. Pulls from existing `clinical_alerts` + audit tables. Export PDF for auditor visits.

### 3Δ. Pharmacy inventory + expiry management
Stock on hand, reorder points, expiry alerts (30/60/90 day), supplier integration for auto-reorder, batch tracking for recalls. Currently pharmacy is order-routing only — no stock view.

### 3Ε. Executive KPI dashboard (C-suite view)
Role-gated view with high-level metrics: revenue (month/quarter), occupancy trend, patient satisfaction (from feedback module), doctor utilisation. PDF export for board meetings.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md`.
- Conventions: [CLAUDE.md](../CLAUDE.md) (if present).
