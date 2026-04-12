# Staff App Roadmap — A+/S-Tier

> Source of truth for next-step work. Flutter app for hospital staff (doctors, nurses, pharmacists, lab techs, ward staff).

**Current grade:** B. Solid offline-first architecture (OfflineQueue, ConnectivitySyncService), broad feature coverage (25 features), but missing critical clinical safety primitives: no MAR barcode verification, no Code Blue push, freeform handover, only 3 tests.

---

## Phase 1 — A+ Security Floor (in progress)

- [x] **Jailbreak/root detection.** Add `flutter_jailbreak_detection: ^1.10.0`. Use shared `DeviceIntegrityService` from `vhhealth-core`. Hard-block release build on compromised device. Wire into splash/login.
- [ ] **Offline sync UX.** `OfflineQueue` + `ConnectivitySyncService` exist but no UI indicator — staff unaware when syncing or when conflicts occur. Add persistent badge + conflict-resolution sheet.

## Phase 2 — A+ Polish

- [ ] **Test coverage ≥60%.** Currently 3 tests (login + config smoke). Add: MAR submit, handover post, vitals entry, order create, offline → online sync.
- [ ] **Tablet/iPad layouts.** Responsive only; no split-pane. Critical for ward rounds (patient list | EMR | vitals entry in one view).
- [ ] **Dark mode coverage.** Partial today. Audit all screens.
- [ ] **Device registration + quick-login lockout.** Staff auth has `_checkStaffLockout` on backend but app doesn't surface lockout state clearly.

## Phase 3 — S-Tier Marquee

### 3D. Medication Administration Record (MAR) with 5-rights barcode verification
Add `mobile_scanner: ^5.x`. Flow: scan patient wristband → scan drug barcode → backend validates right patient / right drug / right dose / right route / right time → prompt for override reason on mismatch → audit log. Backend needs new `medication_administration_record` table + `/mar` routes. **Cuts medication errors ~50%; #1 clinical-safety marketable feature.**

### 3A (staff slice). Live patient census board + Code Blue
Connect to backend Socket.IO. Floor-map of bed occupancy, patient status (stable/critical), handover time, location. Foreground service + full-screen notification on Code Blue / sepsis alert. Firebase messaging is already imported but unused for clinical emergencies.

### 3E (staff slice). Structured handover (SBAR)
Current `HandoverScreen` (343L) is freeform notes. Enforce Situation / Background / Assessment / Recommendation fields. Add witness signature capture (`signature` package or `image_picker`-based drawing canvas). Multi-witness sign-off for critical patients.

### 3E'. Prescribing with CDS hard-block
Extend `PrescriptionsScreen` (1252L). Backend `prescriptionSafetyCheck.js` already runs — surface its `blockers[]` as modal before save. Override requires text reason + supervisor approval for allergy conflicts.

---

## How to resume in a new Claude session

```
cat docs/ROADMAP.md
```

## Related files

- Audit source: plan `/root/.claude/plans/calm-kindling-wirth.md`.
- Conventions: [CLAUDE.md](../CLAUDE.md).
