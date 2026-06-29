# Real-time dashboards — Slice 6: Clinical Alerts & Code Blue board (`staff:clinical-alerts` + `staff:code-blue`)

- **Date:** 2026-06-29
- **Epic:** #4 Real-time-first dashboards
- **Status:** Design approved → spec
- **Builds on:** the proven WS fabric. **Different from slices 1–5:** this is a NEW page surfacing two channels that **already broadcast** (consumed only by the Flutter staff app today) + **one small new read endpoint** to hydrate recent history. No producer work, no new channel.

## 1. Context & goal

The platform already broadcasts the two highest-acuity real-time signals — vital-sign anomalies (`staff:clinical-alerts`) and Code Blue (`staff:code-blue`) — from `vitalSignMonitor.js:389-391` on the live vitals write path. Today only the Flutter staff app consumes them (a blocking full-screen modal). There is **no web surface** and **no admin nursing-station wall display**.

**Goal:** a new admin board that subscribes to both channels live and seeds recent history on load, giving a single screen with a prominent **Code Blue banner** + a severity-colored **clinical-alerts feed**. The producers already exist; the only backend addition is a small read endpoint to hydrate recent `clinical_alerts` rows (because there is no existing list endpoint, a pure-live board would start empty and lose everything on refresh).

## 2. Scope

**In scope**
- A new admin page `dashboard/clinical-alerts/` subscribing to `staff:clinical-alerts` + `staff:code-blue` via the low-level `useRealtimeChannel` hook (no react-query key to invalidate → not `useRealtimeInvalidation`).
- One new backend read endpoint `GET /api/v1/clinical-alerts/recent` + a `clinicalAlertsService.listRecentAlerts` that hydrates recent `clinical_alerts`.
- A pure feed helper (merge/dedupe/cap) + a `●Live/○Connecting/○Offline` indicator.
- Tests: service unit test, channel-catalog assertion, feed-helper unit test, page-wiring test.

**Out of scope (YAGNI)**
- **No acknowledge-to-server** — the board is read-only (mirrors the Flutter app, whose "Acknowledge" only closes its local modal; there is no ack-write pattern in the codebase). Code-blue banners are locally dismissable only.
- **No new producers / channel / migration** — `emitVitalAnomaly`/`emitCodeBlue` + both `CHANNEL_CATALOG` entries already exist.
- **No code-blue history** — code-blue events aren't persisted with their `ward`/`bed`/`reason` context (they're derived live from a CRITICAL vital). The hydrate covers the **vital-anomaly feed** (which includes the CRITICAL rows that trigger code-blue); the **code-blue banner is live-only**. Rare + the wall display is being watched.
- No 3rd alert source; no write paths; no Flutter change.

## 3. Architecture & data flow

```
vitals write ─(already)→ emitVitalAnomaly → staff:clinical-alerts ─┐
                         emitCodeBlue      → staff:code-blue ───────┤ WS (live)
                                                                    ▼
clinical-alerts page  ── useRealtimeChannel('staff:clinical-alerts', {onEvent}) → append live vital-anomaly
                      ── useRealtimeChannel('staff:code-blue', {onEvent})        → push live code-blue → banner
                      ── useQuery(GET /clinical-alerts/recent)                   → seed history once (no poll)
              feed = mergeAlerts(history, liveAlerts)  → severity-colored list (CRITICAL red / WARNING amber)
              banner = recent live code-blues (last 15 min, locally dismissable)
```

The WS push carries PHI (patientId + vital values) to staff/admins exactly as the Flutter app already receives it; the REST hydrate is an auditable PHI read over the same data. There is no query to invalidate, so the page uses the **low-level `useRealtimeChannel`** (returns `{lastMessage, connected, subscribed, denied, latencyMs}`, calls `onEvent` per event via an internal ref → inline `onEvent` closures are safe).

## 4. Backend design (one new read endpoint — no producers)

