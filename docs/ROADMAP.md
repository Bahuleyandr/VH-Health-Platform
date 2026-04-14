# Staff App Roadmap — A+/S-Tier

> Source of truth for next-step work. Flutter app for hospital staff (doctors, nurses, pharmacists, lab techs, ward staff).

**Current grade:** B. Solid offline-first architecture (OfflineQueue, ConnectivitySyncService), broad feature coverage (25 features), but missing critical clinical safety primitives: no MAR barcode verification, no Code Blue push, freeform handover, only 3 tests.

---

## Phase 1 — A+ Security Floor ✅

- [x] **Jailbreak/root detection.** Via `DeviceIntegrityService` from `vhhealth-core`.
- [x] **Offline sync UX.** `ConnectivitySyncService` now a `ChangeNotifier` exposing `isOnline`, `isSyncing`, `pendingCount`, `conflictCount`. New `OfflineSyncBadge` widget (compact priority-sorted pill: conflicts > syncing > offline > pending) wired into `StaffScaffold` app-bar. Tap opens `SyncStatusSheet` listing conflicts with **Discard** / **Retry** per item. `vitals_screen` + `nursing_notes_screen` migrated from `OfflineQueue.enqueue` → `ConnectivitySyncService.instance.enqueue` so counts stay fresh.

## Phase 2 — A+ Polish

- [ ] **Test coverage ≥60%.** Currently 3 tests (login + config smoke). Add: MAR submit, handover post, vitals entry, order create, offline → online sync. *Deferred.*
- [ ] **Tablet/iPad layouts.** Responsive only; no split-pane. Critical for ward rounds (patient list | EMR | vitals entry in one view). *Deferred — design-intensive.*
- [ ] **Dark mode coverage.** Partial today. Audit all screens.
- [x] **Device-lockout UX on login.** Login screen now detects backend lockout messages and renders a distinct amber lock card ("Account temporarily locked"/try again in 15 min/contact supervisor) instead of the generic red error. Backend returns only the message string today; structured retry-after fields are a future enhancement.

## Phase 3 — S-Tier Marquee

### 3D. Medication Administration Record (MAR) with 5-rights barcode verification ✅ (2026-04-14)
Layered onto the existing `medication_administrations` table + `/clinical/mar/*` routes (already had schedule/administer/miss/hold).
- Backend migration `004_*.sql` adds scanned_patient_uid, scanned_barcode, rights_passed jsonb, all_rights_passed, override_reason, medication_index columns.
- `services/clinical/marFiveRightsService.js#evaluate5Rights` computes patient/drug/dose/route/time rights (±60min window for scheduled meds).
- `POST /clinical/mar/verify` dry-runs the rights check; `POST /clinical/mar/:id/administer-with-scan` commits with audit. 409 on rights failure w/o override, with `details.rights` so the client drives the override UX.
- Staff: `features/nursing/screens/mar_scan_screen.dart` — linear state machine (wristband → drug → verify → done) using `mobile_scanner` (new dep). Pass `ma_id` in constructor from a due-meds list; override reason required ≥5 chars.
- **Still open:** "due meds" list screen that feeds `ma_id` to this screen, and drug-DB-backed NDC lookup (current drug check is substring match on medication_name).

### 3A (staff slice). Live patient census board + Code Blue ✅ (partial, 2026-04-14)
- `core/widgets/code_blue_listener.dart` — overlay mounted inside `StaffScaffold`. Subscribes to `staff:code-blue`; on event, shows a blocking red full-screen dialog (ward/bed/patient/reason + "ACKNOWLEDGED" button). Also doubles as the app-wide `RealtimeClient.connect()` entry point.
- `features/beds/screens/bed_board_screen.dart` — subscribes to `staff:beds` and debounced-refetches the current ward on each event.
- **Loose end closed (2026-04-14):** Code Blue wake-from-background wired via FCM full-screen intent. New `core/services/code_blue_notifier.dart` uses `flutter_local_notifications` (new dep) to register a MAX-importance `code_blue` channel and fires a notification with `fullScreenIntent: true` + `category: alarm` + `ongoing: true`. `main.dart` registers `_fcmBackgroundHandler` (top-level `@pragma('vm:entry-point')`) via `FirebaseMessaging.onBackgroundMessage` so the notification shows even when the app is terminated. Backend `emitCodeBlue` fans a high-priority FCM to `staff_devices.device_token`.
- **Platform config required before first build:** Android manifest must add `<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT"/>` and on Android 13+ `POST_NOTIFICATIONS`; Android 14+ requires runtime grant of the full-screen intent permission. iOS Critical Alerts entitlement needed if `interruption-level: critical` should bypass silent mode. These must be added when `flutter create .` scaffolds the `android/` directory.
- **Still open:** floor-map visualisation of the census board (no architectural blocker; design-heavy).

### 3E (staff slice). Structured handover (SBAR)
Current `HandoverScreen` (343L) is freeform notes. Enforce Situation / Background / Assessment / Recommendation fields. Add witness signature capture (`signature` package or `image_picker`-based drawing canvas). Multi-witness sign-off for critical patients.

### 3E'. Prescribing with CDS hard-block ✅ (2026-04-14)
`PrescriptionsScreen._submit` now POSTs `/prescriptions/safety-check` before create. On non-empty blockers, `features/doctor/widgets/cds_blocker_modal.dart` shows a blocking modal listing blockers + warnings with Cancel / Override options. Override requires a ≥5-char reason; allergy blockers additionally prompt the clinician to reference their supervising physician in the reason text. Override payload is attached to the subsequent create call; backend persists the audit row.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md`.
- Conventions: [CLAUDE.md](../CLAUDE.md).
