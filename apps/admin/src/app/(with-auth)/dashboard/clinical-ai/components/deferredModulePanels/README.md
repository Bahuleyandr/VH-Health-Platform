# deferredModulePanels — Phase-2 clinical-AI panel spec

Home for the 27 new clinical-AI admin panels. Phase 1 laid the foundation
(shared review-queue, generic API helpers, two sample panels); Phase 2
fills this directory with one file per tracker row.

## Directory layout

```
apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/
  ClinicalAIReviewQueue.tsx      # shared review queue (simple panels)
  deferredModulePanels/
    README.md                    # this file
    CybersecurityAnomalyPanel.tsx   # SAMPLE — simple list+decide
    PharmacogenomicsPanel.tsx       # SAMPLE — two-tier (genotypes + advisories)
    <YourModule>Panel.tsx
```

Shared generic API helpers live at:

```
apps/admin/src/lib/api/clinicalAiGeneric.ts
  listClinicalAi(path, params)       -> GET  + envelope { count, <rowsKey> }
  decideClinicalAi(path, id, decision, note?) -> PATCH {path}/:id body { decision, note }
  evaluateClinicalAi(path, body)     -> POST arbitrary body
```

These thin wrappers copy the exact fetch pattern the bespoke helpers in
`apps/admin/src/lib/api/emr.ts` use (see
`listAntimicrobialStewardshipReviews` / `decideAntimicrobialStewardshipReview`
for the canonical example). No new fetch abstraction.

## Two kinds of panels

### 1. Simple — `ClinicalAIReviewQueue` config

Use when the module is list + optional filters + optional stats + decide.
The shared queue handles TanStack Query wiring, filter state, KPI strip,
table rendering, and decide mutations. You write a config object and one
default export.

### 2. Two-tier — bespoke composition

Use when the module has more than one table / an upsert form / registry
plus records (e.g. `pharmacogenomics_support` has a genotype registry
_and_ an advisory queue). Wrap both halves in a single top-level panel
component named after the module. The "records" half can still use
`ClinicalAIReviewQueue` via its `evaluateForm` slot; the bespoke half
talks directly to `listClinicalAi` / `evaluateClinicalAi` inside a
`useQuery` / `useMutation` pair.

## Checklist for each new panel

1. Create
   `apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/deferredModulePanels/<Name>Panel.tsx`.
2. Export a **default** React component that takes **no props**.
3. Use `listClinicalAi` / `decideClinicalAi` / `evaluateClinicalAi` from
   `@/lib/api/clinicalAiGeneric`, keyed by the backend path (e.g.
   `/admin/clinical-ai/security-anomalies`). Do **not** create per-module
   helpers in `emr.ts` — that's exactly the duplication this foundation
   avoids.
4. Reference the tracker row in a top-of-file comment for audit trail.
   Also note the relevant routes in
   `apps/backend/src/routes/admin/clinicalAiRoutes.js` and the service
   file (e.g. `apps/backend/src/services/ai/<module>Service.js`).
5. Add a direct dynamic import to `ClinicalAiExpansionPanels.tsx` using
   `deferredPanel(() => import("./deferredModulePanels/<Name>Panel"))`. Do
   **not** add a barrel: it would make the heavy panel graph statically
   reachable and defeat route-level chunking.

### Naming conventions

- Panel component name = `PascalCase(module_key) + "Panel"`.
  - `cybersecurity_anomaly_detector` → `CybersecurityAnomalyPanel`.
  - `pharmacogenomics_support` → `PharmacogenomicsPanel`.
- For two-tier modules, wrap both halves in a single top-level panel
  named after the module. Nested sub-components live in the same file
  unless they cross ~200 LOC.

### Backend paths

Each module's routes live in
`apps/backend/src/routes/admin/clinicalAiRoutes.js`. The tracker row
documents them under "Admin/IT API"; always verify the live path before
hard-coding. The generic helpers accept the path prefix without the
`/:id` suffix — `decideClinicalAi(path, id, ...)` appends it internally.

### Constraints

- No new npm deps (TanStack Query v5, lucide-react, react-hot-toast,
  Tailwind only).
- TypeScript strict — no `any`. If unavoidable, leave a
  `// TODO: tighten type` comment.
- Tailwind class conventions follow
  `apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/ClinicalAiExpansionPanels.tsx`.

