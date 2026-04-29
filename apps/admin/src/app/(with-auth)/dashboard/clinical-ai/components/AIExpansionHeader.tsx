"use client";

import { Activity } from "lucide-react";

export function AIExpansionHeader() {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Activity className="mt-0.5 h-5 w-5 text-emerald-600" />
        <div>
          <h2 className="text-lg font-semibold">Clinical AI Expansion Modules</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The panels below surface AI-generated decisions for human review. Every action below records a
            tenant-scoped audit entry. These modules never auto-action; clinicians, coders, and coordinators decide.
          </p>
        </div>
      </div>
    </section>
  );
}
