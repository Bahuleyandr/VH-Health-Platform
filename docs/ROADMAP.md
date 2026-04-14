# Patient App Roadmap — A+/S-Tier

> Source of truth for next-step work. Born from a full-repo audit. Update as items land.

**Current grade:** B+. Feature-rich, just got the Visual Health Intelligence overhaul (wellness score, lab gauges, daily check-in, Rx rings, insights, achievement badges). Gaps are: smoke-only tests, god-files, hardcoded `Colors.*`, missing jailbreak detection, unused `cached_network_image` dep.

---

## Phase 1 — A+ Security Floor ✅

- [x] **Jailbreak/root detection.** `DeviceIntegrityService` from `vhhealth-core` wired into splash.
- [x] **Hardcoded `Colors.*` → `theme.colorScheme.*`.** Swept.
- [x] **Wire `CachedNetworkImage`.** Replaced `Image.network(...)` in pharmacy, records, profile, doctor photos.
- [x] **God-file split — dashboard.** `dashboard_screen.dart` 1329→688L. Seven widgets extracted to `lib/features/dashboard/widgets/` (quick_action_button, today_appointment_card, language_menu_button, appointment_card, smart_pharmacy_card, smart_investigation_card, smart_prescription_card).
- [x] **God-file split — health points.** `health_points_screen.dart` 1219→371L. Four tabs + painter extracted under `lib/features/gamification/widgets/` (overview_tab with TierRingPainter, milestones_tab, rewards_tab, history_tab) + `utils/tier_utils.dart` for shared helpers.

## Phase 2 — A+ Polish

- [ ] **Test coverage ≥60%.** Integration tests for appointment booking, pharmacy checkout flow, offline sync, vitals log → wellness score recompute. *Deferred — dedicated session.*
- [ ] **Localization coverage.** 5 languages declared (en/hi/ta/te/ml) but ~52% of regional strings missing. Audit with `flutter gen-l10n --untranslated-messages-file`. *Deferred — needs tool output.*
- [ ] **Accessibility.** `Semantics` wrappers on interactive widgets, ≥4.5:1 contrast in dark mode, `TextScaler.linear` support everywhere. *Deferred — per-screen survey.*
- [x] **JWT refresh flow.** `ApiClient` now does single-flight refresh on 401 (mirrors `vhhealth_core.VHHttpClient`). POSTs to `/auth/refresh-token`, stores new token, retries the original request once; falls back to `onSessionExpired` callback on refresh failure.
- [ ] **Analytics event coverage.** Instrument key funnels (appointment booked, Rx ordered, vitals logged, check-in completed, badge earned).
- [x] **Dashboard UX.** Above-dial widgets wrapped in `SingleChildScrollView`; dial now fixed at `screenHeight * 0.42` so it never compresses as wellness/insights/gamification widgets stack.

## Phase 3 — S-Tier Marquee

### 3C. Apple HealthKit + Google Fit sync ✅ (foreground slice, 2026-04-14)
- `core/services/health_sync_service.dart` — singleton. `requestPermissions()` prompts for the plugin's 6 read types (HEART_RATE, BLOOD_OXYGEN, STEPS, WEIGHT, BODY_TEMPERATURE, SLEEP_ASLEEP). `syncNow()` is silent — uses `hasPermissions()` check and returns 0 if not granted (safe to call on every app resume). `startForegroundSync()` runs a 30-min `Timer.periodic`.
- `main.dart#didChangeAppLifecycleState` fires `syncNow()` on resume.
- Settings → "Connect wearables" tile grants permissions + starts the timer.
- Backend migration `005_*.sql` adds `source` + `recorded_at_source` to `patient_vitals`. `POST /health/patient/vitals` accepts `source` and `recordedAtSource`. New `GET /health/patient/:id/sync-status` returns `{lastSyncBySource}` so the app can reconcile after a reinstall.
- **Still open:** true background sync via `workmanager` (current foreground timer dies when app is backgrounded). Android Health Connect manifest permissions + iOS `NSHealthShareUsageDescription` entry in Info.plist. Wrist write-back for medication reminders + vitals goals.

### 3A (patient slice). Live queue position ✅ (2026-04-14)
`today_appointment_card.dart` converted to a StatefulWidget subscribing to the `queue-position` personal event via `RealtimeClient` (from `vhhealth_core`). Shows "Dr. is N patients away — est. M min" (or "You're next") inline under the existing status row when a live event arrives; falls back silently to the static card otherwise. Backend drives fan-out from `appointmentStatusController` on IN_PROGRESS/COMPLETED/CANCELLED/NO_SHOW transitions.

### 3G. AI symptom checker (chatbot) ✅ (2026-04-14)
Backend `services/chatbot/triageService.js` wraps Anthropic Messages API with a cacheable system prompt that produces a structured `{triage, differential, summary, redFlags}` response. `POST /chatbot/triage` pulls the authenticated patient's age/sex/allergies server-side so the model has context without the user restating it. Patient app `features/chatbot/screens/symptom_checker_screen.dart` — free-text entry, triage visualisation (self_care / see_doctor_now / urgent_care), differential list, red-flag list, and "Book an appointment" shortcut that pre-fills the reason.
**Background sync landed 2026-04-14.** `HealthSyncService.enableBackgroundSync()` registers a 15-min `workmanager` periodic task with `NetworkType.connected` + `requiresBatteryNotLow` constraints. Top-level `healthSyncBackgroundDispatcher` (with `@pragma('vm:entry-point')`) runs the silent `syncNow` in a background isolate. Settings "Connect wearables" tile now enables background sync after granting perms.

**Provider-agnostic.** Backend `triageService` speaks either Anthropic Messages API or any OpenAI-compatible chat-completions server (Ollama / vLLM / llama.cpp server / LM Studio / local OpenAI proxy). Configure via env:
- `CHATBOT_PROVIDER` — `anthropic` (default) | `openai`
- `CHATBOT_BASE_URL` — e.g. `http://ollama.internal:11434/v1` for self-hosted, `https://api.anthropic.com` for Anthropic
- `CHATBOT_MODEL` — model identifier (defaults per provider)
- `CHATBOT_API_KEY` — optional for self-hosted backends without auth; required for Anthropic (also accepts `ANTHROPIC_API_KEY` for back-compat).

Structured response contract (`{triage, differential, summary, redFlags}`) is identical across providers; patient app is unchanged.

### 3E (patient slice). CDS visibility ✅ (partial, 2026-04-14)
Inline `_SafetyContextBanner` added to the Rx detail sheet in `your_health/prescriptions_tab.dart`. Fetches `/prescriptions/:id/safety`, renders allergy warnings and any clinician override reasons on file so patients see prescribing rationale. Indication is still shown via the existing `diagnosis` section.

**Still open:** explicit "alternatives" surfacing requires a drug-similarity source the backend doesn't yet have.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

Pick any unchecked item, reference it by its bullet text, and Claude can pick up the thread.

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md`.
- Conventions: [CLAUDE.md](../CLAUDE.md).
- Visual overhaul: commit `c2b0910` (wellness score, gauges, rings, badges, insights).