## The `ClinicalAIReviewQueue` prop signature

Import and call as
`<ClinicalAIReviewQueue<TRow, TDecision> …>`. The full prop shape is:

```ts
export type DecideActionVariant =
  "primary" | "success" | "danger" | "warning" | "muted";

export type DecideAction<TDecision extends string> = {
  value: TDecision;
  label: string;
  variant?: DecideActionVariant;
  promptForNote?: boolean; // window.prompt before firing
};

export type FilterOption = { value: string; label: string };

export type FilterSpec = {
  key: string; // becomes listFn param key
  label: string;
  kind: "select" | "text";
  options?: FilterOption[]; // for select
  placeholder?: string; // for text
};

export type ColumnSpec<TRow> = {
  key: string;
  header: string;
  render?: (row: TRow) => React.ReactNode;
  accessor?: keyof TRow | ((row: TRow) => string | number | null | undefined);
  className?: string;
};

export type KpiSpec<TRow> = {
  label: string;
  compute: (rows: TRow[]) => string | number;
  helpText?: string;
};

export type ListResult = { count: number } & Record<string, unknown>;

export type ClinicalAIReviewQueueProps<TRow, TDecision extends string> = {
  title: string;
  moduleKey: string; // e.g. "pharmacogenomics_support"
  icon?: React.ReactNode;
  description?: string;
  listFn: (params: Record<string, unknown>) => Promise<ListResult>;
  rowsKey: string; // e.g. "advisories"
  decideFn: (
    id: number | string,
    decision: TDecision,
    note?: string | null,
  ) => Promise<unknown>;
  idAccessor?: (row: TRow) => number | string; // default: row.id
  filters?: FilterSpec[];
  defaultFilters?: Record<string, string>;
  columns: ColumnSpec<TRow>[];
  decideActions?: DecideAction<TDecision>[]; // omit → no decide column
  kpis?: KpiSpec<TRow>[];
  evaluateForm?: React.ReactNode; // rendered above the table
  emptyState?: string;
  rowKey?: (row: TRow) => string | number;
  defaultLimit?: number; // default 50
};
```

Behaviour:

- Query key is `['clinical-ai', moduleKey, filters]`. Mutations
  invalidate `['clinical-ai', moduleKey]` and `['clinical-ai-audit']`.
- KPIs render above the table as `grid-cols-3 lg:grid-cols-5` cards.
- A row's decision cell renders one button per `decideActions` entry.
  Buttons with `promptForNote: true` prompt via `window.prompt` and
  pass the note through to `decideFn`.
- Empty / loading / error states follow the existing
  `ClinicalAiExpansionPanels.tsx` visual language (`text-sm text-slate-500`,
  red-50 border for errors).

## Worked example — simple panel

`CybersecurityAnomalyPanel.tsx` (tracker row 26). Copy + adapt:

```tsx
"use client";

import { Shield } from "lucide-react";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  severityBadgeClass,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
  type KpiSpec,
} from "../ClinicalAIReviewQueue";
import { decideClinicalAi, listClinicalAi } from "@/lib/api/clinicalAiGeneric";

type SecurityAnomalyRow = {
  id: number;
  subject_type: string;
  subject_id: string | null;
  anomaly_category: string;
  severity: string;
  risk_score: number | null;
  detected_at: string | null;
  created_at: string | null;
  reviewer_decision: string;
  signals: Array<{ code?: string | null; title?: string | null }> | null;
};

type SecurityAnomalyDecision =
  | "acknowledged"
  | "investigating"
  | "resolved"
  | "false_positive"
  | "escalated";

const FILTERS: FilterSpec[] = [
  { key: "subject_type", label: "Subject", kind: "select", options: [...] },
  { key: "severity",     label: "Severity", kind: "select", options: [...] },
  { key: "reviewer_decision", label: "Review", kind: "select", options: [...] },
];

const KPIS: KpiSpec<SecurityAnomalyRow>[] = [
  { label: "Total",        compute: (rows) => rows.length },
  { label: "Critical",     compute: (rows) => rows.filter(r => r.severity === "critical").length },
  { label: "Acknowledged", compute: (rows) => rows.filter(r => r.reviewer_decision === "acknowledged").length },
];

const COLUMNS: ColumnSpec<SecurityAnomalyRow>[] = [
  { key: "subject", header: "Subject", render: (r) => <>{readableKey(r.subject_type)}</> },
  // … one entry per column
];

const DECIDE_ACTIONS: DecideAction<SecurityAnomalyDecision>[] = [
  { value: "acknowledged",   label: "Acknowledge",   variant: "primary" },
  { value: "investigating",  label: "Investigate",   variant: "warning" },
  { value: "resolved",       label: "Resolve",       variant: "success" },
  { value: "false_positive", label: "False positive", variant: "muted",  promptForNote: true },
  { value: "escalated",      label: "Escalate",      variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/security-anomalies";

export default function CybersecurityAnomalyPanel() {
  return (
    <ClinicalAIReviewQueue<SecurityAnomalyRow, SecurityAnomalyDecision>
      title="Cybersecurity Anomaly Detector"
      moduleKey="cybersecurity_anomaly_detector"
      icon={<Shield className="h-4 w-4" />}
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="anomalies"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      emptyState="No security anomalies pending review"
    />
  );
}
```

