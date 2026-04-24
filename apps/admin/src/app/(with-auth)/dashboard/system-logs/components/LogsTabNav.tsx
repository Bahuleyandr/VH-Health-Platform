// src/app/(with-auth)/dashboard/system-logs/components/LogsTabNav.tsx
// Audit / System tab switcher with per-tab count.

"use client";

interface Props {
  currentTab: string;
  auditCount: number;
  systemCount: number;
  onTabChange: (tab: string) => void;
}

export function LogsTabNav({
  currentTab,
  auditCount,
  systemCount,
  onTabChange,
}: Props) {
  return (
    <div className="mb-6 border-b border-border">
      <nav className="-mb-px flex space-x-8" aria-label="Tabs">
        <button
          onClick={() => onTabChange("audit")}
          className={`${
            currentTab === "audit"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground hover:border-input"
          } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors`}
        >
          Audit Logs ({auditCount})
        </button>
        <button
          onClick={() => onTabChange("system")}
          className={`${
            currentTab === "system"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground hover:border-input"
          } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors`}
        >
          System Logs ({systemCount})
        </button>
      </nav>
    </div>
  );
}
