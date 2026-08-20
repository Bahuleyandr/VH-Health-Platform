// src/app/(with-auth)/dashboard/terminology/page.tsx
//
// "Terminology & Knowledge" console (slate C1 / WP5) — ADMIN+ view of the
// clinical terminology spine and licensed drug KB: code-system imports,
// binding curation, tenant settings (incl. per-surface coding enforcement),
// drug-KB sources/coverage, and lab analyzer-code → LOINC mappings.
//
// Thin tab orchestrator per the god-page refactor rule; each tab lives in
// components/. Tabs backed by sibling work packages degrade gracefully on
// 404 until those packages merge.
"use client";

import { usePermissions } from "@/hooks/usePermissions";
import { useState } from "react";

import BindingsTab from "./components/BindingsTab";
import CodeSystemsTab from "./components/CodeSystemsTab";
import DrugKbTab from "./components/DrugKbTab";
import LabMappingsTab from "./components/LabMappingsTab";
import TenantSettingsTab from "./components/TenantSettingsTab";

const TABS = [
  { key: "code-systems", label: "Code systems" },
  { key: "bindings", label: "Bindings" },
  { key: "settings", label: "Tenant settings" },
  { key: "drug-kb", label: "Drug KB" },
  { key: "lab-mappings", label: "Lab mappings" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function TerminologyPage() {
  // Mirrors routePolicy (`terminology`: ADMIN_ONLY) and the nav gating.
  const { allowed } = usePermissions({ requiredRole: "ADMIN" });
  const [tab, setTab] = useState<TabKey>("code-systems");

  if (!allowed) {
    return (
      <div className="p-6">
        <div className="rounded border bg-warning/10 p-4 text-warning">
          Terminology &amp; Knowledge is an ADMIN-only console.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">
          Terminology &amp; Knowledge
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Code-system imports, catalog bindings, tenant coding settings, the
          licensed drug knowledge base, and lab code mappings. Enablement is
          dark-shipped and fail-closed — see the Integrations &amp; Gates
          console for the effective per-tenant gate states.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-b pb-2">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-md px-3 py-2 text-sm font-medium ${
              tab === key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "code-systems" && <CodeSystemsTab />}
      {tab === "bindings" && <BindingsTab />}
      {tab === "settings" && <TenantSettingsTab />}
      {tab === "drug-kb" && <DrugKbTab />}
      {tab === "lab-mappings" && <LabMappingsTab />}
    </div>
  );
}
