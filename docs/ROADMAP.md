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

### 3C. Apple HealthKit + Google Fit sync
Add `health: ^10.x`. Background sync steps/HR/sleep/SpO2 → `POST /health/patient/vitals` with `source: 'healthkit'`. Updates wellness score live (no form entry). Push prescription + vitals-goal reminders back to wrist via `flutter_health` write APIs. **This is the single most visible S-tier feature for patients.**

### 3A (patient slice). Live queue position
Connect to backend Socket.IO. Show "Dr. is 3 patients away — est. 12 min" on appointment day. Replace `_TodayAppointmentCard` polling.

### 3G. AI symptom checker (chatbot)
Claude API integration behind `/chatbot`. System prompt produces structured differential. Auto-fills appointment booking form with symptom summary for doctor context. Triage decision: "see doctor now / self-care / urgent care".

### 3E (patient slice). CDS visibility
Show "why this was prescribed" + alternatives on Rx detail sheet. Surface allergy warnings inline on `your_health/prescriptions_tab`.

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
