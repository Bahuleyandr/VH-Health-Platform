# Patient App Roadmap — A+/S-Tier

> Source of truth for next-step work. Born from a full-repo audit. Update as items land.

**Current grade:** B+. Feature-rich, just got the Visual Health Intelligence overhaul (wellness score, lab gauges, daily check-in, Rx rings, insights, achievement badges). Gaps are: smoke-only tests, god-files, hardcoded `Colors.*`, missing jailbreak detection, unused `cached_network_image` dep.

---

## Phase 1 — A+ Security Floor (in progress)

- [x] **Jailbreak/root detection.** Add `flutter_jailbreak_detection: ^1.10.0`. Use shared `DeviceIntegrityService` from `vhhealth-core`. Hard-block in release build on compromised device. Wire into `lib/features/splash/`.
- [x] **Hardcoded `Colors.*` → `theme.colorScheme.*`.** Grep `Colors\.(red|white|black|grey)` outside theme files — 10+ hits. `lib/core/navigation/app_router.dart` L359 is the starting point.
- [x] **Wire `CachedNetworkImage`.** Dep is in pubspec but never imported. Replace every `Image.network(...)` — pharmacy order list, records, profile avatars, doctor photos.
- [ ] **God-file split — dashboard.** `lib/features/dashboard/screens/dashboard_screen.dart` (1322L). Extract 6 private widget classes at bottom (`_TodayAppointmentCard`, `_SmartPharmacyCard`, `_SmartInvestigationCard`, `_SmartPrescriptionCard`, `_AppointmentCard`, `_QuickActionButton`, `_LanguageMenuButton`) into `lib/features/dashboard/widgets/`.
- [ ] **God-file split — health points.** `lib/features/gamification/screens/health_points_screen.dart` (1219L). Each `_buildXTab` → dedicated widget file.

## Phase 2 — A+ Polish

- [ ] **Test coverage ≥60%.** Integration tests for appointment booking, pharmacy checkout flow, offline sync, vitals log → wellness score recompute.
- [ ] **Localization coverage.** 5 languages declared (en/hi/ta/te/ml) but ~52% of regional strings missing. Audit with `flutter gen-l10n --untranslated-messages-file`.
- [ ] **Accessibility.** `Semantics` wrappers on interactive widgets, ≥4.5:1 contrast in dark mode, `TextScaler.linear` support everywhere.
- [ ] **JWT refresh flow.** Currently relies on 401 redirect to login. Add refresh token storage + silent refresh in `core/services/api_client.dart`.
- [ ] **Analytics event coverage.** Instrument key funnels (appointment booked, Rx ordered, vitals logged, check-in completed, badge earned).
- [ ] **Dashboard UX.** `Expanded(flex: 3)` dial compresses when new widgets (wellness score, insights, check-in) stack above. Wrap above-dial area in `SingleChildScrollView`.

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
