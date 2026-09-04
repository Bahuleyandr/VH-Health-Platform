"use client";

// NL13-P1f — cath quality views: dose-audit rollups (owner-thresholded) and
// the complication registry review board. Lives under the existing quality
// segment so the api/v1/quality proxy family + routePolicy cover it.
//
// The reprocessing-policy tab is device-reuse GOVERNANCE, not a cath-lab
// workflow: it reads and writes /api/v1/cath-reprocessing, whose audience is
// quality, infection control and platform admin. It sits here because those
// are the hands that set it, and because routePolicy's `quality` segment
// already admits them.

import { useState } from "react";
import { Activity, ClipboardList, Recycle } from "lucide-react";
import DoseRollupTab from "./components/DoseRollupTab";
import ComplicationRegistryTab from "./components/ComplicationRegistryTab";
import ReprocessingPolicyTab from "./components/ReprocessingPolicyTab";

const TABS = [
  { key: "dose", label: "Dose rollup", icon: Activity },
  { key: "registry", label: "Complication registry", icon: ClipboardList },
  { key: "reprocessing", label: "Reprocessing policy", icon: Recycle },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function CathQualityPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("dose");

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-lg font-semibold">Cath lab quality</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Radiation/contrast dose rollups and the complication registry, derived
          from cath-lab procedure records.
        </p>
      </header>
      <nav className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${
                active
                  ? "border-blue-600 text-blue-700 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </nav>
      {activeTab === "dose" ? (
        <DoseRollupTab />
      ) : activeTab === "registry" ? (
        <ComplicationRegistryTab />
      ) : (
        <ReprocessingPolicyTab />
      )}
    </div>
  );
}
