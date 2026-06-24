// src/app/(with-auth)/dashboard/billing/ledger/page.tsx
"use client";

import Link from "next/link";
import { usePermissions } from "@/hooks/usePermissions";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { getArAging, getInsurerAging } from "@/lib/api";
import { CollapsibleSection } from "./components/CollapsibleSection";
import { TrialBalanceSection } from "./components/TrialBalanceSection";
import { AgingSection } from "./components/AgingSection";
import { CashPositionSection } from "./components/CashPositionSection";
import { DailyCollectionSection } from "./components/DailyCollectionSection";

export default function GeneralLedgerPage() {
  const { user, isAdmin, loading } = usePermissions();
  const canView =
    isAdmin || String(user?.role ?? "").toUpperCase() === "FINANCE_INCHARGE";

  if (loading) return <LoadingSpinner fullHeight label="Loading…" />;

  if (!canView) {
    return (
      <div className="p-6">
        <EmptyState
          title="Finance access required"
          description="The General Ledger is restricted to finance and administrator roles."
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">General Ledger</h1>
        <Link href="/dashboard/billing" className="text-sm text-primary hover:underline">
          ← Billing
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Read-only financial reports derived from the double-entry ledger.
      </p>

      <CollapsibleSection title="Trial Balance">
        <TrialBalanceSection />
      </CollapsibleSection>

      <CollapsibleSection title="Patient AR Aging">
        <AgingSection load={getArAging} emptyLabel="No outstanding patient receivables." />
      </CollapsibleSection>

      <CollapsibleSection title="Insurer AR Aging">
        <AgingSection load={getInsurerAging} emptyLabel="No outstanding insurer receivables." />
      </CollapsibleSection>

      <CollapsibleSection title="Cash Position">
        <CashPositionSection />
      </CollapsibleSection>

      <CollapsibleSection title="Daily Collection">
        <DailyCollectionSection />
      </CollapsibleSection>
    </div>
  );
}
