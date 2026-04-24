# God-page refactoring sketches — appointments + payroll

> **✅ BOTH SKETCHES LANDED** — appointments/page.tsx is 82 LOC and
> payroll/page.tsx is 62 LOC on main (both split pre-monorepo-merge on
> 2026-04-18). Subsequent god-splits applied the same pattern to
> ComplianceTab.tsx (batch 33), system-logs/page.tsx (batch 39), and
> audit/page.tsx (batch 40). This sketch is preserved for reference on
> how the pattern was derived, not as a live to-do list.

Companion to `REFACTORING_PLAN.md`. Pre-cut decomposition for the two
largest god pages, derived by greping for top-level `function` declarations.
The same pattern proven on housekeeping (1268→65 LOC), pharmacy (889→58),
investigations (961→56), billing (976→50) applies.

---

## `appointments/page.tsx` (1057 LOC) — 8 components

Section markers found via `grep -n "^function" page.tsx`:

| LOC range | Function | Goes into |
|-----------|----------|-----------|
| 55-100 | `isObj`, `normalizeAppointmentsResponse`, `fmtDate`, `fmtDateTime`, `StatusBadge` | `components/helpers.tsx` |
| 102-247 | `SlaOverviewTab` | `components/SlaOverviewTab.tsx` |
| 249-369 | `AllAppointmentsTab` | `components/AllAppointmentsTab.tsx` |
| 371-472 | `DocumentsTab` | `components/DocumentsTab.tsx` |
| 474-664 | `PrescriptionsTab` | `components/PrescriptionsTab.tsx` |
| 666-729 | `AuditTrailTab` | `components/AuditTrailTab.tsx` |
| 731-819 | `WalkInDialog` | `components/WalkInDialog.tsx` (or co-located in DoctorQueueTab) |
| 821-931 | `DoctorQueueTab` | `components/DoctorQueueTab.tsx` |
| 933-984 | `SlotAvailabilityPanel` | co-located in `DoctorQueueTab.tsx` (only consumer) |
| 986-994 | `TABS` constant | inline in `page.tsx` |
| 997-1049 | `AppointmentsPageContent` | merged into `page.tsx` |

**Target page.tsx LOC:** ~70.

**Watch-out:** `AllAppointmentsTab` uses the helper `normalizeAppointmentsResponse`
which has a tricky union-type unwrap. Move it into `helpers.tsx` exactly
as-is; do not "improve" the typing.

---

## `payroll/page.tsx` (1603 LOC) — 9 components

Section markers found via `grep -n "^function" page.tsx`:

| LOC range | Function | Goes into |
|-----------|----------|-----------|
| 40-86 | `unwrap`, `MONTHS`, `fmtMonth`, `fmtCurrency`, `fmtDate`, `statusBadge` | `components/helpers.tsx` |
| 89-114 | `Modal` | `components/Modal.tsx` (used by every tab) |
| 118-302 | `PayrollRunsTab` | `components/PayrollRunsTab.tsx` |
| 304-556 | `SalaryConfigTab` | `components/SalaryConfigTab.tsx` |
| 560-1131 | `RevisionsTab` (largest single tab) | `components/RevisionsTab.tsx` |
| 1150-1448 | `ToolsTab` | `components/ToolsTab.tsx` |
| 1450-1457 | `LeaveEncashmentToolWidget` | co-located in `ToolsTab.tsx` |
| 1461-1513 | `PayrollPage` (orchestrator) | becomes `page.tsx` body |
| 1522-end | `RunActions` | `components/RunActions.tsx` (used by PayrollRunsTab) |

**Target page.tsx LOC:** ~80. (Slightly higher than the others because
payroll has 4 tabs and the tab-bar component is more elaborate.)

**Watch-outs:**
1. `RevisionsTab` is **571 LOC** by itself — the heaviest single component
   in the whole admin portal. Consider splitting further into:
   - `RevisionsTab.tsx` — table + filters + state
   - `RevisionFormModal.tsx` — the create/edit form (probably 200+ LOC)
   - `RevisionApprovalActions.tsx` — HR-sign → Admin-sign → finalise buttons
2. `RunActions` (the multi-step approval component) is shared between
   `PayrollRunsTab` and `RevisionsTab`. Pull it into a shared file from day 1.
3. `Modal` is used by every tab. Put it in `components/Modal.tsx` first.
   Every other extraction gets simpler once it's available.

---

## Suggested PR sequence

1. **PR 1 (smallest, lowest risk):** appointments. ~70 LOC page.tsx,
   8 component files, ~1100 LOC total. 1-2 hours.
2. **PR 2:** payroll-helpers + Modal + PayrollRunsTab + SalaryConfigTab.
   Ships ~600 LOC of refactor without touching the heavy `RevisionsTab`.
3. **PR 3:** RevisionsTab split (3 files). Highest-risk because the form
   has the most state — extract incrementally, one prop bag at a time.
4. **PR 4:** ToolsTab + RunActions + final `payroll/page.tsx` thinning.

Each PR should ship with a Playwright smoke test against the affected
route (login → navigate → render → no console errors). The
`playwright.config.ts` + `e2e/smoke.spec.ts` scaffold is already in place.

---

## Why these aren't done in this session

Pure execution work, but each is 30-90 minutes of careful reading + writing
+ type-checking. The pattern is fully validated on 4 pages already; the
remaining 2 are mechanical applications of the same recipe. Sketched here
so the next contributor (or a future session) can hit the ground running
without re-discovering the seams.