### 4.1 Channels (no change)
Both already in `CHANNEL_CATALOG` (`channelAuth.js:76-77`), `roles:'staff'`:
`'staff:clinical-alerts'` and `'staff:code-blue'`. Producers already fire. **Nothing to add.**

### 4.2 Payloads (already broadcast — what the board renders)
- `staff:clinical-alerts` (`emitVitalAnomaly`): `{ kind:'vital-anomaly', patientId, vitalName, value, unit, severity: 'WARNING'|'CRITICAL', message, at }`
- `staff:code-blue` (`emitCodeBlue`): `{ kind:'code-blue', patientId, bedNumber, ward, triggeredBy, reason, at }`

### 4.3 Service — `apps/backend/src/services/clinical/clinicalAlertsService.js` (new)
```js
export async function listRecentAlerts({ tenantId, hours, limit } = {}) {
  const tid = requireTenantId(tenantId);  // route passes resolveTenantOrThrow(req); guard anyway
  const h = Math.min(Math.max(Number(hours) || 8, 1), 72);     // default 8h, clamp 1..72
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200); // default 100, clamp 1..200
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
    unit: null,                 // clinical_alerts has no unit column (live events do)
    severity: r.severity,
    message: r.message,
    acknowledged: !!r.acknowledged,
    at: r.created_at,
  }));
}
```
- **Tenant-scoped by explicit `tenant_id = $1::uuid`** (mirrors `orBoardService`; no RLS-GUC dependency). Uses `make_interval(hours => $2::int)` to avoid the bare-param-in-expression pitfall (CLAUDE.md raw-param rule). Explicit columns (no `SELECT *`).
- Normalizes to the WS `vital-anomaly` payload shape (+ `id`/`acknowledged`) so the frontend merges history and live events uniformly. Field mappings: `vital_value`→`value`, `patient_id`→stringified `patientId`, `created_at`→`at`, no `unit`.

### 4.4 Route — `apps/backend/src/routes/clinical/clinicalAlertsRoutes.js` (new)
Mirror the `orBoardRoutes` scaffolding (plain `Router` + `wrap()` + `requireStaffOrAdmin` + `tenantOf = resolveTenantOrThrow`):
```js
router.get('/recent', requireStaffOrAdmin, wrap(async (req) =>
  clinicalAlerts.listRecentAlerts({
    tenantId: tenantOf(req), hours: req.query.hours, limit: req.query.limit,
  })));
```

### 4.5 Mount — `apps/backend/src/app.js`
```js
import clinicalAlertsRoutes from './routes/clinical/clinicalAlertsRoutes.js';
// …near the other clinical mounts (after the /api/v1/icu mount):
app.use('/api/v1/clinical-alerts', requireRole(...CLINICAL_STAFF_ROLES), phiAccessLogger('CLINICAL_ALERTS'), clinicalAlertsRoutes);
```
- **`CLINICAL_STAFF_ROLES`** (already aliased in app.js) = clinical staff + medical leadership; SUPER_ADMIN bypasses `requireRole`. This matches every other clinical board (ICU/OR/lab use their capability-group constant, not generic ADMIN). **Cross-patient board → no `patientAccessGuard`** (mirrors the `/api/v1/theatre … orBoardRoutes` mount). `phiAccessLogger('CLINICAL_ALERTS')` for HIPAA audit of the PHI read.
- **Channel-vs-REST audience note:** the `staff:` channels are broader (`isStaff`) than the `CLINICAL_STAFF_ROLES` REST gate — the same accepted asymmetry as the ICU slice. All REST-authorized users can subscribe (no denial of the live board to its audience); a non-clinical staffer who could subscribe live just won't get history. Not a security gap (the channel already broadcasts to them).

## 5. Frontend design

