# Admin Portal Roadmap — A+/S-Tier

> Source of truth for next-step work. Next.js app for hospital administration.

**Current grade:** C+. Modern stack (App Router, TanStack Query) with good patterns in places, but critical gaps: bed management is a localStorage mock with "Backend API coming soon" comment; 975+ line client components; 4 tests total; no MFA; 7-day JWT in `localStorage` (XSS risk).

---

## Phase 1 — A+ Security Floor (in progress)

- [x] **Replace bed-management localStorage mock.** The bed page stores state in `localStorage` with a TODO comment. Wire to backend `/beds` CRUD routes via TanStack Query. If backend routes are incomplete, land them in `vh-health-backend` first.
- [x] **MFA (TOTP) on login.** Backend endpoints land in `vh-health-backend`. Admin portal needs: MFA challenge step in login flow, settings page for enrollment (show QR code), recovery-code display UI.
- [ ] **Shorten JWT TTL to 4h + refresh token.** Backend drops TTL in `securityConfig.js`; portal must implement refresh flow.
- [ ] **Move token storage out of `localStorage`.** XSS risk. Either: (a) `httpOnly` cookie via Next.js API route proxy for backend calls (preferred), or (b) at minimum add strict CSP header via `middleware.ts`.
- [ ] **Split god-components.** `DashboardClient.tsx` (975L), `system-audit/page.tsx` (1041L), `PermissionsMatrix.tsx` (416L). Extract per-tab or per-section subcomponents. Target max 300L.

## Phase 2 — A+ Polish

- [ ] **Test coverage ≥60%.** Currently 4 unit tests. Add: login + MFA, role change audit, bed CRUD, pharmacy stock adjustment.
- [ ] **Data-table features.** Pagination + sort + filter exist; add bulk-edit, export-to-CSV, keyboard shortcuts for power users.
- [ ] **IP allowlist middleware.** Admin portal is already production-reachable; restrict to office VPN ranges via Next.js `middleware.ts` or reverse proxy.
- [ ] **Error boundaries + empty states.** Consistent loading / empty / error UI across pages.
- [ ] **Sentry integration.** No error tracking today.

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
