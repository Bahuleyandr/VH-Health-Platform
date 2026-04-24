# HONESTY ADDENDUM — 2026-04-14 (post-audit)

**Grade: B+.** Genuinely the strongest repo after the backend-post-fix. Fortress auth (httpOnly cookie + single-flight 401 refresh + CSRF allowlist + JWT signature validation in middleware), strict TypeScript, Zod validation, TanStack Query v5, real-time fabric wired. 60 routes, most feature-complete.

**Gaps the existing roadmap understates:**
- **Zero component tests.** Not one `.test.tsx` for an actual component. Jest configured but unused. Auth, forms, data tables — all untested at the UI level.
- **God components** — `system-logs/page.tsx` (456 LOC), `PermissionsMatrix.tsx`, `Dashboard` pulling a giant subtree. Hard to mock, hard to test.
- **Accessibility at 5/10.** Raw `<img>` tags bypass Next/Image (disabled with comments); sparse `aria-label`/`role` on interactive elements; forms may lack proper labels; no `aria-live` on async data tiles.
- **Real-time half-baked.** WS reconnect has exponential backoff, but no heartbeat/pong, no subscribe-confirmation, no stale-ticket refresh UX. Ticket TTL is 60s — stale tokens will manifest as mysterious disconnects.
- **Deployment story** (resolved 2026-04-23): admin portal now ships via
  GitHub Actions image build + ArgoCD GitOps onto the on-prem RKE2
  cluster. Manifests at `infra/kubernetes/apps/admin/`. See
  `../../../docs/DEPLOYMENT_GUIDE.md` for the full runbook. Previous "no
  CI/CD visible" gap closed.

**Next concrete moves:**
1. Playwright smoke tests on top 5 user journeys (login → dashboard, user CRUD, appointment ops, billing invoice, compliance dashboard).
2. Break `system-logs/page.tsx` + `PermissionsMatrix.tsx` into testable subcomponents.
3. Next/Image sweep — every raw `<img>` with `eslint-disable`.
4. a11y audit (axe-core on key pages).
5. WS heartbeat + ticket-refresh UX.

---

# Admin Portal Roadmap — A+/S-Tier

> Source of truth for next-step work. Next.js app for hospital administration.

**Current grade:** C+. Modern stack (App Router, TanStack Query) with good patterns in places, but critical gaps: bed management is a localStorage mock with "Backend API coming soon" comment; 975+ line client components; 4 tests total; no MFA; 7-day JWT in `localStorage` (XSS risk).

**Deployment grade upgraded 2026-04-23:** C (manual deploy) → **A (GitOps via ArgoCD on 3-node on-prem RKE2)**. End-to-end runbook at `../../../docs/DEPLOYMENT_GUIDE.md`; hardware spec at `../../../docs/HARDWARE_REQUIREMENTS.md`.

---

## Phase 1 — A+ Security Floor ✅

- [x] **Replace bed-management localStorage mock.** Wired to backend `/beds` CRUD via TanStack Query.
- [x] **MFA (TOTP) on login.** Challenge step + enrollment + recovery codes UI shipped.
- [x] **Shorten JWT TTL to 4h + refresh token.** `/api/refresh` route rotates the httpOnly cookie server-side; `core.ts` 401 handler does single-flight refresh + retry, redirecting to login only on failure.
- [x] **Move token storage out of `localStorage`.** Already on httpOnly `auth_token` cookie; legacy `localStorage.getItem("adminToken")` purged across 12 files. Also fixed a latent bug in `ProtectedRoute` that gated auth on a key nothing writes.
- [x] **Split god-components (Phase 1 scope).** `PermissionsMatrix.tsx` 413→112L orchestrator + 4 sub-files. `system-audit/page.tsx` 1041→67L orchestrator + 5 sub-files. `DashboardClient.tsx` **deleted entirely in batch 20** (the Dashboard orchestrator is now `Dashboard.tsx` at 69 LOC + 5 sub-components). Follow-up splits shipped in batches 33 (ComplianceTab 908→54), 39 (system-logs 445→111), 40 (audit 612→149).

## Phase 2 — A+ Polish

- [ ] **Test coverage ≥60%.** Currently **21 Jest suites / 247 unit+component tests** + **10 Playwright tests** (5 smoke + 5 authenticated journey, auth.setup.ts wired in batch 42). Remaining targets: MFA challenge flow, role change audit, bed CRUD, pharmacy stock adjustment — these need a seeded test backend + fixtures that roll back cleanly.
- [ ] **Data-table features.** Pagination + sort + filter exist; **CSV export utility shipped** (`src/lib/exportToCsv.ts`). Still open: bulk-edit, keyboard shortcuts.
- [x] **IP allowlist middleware.** `src/middleware.ts` gates `/dashboard/*` and `/api/proxy/*` behind `ADMIN_IP_ALLOWLIST` env var. Opt-in — unset means no allowlist.
- [x] **Error boundaries + empty states.** `PageErrorBoundary` now reports to Sentry + hides raw errors from users. New `LoadingSpinner` + `EmptyState` shared components. `(with-auth)/layout.tsx` wraps all authenticated pages.
- [x] **Sentry integration.** Already wired — `@sentry/nextjs` v10, 3 instrumentation files, `withSentryConfig`, CSP entry, error boundary hook. Set `NEXT_PUBLIC_SENTRY_DSN` in prod to activate.
- [x] **Deeper `DashboardClient.tsx` split.** Obsoleted in batch 20 — the whole file was deleted (it was a duplicate of the CleanDashboard / now `Dashboard.tsx` tree). Batches 33/39/40 split the real remaining god-pages (ComplianceTab, system-logs, audit).