### 5.1 Feed helper — new `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/feed.ts`
```ts
export const CLINICAL_ALERTS_CHANNEL = "staff:clinical-alerts";
export const CODE_BLUE_CHANNEL = "staff:code-blue";
export const ALERT_FEED_CAP = 200;
export const CODE_BLUE_WINDOW_MS = 15 * 60 * 1000;

export type AlertItem = {
  kind: "vital-anomaly"; id?: number; patientId: string | null;
  vitalName: string | null; value: number | null; unit: string | null;
  severity: string | null; message: string | null; acknowledged?: boolean; at: string;
};
export type CodeBlueItem = {
  kind: "code-blue"; patientId: string | null; bedNumber: string | null;
  ward: string | null; triggeredBy: string | null; reason: string | null; at: string;
};

// Stable de-dup key: prefer the DB id (history); live events have no id → patient|vital|at.
export function alertKey(a: AlertItem): string {
  return a.id != null ? `id:${a.id}` : `live:${a.patientId}|${a.vitalName}|${a.at}`;
}
export function codeBlueKey(c: CodeBlueItem): string { return `${c.patientId}|${c.at}`; }

// Merge live (newest) + history, dedupe by alertKey, sort by `at` desc, cap.
export function mergeAlerts(history: AlertItem[], live: AlertItem[]): AlertItem[] {
  const byKey = new Map<string, AlertItem>();
  for (const a of [...live, ...history]) if (!byKey.has(alertKey(a))) byKey.set(alertKey(a), a);
  return [...byKey.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, ALERT_FEED_CAP);
}
```

### 5.2 Page — `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/page.tsx`
- `useQuery(["clinical-alerts","recent"], () => fetchAdminAPI("/clinical-alerts/recent?hours=8&limit=100"))` → history; `staleTime: Infinity`, no `refetchInterval` (freshness comes from WS).
- `const [liveAlerts, setLiveAlerts] = useState<AlertItem[]>([])`; `const [codeBlues, setCodeBlues] = useState<CodeBlueItem[]>([])`; `const [dismissed, setDismissed] = useState<Set<string>>(new Set())`.
- `const alertsRt = useRealtimeChannel<AlertItem>(CLINICAL_ALERTS_CHANNEL, { onEvent: (m) => setLiveAlerts((p) => [m.data, ...p].slice(0, ALERT_FEED_CAP)) });`
- `useRealtimeChannel<CodeBlueItem>(CODE_BLUE_CHANNEL, { onEvent: (m) => setCodeBlues((p) => [m.data, ...p].slice(0, 50)) });`
- `const feed = mergeAlerts(history, liveAlerts)`.
- **Code-blue banner:** `codeBlues` within `CODE_BLUE_WINDOW_MS` of now and not in `dismissed` → prominent red cards (ward/bed/patient/reason/time + Dismiss → adds `codeBlueKey` to `dismissed`).
- **Alerts feed:** `feed` rows — CRITICAL `red`, WARNING `amber`; show patient/vital/value/severity/message/time; `acknowledged` rows de-emphasized. `EmptyState` when empty ("No alerts yet — live alerts will appear here").
- **Indicator:** from `alertsRt.{connected,subscribed}` → `● Live` (subscribed) / `○ Connecting` (connected, not yet subscribed) / `○ Offline` (neither). `data-testid="clinical-alerts-realtime-indicator"`, `role="status"`, `aria-label`. (No polling fallback exists, so semantics differ from prior slices — there is no "Polling" state.)
- Title "Clinical Alerts & Code Blue"; short subtitle noting it's live (history seeded for the last 8h).

## 6. Tenant scoping & PHI
The REST read filters `tenant_id = $1::uuid` from `resolveTenantOrThrow(req)` (no cross-tenant rows). `phiAccessLogger('CLINICAL_ALERTS')` audits the PHI read. The WS already enforces a per-broadcast tenant filter (the producers run in request/patient tenant context). Payloads carry ids + vital values (already broadcast to staff today); no new PHI surface beyond the auditable REST read.

