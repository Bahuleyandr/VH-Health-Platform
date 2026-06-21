# W5 — Admin Portal Multi-tenancy — Implementation Plan

> **For agentic workers:** use superpowers:executing-plans / subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deliver the admin portal half of multi-tenancy on top of W4's backend isolation: per-tenant branding, a SUPER_ADMIN act-as-tenant console, and proxy header discipline — one deployment, Host-derived tenant, NO-OP for the single default tenant.

**Spec:** `docs/superpowers/specs/2026-06-21-w5-admin-portal-multitenancy-design.md`

**Stacks:** backend (Node 22 + Express 5, Jest) for S1; admin (Next.js 16 + React 19 + TS, Jest + Playwright) for S2–S4.

**Invariant (every task):** byte-identical for the single default tenant — no branding row + non-super admin ⇒ today's behaviour. Branch `feat/multi-tenancy-program`, HOLD (no push, no ff to main).

**Status:** ✅ COMPLETE (2026-06-21). S1 `040b0e4b` · S2 `71f661ab` · S3 `c52c6db6` · S4 `63783458`. Backend chunked gate GREEN (87 chunks) + admin `npm test` 435 + `tsc` + `eslint` + `next build` all green. HOLD (not pushed). The S3↔S4 server-signal open question was resolved with the lean (httpOnly `acting_tenant` cookie set by `/api/act-as` after a signature-verified SUPER_ADMIN check; the proxy reads + re-gates it). Branding key confirmed = `tenants.settings.branding` via `tenantSettingsService.getBranding`. Residual UX polish (the act-as reason uses `window.prompt` — a modal would be nicer) left for human review.

---

## Task S1 — Backend: `GET /api/v1/admin/tenant/context`

- [ ] Confirm the W3 WS1 `tenants.settings` typed accessor + locate the `branding` shape (or define `{ displayName?, logoUrl?, primaryColor? }` with defaults).
- [ ] Add a thin controller + route under `routes/admin/tenantRoutes.js` (or a sibling) returning `{ id, slug, name, region, branding }` for `req.tenantId` (the caller's own/acted tenant). Read via `prisma` scoped read; never return other tenants' rows. RBAC: any authenticated admin (ADMIN or SUPER_ADMIN).
- [ ] Default tenant / no `branding` key ⇒ `branding: { displayName: name, primaryColor: null, logoUrl: null }` (NO-OP shape).
- [ ] Deep test `tenant-admin-context.deep.test.js`: default tenant → name+null branding; tenant A (seeded settings.branding) → A's branding; a regular ADMIN of tenant A cannot read tenant B (RLS/scoping).
- [ ] **Verify:** `node ... jest.js tenant-admin-context --forceExit` green; `npm run lint`.

## Task S2 — Admin: TenantProvider + branding chrome

- [ ] `lib/api/tenantContext.ts` — `getTenantContext()` calling `fetchAdminAPI('/admin/tenant/context')`.
- [ ] `contexts/TenantContext.tsx` — TanStack Query provider, mounted under the authed layout, exposing `{ name, branding, isLoading }`.
- [ ] Render `branding.displayName` + `logoUrl` in the dashboard header/sidebar; set `--tenant-primary` CSS var from `primaryColor` (fallback = current palette). Absent branding ⇒ unchanged UI.
- [ ] Jest: provider renders default name when branding absent; renders A's name when present; no crash when the endpoint 404s/errs (degrade to default).
- [ ] **Verify:** `npm test` (admin) green; `npm run build` (type-check) clean.

## Task S3 — Admin: SUPER_ADMIN act-as-tenant switcher + banner

- [ ] Acting-tenant state: a small client store (`contexts/ActingTenantContext.tsx`) `{ actingTenant: {id,slug,reason} | null, setActAs, clear }`, persisted to `sessionStorage` (cleared on logout).
- [ ] On `/dashboard/tenants`, add an **"Act as"** row action (SUPER_ADMIN only) → reason prompt (≥ 8 chars) → `setActAs`.
- [ ] Persistent **banner** ("Acting as **<name>** — exit") in the authed layout, visible only while `actingTenant` set; "exit" → `clear`.
- [ ] The acting-tenant header injection is wired in S4 (proxy) — S3 only owns the state + UI.
- [ ] Jest: switcher sets/clears acting-tenant; banner hidden for non-super (and when not acting); reason < 8 chars rejected.
- [ ] **Verify:** `npm test` + `npm run build`.

## Task S4 — Admin proxy: strip-and-reattach tenant headers

- [ ] In `app/api/proxy/[...path]/route.ts` `forwardableHeaders` (or a dedicated step): **drop** any inbound `x-tenant-id` / `x-tenant-override-reason` from the client request.
- [ ] Re-attach them only when the verified token role is `SUPER_ADMIN` AND the server has an acting-tenant (read from the request's acting-tenant signal — a cookie/header set by S3, validated server-side). Reason required; no reason ⇒ no header.
- [ ] Decode the token role server-side in the proxy (it already reads the cookie) to gate the re-attach — do not trust a client-claimed role.
- [ ] Jest (route handler): non-super inbound `x-tenant-id` is dropped; super + acting-tenant + reason ⇒ headers attached to upstream; super without reason ⇒ not attached.
- [ ] **Verify:** `npm test` + `npm run build` + `npm run lint`.

## Task S5 — W5 gate + closeout

- [ ] Backend: full chunked-as-postgres gate (`run-ci-jest.mjs` as postgres) → "All chunks passed".
- [ ] Admin: `npm test` + `npm run build` + `npm run lint` all green; Playwright smoke unaffected (regular-admin storage state → no switcher).
- [ ] Update this plan's checkboxes; set the W5 spec Status → Implemented; program-design Wave 5 → Status: COMPLETE; program memory + `MEMORY.md` → W5 DONE / next W6.
- [ ] HOLD: no push, no ff to main.

## Open implementation questions (resolve in-task, lean noted)

- **Acting-tenant server signal (S3↔S4):** the proxy must know the acting-tenant server-side. Lean: S3 writes an httpOnly `acting_tenant` cookie via a tiny `/api/act-as` route (server validates SUPER_ADMIN from the auth cookie before setting it) so the proxy reads a trusted value, not a client header. Decide at S4.
- **Branding storage:** confirm `tenants.settings.branding` is the agreed key (W3 WS1 accessor). If the accessor uses a different path, follow it.
