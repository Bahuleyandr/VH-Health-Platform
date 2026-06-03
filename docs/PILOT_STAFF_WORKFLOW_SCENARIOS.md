# Staff Pilot Workflow Scenarios

This is the manual pilot script for hospital staff validation. The automated
role sweep proves API contracts; this document catches workflow, wording,
permissions, and usability failures that automation will miss.

Record every failure with role, screen, action, expected result, actual result,
severity, screenshot/video, backend request ID if visible, and whether the issue
blocks pilot use.

## Pilot Roles

- Nursing: `EMP-1001`
- Pharmacy: `EMP-1002`
- Lab: `EMP-1003`
- Doctor: `EMP-1004`
- HR: `EMP-1005`
- Admin: `EMP-1006`
- Super admin: `EMP-1007`
- General staff: `EMP-1008`
- Receptionist: `EMP-1009`

## Scenarios

1. Receptionist login, open Front Office Workbench, verify Today/Tomorrow/
   Following day queues and patient search load without 403/429 noise.
2. Receptionist Front Office: create a walk-in appointment using an existing patient
   phone number and confirm the patient name is pulled from backend.
3. Receptionist Front Office: create a walk-in appointment for a new phone number and
   confirm a patient record is created.
4. Receptionist Front Office: open the selected patient context, create a draft
   OP invoice, and confirm the Billing panel reflects the same patient.
5. Receptionist Admissions: create a routine IP admission with a non-ICU bed and
   verify the patient appears on Active Admissions/Patient Command Board. ICU
   bed assignment should remain escalated to Doctor/ICU nurse/Admin.
6. Nursing login, check-in, verify dashboard attendance changes immediately.
7. Nursing Appointment Queue: open today's queue, open the patient, add nursing
   notes, return without losing context.
8. Nursing OP lab booking: book a CBC for the walk-in patient and confirm it
   appears in lab queue.
9. Nursing OP pharmacy: open pharmacy orders and verify unauthorized actions are
   hidden or rejected cleanly.
10. Nursing patient records: upload a prior record photo/file and verify it is
   visible in records.
11. Nursing IP Services: open bed board, choose a bed, open inpatient context,
   and navigate to lab/pharmacy/dietary actions.
12. Doctor login, check dashboard appointment count against Appointments page.
13. Doctor OP queue: open a patient, enter consultation notes, diagnosis, and
    advice.
14. Doctor prescription: create e-prescription with one medication and follow-up
    date; verify it appears in recent prescriptions.
15. Doctor IP bed board: open admitted patient, enter progress note, verify note
    is immutable/audited after save.
16. Pharmacy login: open new orders, active orders, done orders; no 403 should
    be shown for permitted queues.
17. Pharmacy: create or accept a pharmacy order from a prescription-backed flow,
    progress it through active and done.
18. Lab login: open lab bookings, create or accept a booking, mark sample
    collected, upload/enter result.
19. Lab: verify OP and IP bookings are visibly distinguishable.
20. HR login: open HR dashboard, leave balance, shift view, replacement
    requests, and payslips without 500/403 noise.
21. Admin login: search staff/users, edit a user, change rows per page, verify
    narrow-window action buttons remain reachable.
22. Super admin: open database viewer, verify tables load with redacted
    sensitive columns and read-only behavior.
23. General staff: verify only permitted HR/profile/notification surfaces are
    visible and restricted actions fail closed.
24. All roles: toggle dark/light mode; text, More Tools, and icon buttons remain
    visible.
25. All roles: press Back on every primary screen and verify navigation returns
    to the previous workflow, not a blank/root crash.
26. All roles: logout and re-login; no stale role data appears.
27. Offline/poor network: disconnect briefly, open a daily workflow, reconnect,
    and verify error and retry states are understandable.
28. Narrow desktop window: verify OP/IP tabs, lists, actions, and forms do not
    clip horizontally.
29. Accessibility spot-check: keyboard tab order reaches primary actions on the
    dashboard, queues, and forms.
30. Audit spot-check: saved clinical notes, prescriptions, uploads, and queue
    transitions leave backend audit evidence.
31. Security spot-check: a lower-privilege role cannot open admin/database,
    payroll admin, or unrelated clinical actions by direct navigation.
32. Clinical AI pilot: Doctor and Pharmacy review a medication reconciliation
    draft, verify it is labelled as AI-generated, inspect citations/safety
    state, and accept or edit with a reviewer note before signoff.
33. Clinical AI pilot: Nursing reviews patient aftercare instructions, verify a
    fallback/template state is visibly labelled when AI is unavailable or
    disabled, edit as needed, and sign with a reviewer note.
34. Clinical AI pilot evidence: Admin exports the pilot evidence pack for
    `medication_reconciliation` and `patient_aftercare_instructions`, confirms
    tenant, blockers, eval gate, human review, audit trail, and redaction
    sections, then attaches the export to the pilot record.

## Exit Criteria

- No P0/P1 pilot blockers remain open.
- Each daily role can complete its top three workflows without a visible 500,
  403, blank screen, or wrong patient/doctor binding.
- Clinical, security, and financial wording has human validation for the locale
  used in pilot.
- The automated staff role workflow sweep is attached to the pilot record.
- The Clinical AI pilot evidence-pack smoke is green and its export is attached
  to the pilot record before any wider rollout.
