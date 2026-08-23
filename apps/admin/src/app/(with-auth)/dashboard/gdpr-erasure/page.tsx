"use client";

// GDPR erasure (right to be forgotten) console.
// Backend surface: POST /api/v1/gdpr/erase + GET /api/v1/gdpr/erasure-log
// (apps/backend/src/routes/gdprRoutes.js — admin-gated).

import { ErasureLogTable } from "./components/ErasureLogTable";
import { ExecuteErasurePanel } from "./components/ExecuteErasurePanel";

export default function GdprErasurePage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
          Compliance
        </p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">
          GDPR Erasure
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Right-to-be-forgotten console. Erasure permanently deletes or
          anonymizes the subject&apos;s data and is blocked while the subject
          has an active legal hold. Every execution is audit-logged with the
          requesting admin, reason, and per-table outcome.
        </p>
      </div>

      <ExecuteErasurePanel />
      <ErasureLogTable />
    </div>
  );
}
