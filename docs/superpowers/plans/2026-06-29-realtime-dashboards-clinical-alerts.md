# Clinical Alerts & Code Blue Board (Slice 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new admin board that subscribes live to the already-broadcasting `staff:clinical-alerts` + `staff:code-blue` channels and seeds recent history via one new read endpoint — a Code Blue banner + a severity-colored alerts feed.

**Architecture:** Zero producer work (the channels already fire from `vitalSignMonitor.js`). One new backend read endpoint (`GET /api/v1/clinical-alerts/recent`) hydrates recent `clinical_alerts`; the page uses the low-level `useRealtimeChannel` (no query to invalidate) + a pure merge helper to combine history with live events.

**Tech Stack:** Node/Express 5 + PostgreSQL 17 (raw SQL via `prisma.$queryRawUnsafe`), Next.js 16 + TanStack Query v5, Jest.

**Spec:** `docs/superpowers/specs/2026-06-29-realtime-dashboards-clinical-alerts-design.md`
**Branch:** `feat/realtime-clinical-alerts-board` (already created off `main`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/services/clinical/clinicalAlertsService.js` | Recent-alerts read | Create |
| `apps/backend/src/routes/clinical/clinicalAlertsRoutes.js` | `GET /recent` route | Create |
| `apps/backend/src/app.js` | Route mount | Modify: import + 1 mount line |
| `apps/backend/src/tests/unit/clinicalAlertsService.test.js` | Service unit test | Create |
| `apps/backend/src/tests/unit/clinicalAlertsChannel.test.js` | Channel catalog test | Create |
| `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/feed.ts` | Channel consts + merge helper | Create |
| `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/page.tsx` | The board | Create |
| `apps/admin/src/__tests__/dashboard/clinical-alerts/feed.test.ts` | Merge-helper test | Create |
| `apps/admin/src/__tests__/dashboard/clinical-alerts/page.test.tsx` | Page-wiring test | Create |

**Run-command reference**
- Backend (from `apps/backend`): `npm run lint` · `node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`
- Admin (from `apps/admin`): `npm test -- <pattern>` · `npm run type-check` · `npm run lint` · `npm run build`

---

## Task 1: Backend — `clinicalAlertsService.listRecentAlerts` (TDD)

**Files:** Create `apps/backend/src/services/clinical/clinicalAlertsService.js` + `apps/backend/src/tests/unit/clinicalAlertsService.test.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/clinicalAlertsService.test.js`:

```js
import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (t) => t,
  resolveTenantOrThrow: (req) => req?.tenantId,
}));

const { listRecentAlerts } = await import('../../services/clinical/clinicalAlertsService.js');

const TID = '00000000-0000-4000-8000-000000000001';

