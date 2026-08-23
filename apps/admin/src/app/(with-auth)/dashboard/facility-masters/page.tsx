"use client";

import { LoadingSpinner } from "@/components/LoadingSpinner";
import { listFacilities } from "@/lib/api/facilityMasters";
import { useQuery } from "@tanstack/react-query";
import { Building2, MapPin, RefreshCw, Stethoscope } from "lucide-react";
import { useState } from "react";

import { FacilitiesTab } from "./components/FacilitiesTab";
import { ServicesTab } from "./components/ServicesTab";
import { StructureTab } from "./components/StructureTab";

type Tab = "facilities" | "structure" | "services";

const TABS: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
  {
    key: "facilities",
    label: "Facilities",
    icon: <Building2 className="h-4 w-4" />,
  },
  {
    key: "structure",
    label: "Locations & Rooms",
    icon: <MapPin className="h-4 w-4" />,
  },
  {
    key: "services",
    label: "Service Catalog",
    icon: <Stethoscope className="h-4 w-4" />,
  },
];

export default function FacilityMastersPage() {
  const [tab, setTab] = useState<Tab>("facilities");
  const [selectedFacilityId, setSelectedFacilityId] = useState<number | null>(
    null,
  );

  const facilitiesQuery = useQuery({
    queryKey: ["facility-masters", "facilities"],
    queryFn: () => listFacilities({ limit: 200 }),
  });

  const facilities = facilitiesQuery.data?.facilities ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
            Phase C1 Masters
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">
            Facility Masters
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Facilities, their location hierarchy and rooms, and the tenant
            service catalog. Records are upserted; retire entries by setting
            status to archived.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void facilitiesQuery.refetch()}
          className="inline-flex items-center gap-2 self-start rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div
        className="flex flex-wrap gap-2 border-b border-border pb-2"
        role="tablist"
      >
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            onClick={() => setTab(entry.key)}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
              tab === entry.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </div>

      {facilitiesQuery.isLoading ? (
        <LoadingSpinner label="Loading facilities..." />
      ) : facilitiesQuery.error instanceof Error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {facilitiesQuery.error.message}
        </div>
      ) : tab === "facilities" ? (
        <FacilitiesTab
          facilities={facilities}
          onDrill={(facilityId) => {
            setSelectedFacilityId(facilityId);
            setTab("structure");
          }}
        />
      ) : tab === "structure" ? (
        <StructureTab
          facilities={facilities}
          facilityId={selectedFacilityId}
          onSelectFacility={setSelectedFacilityId}
        />
      ) : (
        <ServicesTab facilities={facilities} />
      )}
    </div>
  );
}
