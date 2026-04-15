# Admin Portal — God-Component Refactoring Plan

Created 2026-04-14 as part of the P1.7 audit follow-up. The initial audit
flagged `system-logs/page.tsx` (445 LOC) and `PermissionsMatrix.tsx` as god
components, but a second pass surfaced larger offenders:

## Actual size leaderboard (LOC per page)

| File | LOC | Priority |
|------|-----|----------|
| `dashboard/payroll/page.tsx` | 1603 | P0 |
| `dashboard/housekeeping/page.tsx` | 1268 | P0 |
| `dashboard/appointments/page.tsx` | 1057 | P0 |
| `dashboard/billing/page.tsx` | 976 | P1 |
| `dashboard/investigations/page.tsx` | 961 | P1 |
| `dashboard/pharmacy/page.tsx` | 889 | P1 |
| `dashboard/audit/page.tsx` | 612 | P2 |
| `dashboard/report-builder/page.tsx` | 589 | P2 |
| `dashboard/attendance-audit/page.tsx` | 566 | P2 |
| `dashboard/system-logs/page.tsx` | 445 | P2 |

Every P0 and P1 file does at least: fetch logic, filter state, modal state,
table rendering, detail drawer, mutation handlers. That's 6+ responsibilities
fused into one file. None of them are testable as-is without rendering the
entire page tree.

## Target component shape

Each god page should decompose into:

```
pages/<domain>/
├── page.tsx                  # Thin: fetches data, composes the pieces
├── components/
│   ├── <Domain>Filters.tsx   # Form state, debounced query
│   ├── <Domain>Table.tsx     # Pure render — props-in, event-out
│   ├── <Domain>DetailSheet.tsx
│   ├── <Domain>CreateModal.tsx
│   ├── <Domain>EditModal.tsx
│   └── use<Domain>Mutations.ts  # TanStack Query hooks
└── types.ts                  # Local types, domain enums
```

Each extracted component should:
- Take its data as props — no direct TanStack Query calls (the page does those).
- Export a minimal event-callback surface (`onFilterChange`, `onSelectRow`, `onSave`).
- Be rendered in isolation under `@testing-library/react` without mocking a full page.

## Extraction order

1. **Start with `housekeeping/page.tsx`** (1268 LOC). It has the clearest
   "table + filter + detail + flag modal + assign modal" split. The Image
   swaps already done for a11y are a natural seam.
2. **`appointments/page.tsx`** (1057 LOC) next — the most-used admin page.
   Heavy modal state.
3. **`payroll/page.tsx`** (1603 LOC) last — most complex, needs someone
   with payroll domain knowledge.

For each, expected delta: the page file shrinks to **<150 LOC** (fetch +
compose), with 5–8 extracted components in `./components/`.

## Testing infrastructure (added 2026-04-14)

- **Playwright E2E**: scaffolded at `e2e/`. Top journeys:
  1. `auth.spec.ts` — login → dashboard redirect → logout
  2. `appointments-list.spec.ts` — filter + paginate + open detail
  3. `pharmacy-queue.spec.ts` — confirm order lifecycle
  4. `compliance-dashboard.spec.ts` — SLA breach tile renders
  5. `user-management.spec.ts` — create + deactivate admin user
  
  Run: `npx playwright test` (requires `npm run dev` running, or
  `webServer` config — see `playwright.config.ts`).

- **Vitest/Jest unit tests** for extracted components should land per-refactor
  PR. Minimum: one test per extracted component rendering once with mock data,
  one test per callback firing correctly.

## Anti-patterns to avoid while refactoring

1. **Don't extract just for the sake of smaller files.** If a component is
   used in only one place and the props interface is wider than 6 fields,
   that's a suggestion that the cut is wrong — try a different seam.
2. **Don't leak Query keys across components.** Put mutations in a
   `use<Domain>Mutations.ts` hook so the invalidation list is one source of truth.
3. **Don't turn all modals into context providers.** Local `useState` for
   open/close + typed detail object is fine and more testable.
4. **Don't rewrite inline.** Ship the old page behind a feature flag if
   the refactor touches a load-bearing flow; cut over only after the new
   pieces have Playwright coverage.

## What's explicitly out of scope for now

- React Server Components conversion — pages are `"use client"` for a reason
  (TanStack Query + auth cookies). Don't fight that without a holistic plan.
- Micro-frontends — 60 routes do not need module federation.
- Storybook — nice-to-have, but lower ROI than Playwright right now.
