# Mobile List Consistency Audit

Updated: 2026-05-05

## Standard

Patient and staff Flutter lists should not use desktop table patterns. Primary mobile lists should provide:

- Search or quick filters for long lists.
- Pull-to-refresh or a visible refresh action for data that changes during a shift.
- Empty, loading, and error states that explain what happened.
- Primary actions that remain reachable without horizontal overflow.
- Large enough tap targets for phones and ward-floor tablets.

## Current Direction

- Staff app daily-use screens should prioritize today's work: appointments, beds, due medications, notifications, notes, and handover.
- Lower-frequency staff flows such as leave, payroll, replacements, and profile settings should remain available, but not crowd the first screen.
- Patient app daily-use screens should prioritize appointment booking/status, prescriptions, uploads, medication reminders, investigation bookings, and support/SOS.

## Implementation Backlog

- Staff: sweep Appointments, Bed Board, Due Meds, Notifications, Handover, Nursing Notes, and Patient Picker for search/filter/refresh/empty/error parity.
- Staff: verify leave/payroll/replacement screens are nested behind day-to-day work and do not dominate the home screen.
- Patient: sweep Appointments, Uploads, Prescriptions, Medication Reminders, Investigation Booking, Profile Setup, and SOS nearby services for the same mobile list standard.
- Both apps: add widget-level tests for empty/error/loading list states on the highest-use screens.
- Both apps: run screen-size checks for phone and tablet widths so action buttons do not require horizontal overflow.

## Production Caveat

This is a UX guardrail document, not a clinical sign-off. Clinical, medication, investigation, billing, and emergency wording still needs fluent human review in every supported language before production rollout.