See the real file for the fully-populated filter options, KPI computations,
and column renderers.

## Worked example — two-tier panel

`PharmacogenomicsPanel.tsx` (tracker row 18). Shape:

```tsx
"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dna, PlayCircle, Save } from "lucide-react";
import { toast } from "react-hot-toast";

import {
  ClinicalAIReviewQueue,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
} from "../ClinicalAIReviewQueue";
import {
  decideClinicalAi,
  evaluateClinicalAi,
  listClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

const GENOTYPES_PATH  = "/admin/clinical-ai/pgx/genotypes";
const ADVISORIES_PATH = "/admin/clinical-ai/pgx/advisories";

// -- Top tier: bespoke table + upsert form (useQuery + useMutation) --
function PatientGenotypesSection({ patientUid, onPatientUidChange }: {...}) {
  // useQuery(['clinical-ai','pharmacogenomics_support','genotypes', uid])
  //   enabled: uid.length > 0
  //   queryFn: () => listClinicalAi(GENOTYPES_PATH, { patient_uid: uid })
  //
  // useMutation upsert → evaluateClinicalAi(GENOTYPES_PATH, payload)
}

// -- Bottom tier: evaluate form slot + review queue --
function PgxEvaluateForm() {
  // useMutation → evaluateClinicalAi(`${ADVISORIES_PATH}/evaluate`, body)
}

export default function PharmacogenomicsPanel() {
  const [patientUid, setPatientUid] = useState("");

  return (
    <section className="space-y-6">
      <PatientGenotypesSection
        patientUid={patientUid}
        onPatientUidChange={setPatientUid}
      />

      <ClinicalAIReviewQueue<PgxAdvisoryRow, PgxDecision>
        title="PGx Advisories"
        moduleKey="pharmacogenomics_support"
        icon={<Dna className="h-4 w-4" />}
        listFn={(params) => listClinicalAi(ADVISORIES_PATH, params)}
        rowsKey="advisories"
        decideFn={(id, decision, note) =>
          decideClinicalAi(ADVISORIES_PATH, id, decision, note)
        }
        filters={ADVISORY_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={ADVISORY_COLUMNS}
        decideActions={ADVISORY_DECIDE_ACTIONS}
        evaluateForm={<PgxEvaluateForm />}
        emptyState="No PGx advisories pending review"
      />
    </section>
  );
}
```

Key points the two-tier pattern illustrates:

- Top tier calls `listClinicalAi` / `evaluateClinicalAi` directly — no
  shared queue.
- Both halves share a `moduleKey` in their query keys so one
  `queryClient.invalidateQueries({ queryKey: ['clinical-ai', moduleKey] })`
  re-fetches everything when either tier mutates.
- The bottom half slots its evaluate form into the shared queue via
  `evaluateForm={<PgxEvaluateForm />}` rather than duplicating
  the filter/table/decide plumbing.

## Runtime wiring

`ClinicalAiExpansionPanels.tsx` is the runtime registry. Every panel is a
direct `next/dynamic` import so Turbopack can emit it independently. The page
must continue to import only that registry, never individual panel modules or
a directory barrel.

## Verification

Before opening a PR:

```bash
npm --prefix apps/admin run type-check
npm --prefix apps/admin run lint:all
```

`next build` is reserved for final validation — don't run it during
routine panel development.