## Phase 3 — S-Tier Marquee

### 3A (admin slice). Real-time KPI dashboard ✅ (first tile, 2026-04-14)
- `hooks/useRealtimeChannel.ts` — two-step handshake: POSTs `/api/realtime-ticket` to mint a ~60s WS-scoped ticket (primary JWT stays in the httpOnly cookie, never exposed to JS), then opens WS to backend `/ws?token=<ticket>` with auto-reconnect and subscribes to the named channel.
- `app/api/realtime-ticket/route.ts` — server-side ticket proxy with CSRF origin check, matches `/api/refresh` pattern.
- `LiveBedOccupancyTile` mounted in `Dashboard` — subscribes to `admin:beds`, shows connection pulse + most recent bed event.
- **Loose end closed (2026-04-14):** `LiveBedOccupancyTile` rewritten from an event log into an aggregate tile group. Subscribes to `admin:kpi` and renders two tiles — bed occupancy % (green/amber/red based on pressure) with occupied/total subline, and today's-queue (waiting count + in-consult + active doctors). Backend `kpiAggregator.tickAdminKpi` emits every 30s with a startup prime so tiles paint before the first cron tick.
- **Still open:** ED wait time, pharmacy stock-out rate, staff utilisation — each requires its own aggregator branch. The pattern is in place; adding a tile is `emitAdminKpi('new-tile', {...})` on the backend + a reader in `LiveBedOccupancyTile`.

### 3F. Integrated revenue cycle ✅ (denial dashboard + 837 download available, 2026-04-14)
Admin page `dashboard/billing/denials` reads the new `/billing/denials/summary` + `/billing/denials` endpoints — count / amount denied / appealed / win rate tiles, top reason codes, recent list. Backend now also exposes `GET /billing/837/:invoiceId` (returns `application/edi-x12`) — a claim-submission queue page can wire directly to it.
**Still open:** dedicated claim submission queue UI, AR aging, patient payment portal admin, payer-specific companion-guide overrides.

### 3Γ. Compliance & accreditation dashboards ✅ (2026-04-14)
Admin page `dashboard/compliance/indicators` reads `/compliance/indicators` — NABH/JCI tiles for medication error rate, patient-identification error rate, MAR override rate, CDS override rate, unacknowledged critical alerts. Indicators with no data source (hand-hygiene, HAI, surgical-site infection) render as "tracking integration needed" rather than misleading zeros.
**PDF export landed 2026-04-14** — `src/lib/exportToPdf.ts` wraps jsPDF + jspdf-autotable; "Export PDF" button downloads a formatted report with hospital branding + trailing-window subtitle.
**Still open:** hand-hygiene/HAI/SSI data sources.

### 3Δ. Pharmacy inventory + expiry management ✅ (2026-04-14)
Admin page `dashboard/pharmacy/inventory` — summary tiles (in-stock, below reorder, expiring, expired) + per-section tables (low stock, expiring 30d, expired). Reads the existing `/pharmacy/inventory/*` endpoints.
**Still open:** supplier integration for auto-reorder, batch-level recall tracking (current backend keys on medication, not batch).

## Phase 4 — Platform (2026-04-23 onwards)

### 4A. Deployment on on-prem RKE2 ✅ (narrative locked)
Admin image built by GitHub Actions, pushed as `ghcr.io/bahuleyan/vhhealth-admin:v1.2.3`
+ `main-<sha>`, referenced by manifests at `infra/kubernetes/apps/admin/`. ArgoCD
reconciles; Cloudflare Tunnel → ingress-nginx → Service. See
[`../../../docs/DEPLOYMENT_GUIDE.md`](../../../docs/DEPLOYMENT_GUIDE.md).

### 4B. Deferred — batch 17
- ArgoCD image updater wired for automatic tag bumps.
- Playwright E2E against the cluster ingress (currently runs locally).
- Post-cutover pentest pass on `admin.vhhealth.app`.

### 3Ε. Executive KPI dashboard (C-suite view) ✅ (2026-04-14)
Admin page `dashboard/executive` reads the new `/admin/executive-kpi/summary` — revenue billed/collected, bed occupancy with pressure colouring, patient satisfaction (feedback avg), doctor utilisation. Role-gated client-side via `usePermissions` + backend `ADMIN` requirement.
**PDF export landed 2026-04-14** — same shared helper as compliance; exports a KPI strip + revenue/operations tables.
**Still open:** quarter-over-quarter trend lines.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md`.
- Conventions: [CLAUDE.md](../CLAUDE.md) (if present).