## 7. Testing
- **Backend** `clinicalAlertsService.test.js` — mock `prisma.$queryRawUnsafe`; assert (a) the query filters `tenant_id`, uses `make_interval`, `ORDER BY created_at DESC`, `LIMIT`; (b) hours/limit clamping (default 8/100, max 72/200); (c) normalization (`vital_value`→`value` number, `patient_id`→string, `unit:null`, `kind:'vital-anomaly'`).
- **Backend** `clinicalAlertsChannel.test.js` — assert `CHANNEL_CATALOG['staff:clinical-alerts']` + `['staff:code-blue']` present with `roles:'staff'`; `authorizeChannel` allows `NURSING_STAFF`/`DOCTOR`/`ADMIN`, denies `PATIENT` for both. (Guards the channels the board depends on.)
- **Frontend** `clinical-alerts/feed.test.ts` — `mergeAlerts` dedupes by id + by live key, sorts `at` desc, caps at 200; `alertKey`/`codeBlueKey` behavior.
- **Frontend** `clinical-alerts/page.test.tsx` — `jest.mock` `useRealtimeChannel` + `@/lib/api`; assert both channels are subscribed (`useRealtimeChannel` called with each channel string), the hydrated history rows render, and the indicator shows `Offline`/`Connecting` vs `Live` by the mock's `{connected,subscribed}`.
- **Honest limit:** live WS push not auto-tested (no WS in jsdom; deploy HELD) — same as every slice. The merge/append logic is covered by `feed.test.ts`.

## 8. Resilience / error handling
- No producers touched → cannot affect a clinical write. The new endpoint is a read-only `SELECT` (no mutation, parameterized, explicit columns, tenant-filtered).
- WS is at-most-once; on reconnect the hook re-subscribes (built-in backoff) and the history query can be refetched to re-seed. Live code-blues are ephemeral (not persisted) — acceptable for the banner.
- The board degrades gracefully: if the hydrate endpoint fails, the live feed still works (empty history); if WS is down, history still shows (indicator `Offline`).

## 9. Verification
- **Gates:** backend `lint` + the new `clinicalAlertsService`/`clinicalAlertsChannel` unit tests; admin `type-check`/`lint`/`test`/`build`.
- **Manual (deploy HELD → local):** open the board (`● Live`); trigger a CRITICAL vital (or `emitCodeBlue`) from a second client → a code-blue banner + a red feed row appear within ~1s; reload → recent alerts re-hydrate from `/clinical-alerts/recent`.

## 10. File-change inventory
- `apps/backend/src/services/clinical/clinicalAlertsService.js` — new (`listRecentAlerts`).
- `apps/backend/src/routes/clinical/clinicalAlertsRoutes.js` — new (`GET /recent`).
- `apps/backend/src/app.js` — import + 1 mount line.
- `apps/backend/src/tests/unit/clinicalAlertsService.test.js` — new.
- `apps/backend/src/tests/unit/clinicalAlertsChannel.test.js` — new.
- `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/feed.ts` — new.
- `apps/admin/src/app/(with-auth)/dashboard/clinical-alerts/page.tsx` — new.
- `apps/admin/src/__tests__/dashboard/clinical-alerts/feed.test.ts` — new.
- `apps/admin/src/__tests__/dashboard/clinical-alerts/page.test.tsx` — new.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Board starts empty / loses state on refresh | The hydrate endpoint seeds the last 8h on load + after reconnect. |
| Channel broader than REST (a staffer subscribes live but 403s on history) | Accepted asymmetry (same as ICU slice); not a security gap — channel already broadcasts to them; board's real audience (`CLINICAL_STAFF_ROLES`) gets both. |
| Cross-tenant leak in the read | Explicit `tenant_id = $1::uuid` filter from `resolveTenantOrThrow`. |
| Raw-param type error on the interval | `make_interval(hours => $2::int)` + `LIMIT $3::int` (CLAUDE.md raw-param rule). |
| Code-blue history missing ward/bed | Documented: code-blue isn't persisted with that context; banner is live-only, feed (with the CRITICAL rows) hydrates. |
| Duplicate rows when a live event later appears in a refetch | `mergeAlerts` dedupes by DB id (history) / patient\|vital\|at (live). |
| Live WS push not auto-tested | Honest limitation (no WS in jsdom); feed merge covered by unit test; manual recipe §9. |