describe('listRecentAlerts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('queries clinical_alerts tenant-scoped/windowed/ordered/limited and normalizes rows', async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      { id: 7, patient_id: 42, vital_name: 'SpO2', vital_value: '83.00', severity: 'CRITICAL', message: 'low O2', acknowledged: false, created_at: '2026-06-29T10:00:00.000Z' },
    ]);
    const out = await listRecentAlerts({ tenantId: TID, hours: 8, limit: 100 });

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM clinical_alerts/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/make_interval\(hours => \$2::int\)/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(sql).toMatch(/LIMIT \$3::int/);
    expect(params).toEqual([TID, 8, 100]);

    expect(out).toEqual([{
      kind: 'vital-anomaly', id: 7, patientId: '42', vitalName: 'SpO2',
      value: 83, unit: null, severity: 'CRITICAL', message: 'low O2',
      acknowledged: false, at: '2026-06-29T10:00:00.000Z',
    }]);
  });

  test('applies defaults (8h / 100) and clamps to maxes (72h / 200)', async () => {
    queryRawUnsafe.mockResolvedValue([]);
    await listRecentAlerts({ tenantId: TID });
    expect(queryRawUnsafe.mock.calls[0].slice(1)).toEqual([TID, 8, 100]);
    await listRecentAlerts({ tenantId: TID, hours: 999, limit: 9999 });
    expect(queryRawUnsafe.mock.calls[1].slice(1)).toEqual([TID, 72, 200]);
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js clinicalAlertsService --forceExit`
Expected: FAIL — cannot import `clinicalAlertsService.js`.

- [ ] **Step 3: Implement the service**

Create `apps/backend/src/services/clinical/clinicalAlertsService.js`:

```js
// src/services/clinical/clinicalAlertsService.js
//
// Read-only hydration for the admin Clinical Alerts & Code Blue board. The
// live feed comes over WS (staff:clinical-alerts / staff:code-blue); this
// seeds recent history on page load because there is no other list endpoint
// for clinical_alerts. Tenant-scoped by explicit tenant_id filter.

import prisma from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';

/**
 * Recent vital-sign alerts for the requesting tenant, newest first.
 * Normalized to the staff:clinical-alerts WS payload shape (+ id/acknowledged)
 * so the frontend merges history and live events uniformly.
 */
export async function listRecentAlerts({ tenantId, hours, limit } = {}) {
  const tid = requireTenantId(tenantId);
  const h = Math.min(Math.max(Number(hours) || 8, 1), 72);       // default 8h, clamp 1..72
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);  // default 100, clamp 1..200

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_id, vital_name, vital_value, severity, message, acknowledged, created_at
       FROM clinical_alerts
      WHERE tenant_id = $1::uuid
        AND created_at > (now() - make_interval(hours => $2::int))
      ORDER BY created_at DESC
      LIMIT $3::int`,
    tid, h, lim,
  );

  return rows.map((r) => ({
    kind: 'vital-anomaly',
    id: Number(r.id),
    patientId: r.patient_id == null ? null : String(r.patient_id),
    vitalName: r.vital_name,
    value: r.vital_value == null ? null : Number(r.vital_value),
    unit: null, // clinical_alerts has no unit column; live WS events carry it
    severity: r.severity,
    message: r.message,
    acknowledged: !!r.acknowledged,
    at: r.created_at,
  }));
}
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js clinicalAlertsService --forceExit`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/clinical/clinicalAlertsService.js apps/backend/src/tests/unit/clinicalAlertsService.test.js
git commit -m "feat(clinical-alerts): recent-alerts hydration service (tenant-scoped)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Backend — route + mount + channel test

**Files:** Create `apps/backend/src/routes/clinical/clinicalAlertsRoutes.js` + `apps/backend/src/tests/unit/clinicalAlertsChannel.test.js`; Modify `apps/backend/src/app.js`.

- [ ] **Step 1: Create the route**

Create `apps/backend/src/routes/clinical/clinicalAlertsRoutes.js` (mirrors the `icuRoutes`/`orBoardRoutes` board scaffolding; generic 500 message per the security checklist):

```js
// src/routes/clinical/clinicalAlertsRoutes.js
//
// Read surface for the admin Clinical Alerts & Code Blue board. Live data is
// pushed over the staff:clinical-alerts / staff:code-blue WS channels; this
// route only hydrates recent history. Cross-patient operational board — no
// patientAccessGuard (matches the OR-board sibling mount).

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as clinicalAlerts from '../../services/clinical/clinicalAlertsService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('clinical-alerts route error:', err);
      return error(res, 'An internal server error occurred. Please try again later.', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// GET /api/v1/clinical-alerts/recent?hours=8&limit=100
router.get('/recent', requireStaffOrAdmin, wrap(async (req) =>
  clinicalAlerts.listRecentAlerts({
    tenantId: tenantOf(req),
    hours: req.query.hours,
    limit: req.query.limit,
  })));

export default router;
```

- [ ] **Step 2: Mount in `app.js`**

In `apps/backend/src/app.js`, add the import alongside the other clinical route imports (near `import icuRoutes from './routes/clinical/icuRoutes.js';`):

```js
import clinicalAlertsRoutes from './routes/clinical/clinicalAlertsRoutes.js';
```

Then add the mount immediately AFTER the existing `app.use('/api/v1/icu', …)` line:

```js
app.use('/api/v1/clinical-alerts', requireRole(...CLINICAL_STAFF_ROLES), phiAccessLogger('CLINICAL_ALERTS'), clinicalAlertsRoutes);
```

(`CLINICAL_STAFF_ROLES` is already declared in app.js; `requireRole` + `phiAccessLogger` are already imported. No `patientAccessGuard` — this is a cross-patient board, matching the `/api/v1/theatre … orBoardRoutes` mount.)

- [ ] **Step 3: Write the channel-catalog test**

Create `apps/backend/src/tests/unit/clinicalAlertsChannel.test.js`:

```js
import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('clinical-alerts board channels', () => {
  test('both channels are in the catalog with staff scope', () => {
    expect(CHANNEL_CATALOG['staff:clinical-alerts']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:clinical-alerts'].roles).toBe('staff');
    expect(CHANNEL_CATALOG['staff:code-blue']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:code-blue'].roles).toBe('staff');
  });

  test('allowed for clinical staff + admins, denied for patients', () => {
    for (const ch of ['staff:clinical-alerts', 'staff:code-blue']) {
      expect(authorizeChannel(ch, { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
      expect(authorizeChannel(ch, { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
      expect(authorizeChannel(ch, { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
      expect(authorizeChannel(ch, { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
    }
  });
});
```

- [ ] **Step 4: Verify**

Run (from `apps/backend`): `npm run lint` → PASS (eslint + lint:raw-params — confirms the `make_interval`/`::int`/`::uuid` casts satisfy the raw-param rule).
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js clinicalAlertsService clinicalAlertsChannel --forceExit` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/clinical/clinicalAlertsRoutes.js apps/backend/src/app.js apps/backend/src/tests/unit/clinicalAlertsChannel.test.js
git commit -m "feat(clinical-alerts): GET /clinical-alerts/recent route + mount + channel test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Frontend — feed helper (TDD)

**Files:** Create `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/feed.ts` + `apps/admin/src/__tests__/dashboard/clinical-alerts/feed.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/__tests__/dashboard/clinical-alerts/feed.test.ts`:

```ts
import {
  mergeAlerts, alertKey, codeBlueKey, ALERT_FEED_CAP,
  type AlertItem, type CodeBlueItem,
} from "@/app/(with-auth)/dashboard/clinical-alerts/feed";

function alert(p: Partial<AlertItem> & { at: string }): AlertItem {
  return {
    kind: "vital-anomaly", patientId: "1", vitalName: "HR", value: 190,
    unit: null, severity: "CRITICAL", message: "m", at: p.at, ...p,
  };
}

describe("mergeAlerts", () => {
  it("sorts newest-first across history + live", () => {
    const history = [alert({ id: 1, at: "2026-06-29T10:00:00.000Z" })];
    const live = [alert({ at: "2026-06-29T10:05:00.000Z" })];
    expect(mergeAlerts(history, live).map((a) => a.at)).toEqual([
      "2026-06-29T10:05:00.000Z", "2026-06-29T10:00:00.000Z",
    ]);
  });

  it("dedupes a history row by DB id (live copy of the same id wins, once)", () => {
    const history = [alert({ id: 5, at: "2026-06-29T10:00:00.000Z", message: "old" })];
    const live = [alert({ id: 5, at: "2026-06-29T10:00:00.000Z", message: "new" })];
    const out = mergeAlerts(history, live);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("new"); // live precedence
  });

  it("dedupes id-less live events by patient|vital|at", () => {
    const a = alert({ at: "2026-06-29T10:00:00.000Z" });
    expect(mergeAlerts([], [a, { ...a }])).toHaveLength(1);
  });

  it("caps at ALERT_FEED_CAP", () => {
    const many = Array.from({ length: ALERT_FEED_CAP + 50 }, (_, i) =>
      alert({ id: i, at: `2026-06-29T10:00:${String(i % 60).padStart(2, "0")}.000Z` }));
    expect(mergeAlerts(many, [])).toHaveLength(ALERT_FEED_CAP);
  });
});

describe("keys", () => {
  it("alertKey prefers id, falls back to composite", () => {
    expect(alertKey(alert({ id: 9, at: "t" }))).toBe("id:9");
    expect(alertKey(alert({ at: "2026-06-29T10:00:00.000Z" }))).toBe("live:1|HR|2026-06-29T10:00:00.000Z");
  });
  it("codeBlueKey combines patient + time", () => {
    const c: CodeBlueItem = { kind: "code-blue", patientId: "7", bedNumber: null, ward: "3W", triggeredBy: null, reason: null, at: "t" };
    expect(codeBlueKey(c)).toBe("7|t");
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS**

Run (from `apps/admin`): `npm test -- clinical-alerts/feed`
Expected: FAIL — cannot resolve `.../clinical-alerts/feed`.

- [ ] **Step 3: Implement the helper**

Create `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/feed.ts`:

```ts
export const CLINICAL_ALERTS_CHANNEL = "staff:clinical-alerts";
export const CODE_BLUE_CHANNEL = "staff:code-blue";
export const ALERT_FEED_CAP = 200;
export const CODE_BLUE_WINDOW_MS = 15 * 60 * 1000;

export type AlertItem = {
  kind: "vital-anomaly";
  id?: number;
  patientId: string | null;
  vitalName: string | null;
  value: number | null;
  unit: string | null;
  severity: string | null;
  message: string | null;
  acknowledged?: boolean;
  at: string;
};

export type CodeBlueItem = {
  kind: "code-blue";
  patientId: string | null;
  bedNumber: string | null;
  ward: string | null;
  triggeredBy: string | null;
  reason: string | null;
  at: string;
};

// Stable de-dup key: prefer the DB id (history rows); live WS events have no
// id, so fall back to a patient|vital|at composite.
export function alertKey(a: AlertItem): string {
  return a.id != null ? `id:${a.id}` : `live:${a.patientId}|${a.vitalName}|${a.at}`;
}

export function codeBlueKey(c: CodeBlueItem): string {
  return `${c.patientId}|${c.at}`;
}

// Merge live (newest, first-seen wins) ahead of history, dedupe by alertKey,
// sort by `at` descending, cap at ALERT_FEED_CAP.
export function mergeAlerts(history: AlertItem[], live: AlertItem[]): AlertItem[] {
  const byKey = new Map<string, AlertItem>();
  for (const a of [...live, ...history]) {
    const k = alertKey(a);
    if (!byKey.has(k)) byKey.set(k, a);
  }
  return [...byKey.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, ALERT_FEED_CAP);
}
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run (from `apps/admin`): `npm test -- clinical-alerts/feed`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/feed.ts" "apps/admin/src/__tests__/dashboard/clinical-alerts/feed.test.ts"
git commit -m "feat(clinical-alerts): feed merge/dedupe/cap helper + channel consts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — board page + page test

**Files:** Create `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/page.tsx` + `apps/admin/src/__tests__/dashboard/clinical-alerts/page.test.tsx`.

- [ ] **Step 1: Create the page**

Create `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/page.tsx`:

```tsx
// src/app/(with-auth)/dashboard/clinical-alerts/page.tsx
//
// Clinical Alerts & Code Blue board. Live via staff:clinical-alerts +
// staff:code-blue (low-level useRealtimeChannel — no query to invalidate);
// recent history hydrated once from GET /clinical-alerts/recent.

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";
import {
  mergeAlerts,
  codeBlueKey,
  CLINICAL_ALERTS_CHANNEL,
  CODE_BLUE_CHANNEL,
  ALERT_FEED_CAP,
  CODE_BLUE_WINDOW_MS,
  type AlertItem,
  type CodeBlueItem,
} from "./feed";

function unwrapList<T>(r: unknown): T[] {
  const d = (r as { data?: unknown }).data ?? r;
  return Array.isArray(d) ? (d as T[]) : [];
}

function fmtTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString();
}

const ROW_TONE: Record<string, string> = {
  CRITICAL: "bg-rose-50",
  WARNING: "bg-amber-50",
};

export default function ClinicalAlertsPage() {
  const [liveAlerts, setLiveAlerts] = useState<AlertItem[]>([]);
  const [codeBlues, setCodeBlues] = useState<CodeBlueItem[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const { data: history = [], isLoading } = useQuery<AlertItem[]>({
    queryKey: ["clinical-alerts", "recent"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/clinical-alerts/recent?hours=8&limit=100");
      return unwrapList<AlertItem>(r);
    },
    staleTime: Infinity, // freshness comes from the WS channels, not polling
  });

  const alertsRt = useRealtimeChannel<AlertItem>(CLINICAL_ALERTS_CHANNEL, {
    onEvent: (m) => setLiveAlerts((p) => [m.data as AlertItem, ...p].slice(0, ALERT_FEED_CAP)),
  });
  useRealtimeChannel<CodeBlueItem>(CODE_BLUE_CHANNEL, {
    onEvent: (m) => setCodeBlues((p) => [m.data as CodeBlueItem, ...p].slice(0, 50)),
  });

  const feed = mergeAlerts(history, liveAlerts);

  const now = Date.now();
  const activeCodeBlues = codeBlues.filter(
    (c) => !dismissed.has(codeBlueKey(c)) && now - new Date(c.at).getTime() < CODE_BLUE_WINDOW_MS,
  );

  const liveLabel = alertsRt.subscribed
    ? "● Live"
    : alertsRt.connected
      ? "○ Connecting"
      : "○ Offline";
  const liveTone = alertsRt.subscribed ? "text-green-600" : "text-gray-400";

  return (
    <div className="p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold text-foreground">Clinical Alerts &amp; Code Blue</h1>
          <span
            data-testid="clinical-alerts-realtime-indicator"
            role="status"
            aria-label={
              alertsRt.subscribed
                ? "Live — real-time clinical alerts active"
                : "Connecting or offline — real-time clinical alerts not yet live"
            }
            className={`text-xs font-medium ${liveTone}`}
          >
            {liveLabel}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Live vital-sign anomalies and Code Blue pushes. History seeded for the last 8 hours;
          new alerts appear in real time.
        </p>
      </div>

      {activeCodeBlues.length > 0 && (
        <div className="space-y-2">
          {activeCodeBlues.map((c) => (
            <div
              key={codeBlueKey(c)}
              role="alert"
              className="rounded-lg border-2 border-rose-500 bg-rose-600 text-white p-4 flex items-start justify-between gap-4"
            >
              <div>
                <div className="text-lg font-extrabold tracking-wide">🚨 CODE BLUE</div>
                <div className="text-sm mt-1">
                  {c.ward ? `Ward ${c.ward} · ` : ""}
                  {c.bedNumber ? `Bed ${c.bedNumber} · ` : ""}
                  Patient {c.patientId ?? "—"}
                </div>
                {c.reason && <div className="text-sm font-semibold mt-1">{c.reason}</div>}
                <div className="text-xs opacity-80 mt-1">{fmtTime(c.at)}</div>
              </div>
              <button
                type="button"
                onClick={() => setDismissed((p) => new Set(p).add(codeBlueKey(c)))}
                className="rounded bg-white/20 px-3 py-1.5 text-sm font-medium hover:bg-white/30"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {isLoading && feed.length === 0 ? (
        <LoadingSpinner />
      ) : feed.length === 0 ? (
        <EmptyState
          title="No alerts yet"
          description="Live vital-sign alerts will appear here as they fire."
        />
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-3">Time</th>
                <th className="text-left p-3">Severity</th>
                <th className="text-left p-3">Patient</th>
                <th className="text-left p-3">Vital</th>
                <th className="text-left p-3">Value</th>
                <th className="text-left p-3">Message</th>
              </tr>
            </thead>
            <tbody>
              {feed.map((a) => (
                <tr
                  key={a.id != null ? `id:${a.id}` : `${a.patientId}|${a.vitalName}|${a.at}`}
                  className={`border-t border-border ${a.acknowledged ? "opacity-50" : ""} ${
                    ROW_TONE[a.severity ?? ""] ?? ""
                  }`}
                >
                  <td className="p-3 whitespace-nowrap text-xs">{fmtTime(a.at)}</td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-semibold ${
                        a.severity === "CRITICAL"
                          ? "bg-rose-200 text-rose-900"
                          : "bg-amber-200 text-amber-900"
                      }`}
                    >
                      {a.severity ?? "—"}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-xs">{a.patientId ?? "—"}</td>
                  <td className="p-3">{a.vitalName ?? "—"}</td>
                  <td className="p-3">
                    {a.value ?? "—"}
                    {a.unit ? ` ${a.unit}` : ""}
                  </td>
                  <td className="p-3 text-muted-foreground">{a.message ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create the page test**

Create `apps/admin/src/__tests__/dashboard/clinical-alerts/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import ClinicalAlertsPage from "@/app/(with-auth)/dashboard/clinical-alerts/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const channelCalls: string[] = [];
let rtReturn: {
  lastMessage: null;
  connected: boolean;
  subscribed: boolean;
  denied: string | null;
  latencyMs: number | null;
} = { lastMessage: null, connected: false, subscribed: false, denied: null, latencyMs: null };

jest.mock("@/hooks/useRealtimeChannel", () => ({
  useRealtimeChannel: (channel: string) => {
    channelCalls.push(channel);
    return rtReturn;
  },
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<ClinicalAlertsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    channelCalls.length = 0;
    rtReturn = { lastMessage: null, connected: false, subscribed: false, denied: null, latencyMs: null };
    mockedFetchAdminAPI.mockResolvedValue([
      {
        kind: "vital-anomaly", id: 1, patientId: "42", vitalName: "SpO2", value: 83,
        unit: null, severity: "CRITICAL", message: "low O2", acknowledged: false,
        at: "2026-06-29T10:00:00.000Z",
      },
    ] as never);
  });

  it("subscribes to both alert channels and renders hydrated history", async () => {
    renderWithQuery(<ClinicalAlertsPage />);
    expect(await screen.findByText("low O2")).toBeInTheDocument();
    expect(channelCalls).toContain("staff:clinical-alerts");
    expect(channelCalls).toContain("staff:code-blue");
  });

  it("indicator reads Offline when disconnected", async () => {
    renderWithQuery(<ClinicalAlertsPage />);
    expect(await screen.findByTestId("clinical-alerts-realtime-indicator")).toHaveTextContent("Offline");
  });

  it("indicator reads Live when subscribed", async () => {
    rtReturn = { lastMessage: null, connected: true, subscribed: true, denied: null, latencyMs: null };
    renderWithQuery(<ClinicalAlertsPage />);
    expect(await screen.findByTestId("clinical-alerts-realtime-indicator")).toHaveTextContent("Live");
  });
});
```

- [ ] **Step 3: Run the page + feed tests**

Run (from `apps/admin`): `npm test -- clinical-alerts/`
Expected: PASS (feed + page).

- [ ] **Step 4: Type-check + lint**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run (from `apps/admin`): `npm run lint` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/page.tsx" "apps/admin/src/__tests__/dashboard/clinical-alerts/page.test.tsx"
git commit -m "feat(clinical-alerts): admin Clinical Alerts & Code Blue board page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run (from `apps/backend`): `npm run lint` → PASS.
Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js clinicalAlertsService clinicalAlertsChannel --forceExit` → PASS (4 tests).

- [ ] **Step 2: Admin gates**

Run (from `apps/admin`): `npm run type-check` → 0 errors.
Run (from `apps/admin`): `npm run lint` → 0 errors.
Run (from `apps/admin`): `npm test` → full suite PASS (incl. the new `clinical-alerts/feed` + `clinical-alerts/page` tests).
Run (from `apps/admin`): `npm run build` → PASS.

- [ ] **Step 3: Manual live-WS verification (optional, deploy HELD → local)**

Per spec §9: open the board (`● Live`); trigger a CRITICAL vital / `emitCodeBlue` from a second client → a Code Blue banner + a red feed row appear within ~1s; reload → recent alerts re-hydrate from `/clinical-alerts/recent`.

---

## After the plan: finish the branch

Follow the standing workflow: request review, then `merge --no-ff` into `main`, push **both** remotes (GitHub + Forgejo), delete the branch. **Deploy stays HELD** — do not tag.

## Spec-coverage check (self-review)

- Service hydration (spec §4.3) → Task 1. Route + mount (§4.4-4.5) → Task 2. Channels unchanged (§4.1) — asserted in the channel test (Task 2.3). Feed helper (§5.1) → Task 3. Page + banner + indicator (§5.2) → Task 4. Tests (§7) → Tasks 1/2/3/4. Gates + manual (§9) → Task 5. Tenant/PHI (§6) → Task 1 (explicit `tenant_id` filter) + Task 2 (`phiAccessLogger` mount). Out-of-scope (no producers/ack/migration/code-blue-history) — no task, as intended.
- Type consistency: `AlertItem`/`CodeBlueItem` defined in `feed.ts` (Task 3) and consumed by `page.tsx` (Task 4); the service (Task 1) returns the same normalized `AlertItem` shape the hydrate query expects. Channel strings `staff:clinical-alerts`/`staff:code-blue` consistent across the channel test (Task 2), `feed.ts` consts (Task 3), and the page subscriptions + page test (Task 4). `make_interval(hours => $2::int)` / `$1::uuid` / `$3::int` casts in the service (Task 1) match what the service test asserts.
