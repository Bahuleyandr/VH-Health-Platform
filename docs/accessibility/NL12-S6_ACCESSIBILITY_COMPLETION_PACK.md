# NL12-S6 Accessibility Completion Pack

Status: build-ready evidence pack for the manual operator ceremony.
Scope source: `docs/superpowers/specs/2026-07-07-nl12-assurance-plan.md`, slice NL12-6.

## Scope Contract

This pack closes the buildable NL12-S6 surfaces without claiming that by-ear
screen-reader or PDF/UA ceremonies have happened. It covers:

- automated font-scaling and live-region regressions for staff, patient, and admin;
- staff, patient, and admin screen-reader matrix for NVDA, TalkBack, and VoiceOver;
- PDF accessibility acceptance criteria for assessor-facing exports;
- an evidence checklist and operator-board schedule for manual device passes.

Migrations used: 0.

## Automated Coverage

| Client | Gate | What It Pins |
|---|---|---|
| Staff | `apps/staff/test/a11y/screen_reader_plan_test.dart` | OS plus in-app font-scale composition, clamped font preference persistence, reduce-motion skeleton behavior, loading live region, success/error toast live regions. |
| Patient | `apps/patient/test/core/utils/font_scaler_test.dart` and `apps/patient/test/features/accessibility_completion_pack_test.dart` | Patient theme font-size scaling and persistence, reusable live-region snack-bar semantics, visible text unchanged for sighted users. |
| Patient | `apps/patient/test/features/accessibility_named_surfaces_test.dart` | Named high-value semantics for dashboard, status chips, appointment cards, and vitals fields. |
| Admin | `apps/admin/src/__tests__/accessibility/completion-pack.test.tsx` | Dashboard skip link, main/navigation landmarks, mobile drawer dialog semantics, and critical announcement live-region behavior. |

## Screen-Reader Matrix

| Board Slot | Date Window (IST) | Client | Device And Assistive Tech | Required Pass |
|---|---:|---|---|---|
| A11Y-NL12-1 | 2026-08-04 AM | Staff | Windows workstation, Chrome/Flutter desktop, NVDA, keyboard only | Run `apps/staff/docs/SCREEN_READER_TEST_PLAN.md` S1-S12, including Ctrl+K and long-form tab order spot checks. |
| A11Y-NL12-2 | 2026-08-04 PM | Staff | Android ward tablet, TalkBack, largest font, remove animations | Repeat S1-S10 on touch gestures, verify loading/toast announcements, verify no clipped bed-board status pills. |
| A11Y-NL12-3 | 2026-08-05 AM | Patient | Android phone, TalkBack, largest font, remove animations | Login-free shell where possible plus settings font size, dashboard dial, records, bills, TPA claims, vitals, SOS feedback. |
| A11Y-NL12-4 | 2026-08-05 PM | Patient | iPhone, VoiceOver, large text, reduce motion | Repeat patient smoke, confirm patient-safe record labels and PDF-open failure feedback announcements. |
| A11Y-NL12-5 | 2026-08-06 AM | Admin | Windows admin workstation, Chrome, NVDA, keyboard only | Login, skip link, primary navigation, command palette, dashboard announcement banner, export buttons, modal focus return. |
| A11Y-NL12-6 | 2026-08-06 PM | Admin | macOS Safari/Chrome, VoiceOver | Repeat admin navigation and announcement banner, inspect exported PDF text extraction. |
| A11Y-NL12-7 | 2026-08-07 | All | Device that failed first pass | Retest only failed rows, attach evidence and ticket IDs. |

These dates are the Week 4 accessibility slot from
`docs/superpowers/plans/2026-07-07-one-month-execution-plan.md`. Operators may
move the exact clock time, but should preserve the order so staff clinical
workflows go first and the retest window remains available.

## PDF Accessibility Acceptance

Assessor-facing PDFs are acceptable for NL12 evidence only when each checked
export satisfies the criteria below:

| Criterion | Acceptance |
|---|---|
| Text extraction | Body text, headings, table cells, and dates copy as text from the generated PDF. Image-only exports fail. |
| Title and context | First page includes hospital name, report title, reporting window, generation timestamp, and tenant or facility context when applicable. |
| Table headers | Tabular PDFs include visible column headers on every table and do not rely on color alone for status. |
| Reading order | Keyboard or screen-reader reading order follows title, subtitle, KPI strip, then tables. |
| Contrast | Body text and status colors meet WCAG AA contrast against the PDF background. |
| Language | Export path declares or documents the report language; multilingual exports need the language recorded in the evidence row. |
| Sensitive data | PHI appears only when the export purpose requires it, and the evidence row records the purpose and reviewer. |
| Tagged PDF policy | PDF/UA tagging is not claimed until the operator approves a tagging policy and the generator path proves tags in a tool such as PAC, Acrobat Accessibility Checker, or veraPDF. |

## Manual Evidence Template

Create one evidence row per board slot:

| Field | Value |
|---|---|
| Evidence ID | `A11Y-NL12-<slot>-<YYYYMMDD>` |
| Client and build | Staff, patient, or admin build identifier and commit SHA. |
| Device | Model, OS version, browser if applicable, screen-reader version. |
| Settings | Font size, contrast/dark mode, reduce-motion setting, input method. |
| Scenarios run | Link to scenario rows or checklist section. |
| Pass result | Pass, fail, blocked, or retest pass. |
| Defects filed | Ticket or PR links for every failed row. |
| Artifacts | Screen recording, screenshot, exported PDF, or notes. |
| Reviewer | Operator or tester name and timestamp. |

## Completion Checklist

| Item | Required Evidence |
|---|---|
| Staff automated gate | `melos run test` includes `apps/staff/test/a11y/screen_reader_plan_test.dart`. |
| Patient automated gate | `melos run test` includes `apps/patient/test/features/accessibility_completion_pack_test.dart`. |
| Admin automated gate | `npm run test -- --runTestsByPath src/__tests__/accessibility/completion-pack.test.tsx` passes before full admin gates. |
| Cross-client docs | This file plus `apps/staff/docs/SCREEN_READER_TEST_PLAN.md` reference the manual matrix. |
| Operator schedule | A11Y-NL12-1 through A11Y-NL12-7 remain on the Week 4 board until evidence rows are attached. |
| PDF policy | Exported PDFs pass text extraction now; PDF/UA tagging is deferred until the operator-approved tagging policy lands. |
| Deferrals | Manual screen-reader passes, PDF/UA certification, and any failed-device retests are owner ceremonies, not code claims. |
