"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileClock,
  LockKeyhole,
  MonitorCog,
  ShieldAlert,
  UserRoundCheck,
} from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import {
  classifyContinuityFacilityError,
  enrollContinuityFacilityGrant,
  listContinuityFacilityGrants,
  revokeContinuityFacilityGrant,
} from "@/lib/api/continuityFacilityContext";
import { DeviceLossPanel } from "./components/DeviceLossPanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { FixedDevicePanel } from "./components/FixedDevicePanel";
import { StaffDeviceGrantsPanel } from "./components/StaffDeviceGrantsPanel";
import { StatusPanel } from "./components/StatusPanel";

type SurfaceTab = "staff" | "fixed" | "device-loss" | "evidence";

const DEVICE_LOSS_RUNBOOK_URL =
  "https://github.com/Bahuleyandr/VH-Health-Platform/blob/main/docs/continuity/c4-device-loss-operator-runbook.md";

const tabs: Array<{
  id: SurfaceTab;
  label: string;
  icon: typeof UserRoundCheck;
}> = [
  { id: "staff", label: "Staff/device grants", icon: UserRoundCheck },
  { id: "fixed", label: "Fixed devices", icon: MonitorCog },
  { id: "device-loss", label: "Device loss", icon: ShieldAlert },
  { id: "evidence", label: "Evidence", icon: FileClock },
];

function PageHeader() {
  return (
    <div>
      <p className="text-sm font-semibold uppercase tracking-wide text-primary">
        Continuity control plane
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-foreground sm:text-3xl">
          Facility context
        </h1>
        <span className="rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
          SUPER_ADMIN
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
        Exact capture-purpose grant lifecycle, partial device-loss execution,
        and append-only ledger evidence for countersigned C-D14 duties.
      </p>
    </div>
  );
}

function LockedSurfaceMap() {
  const cards = [
    {
      title: "Staff/device grants",
      copy: "Exact Staff UID + stable device UUID + facility ID grants are unavailable.",
      icon: UserRoundCheck,
    },
    {
      title: "Fixed-device enrollment",
      copy: "Enrollment, re-provisioning, and revocation are unavailable.",
      icon: MonitorCog,
    },
    {
      title: "Device loss",
      copy: "This portal can revoke capture grants only after activation. The rest must be completed elsewhere.",
      icon: ShieldAlert,
    },
    {
      title: "Evidence",
      copy: "The append-only grant ledger cannot be viewed while the endpoint is unavailable.",
      icon: FileClock,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <section
            key={card.title}
            className="rounded-xl border border-border bg-card p-5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div>
                  <h2 className="font-semibold text-foreground">
                    {card.title}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {card.copy}
                  </p>
                  {card.title === "Device loss" && (
                    <Link
                      href={DEVICE_LOSS_RUNBOOK_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-block text-sm font-semibold text-primary underline underline-offset-4"
                    >
                      Open device-loss operator runbook
                    </Link>
                  )}
                </div>
              </div>
              <LockKeyhole className="h-5 w-5 shrink-0 text-muted-foreground" />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function FacilityContextSurface() {
  const [activeTab, setActiveTab] = useState<SurfaceTab>("staff");
  const query = useQuery({
    queryKey: ["continuity-facility-context", "grants"],
    queryFn: () => listContinuityFacilityGrants(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const failure = query.error
    ? classifyContinuityFacilityError(query.error)
    : undefined;

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <StatusPanel checking />
        <LockedSurfaceMap />
      </div>
    );
  }

  if (failure || !query.data) {
    const safeFailure =
      failure ??
      classifyContinuityFacilityError(
        new Error("The facility-context service returned no data"),
      );
    return (
      <div className="space-y-6">
        <PageHeader />
        <StatusPanel
          failure={safeFailure}
          onRetry={() => void query.refetch()}
        />
        <LockedSurfaceMap />
      </div>
    );
  }

  const grants = query.data.data.grants;
  const refreshLedger = () => void query.refetch();

  return (
    <div className="space-y-6">
      <PageHeader />
      <StatusPanel requestId={query.data.requestId} />

      <div
        role="tablist"
        aria-label="Facility-context duties"
        className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 shadow-sm"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {activeTab === "staff" && (
          <StaffDeviceGrantsPanel
            grants={grants}
            onEnroll={enrollContinuityFacilityGrant}
            onRevoke={revokeContinuityFacilityGrant}
            onChanged={refreshLedger}
          />
        )}
        {activeTab === "fixed" && (
          <FixedDevicePanel
            grants={grants}
            onEnroll={enrollContinuityFacilityGrant}
            onRevoke={revokeContinuityFacilityGrant}
            onChanged={refreshLedger}
          />
        )}
        {activeTab === "device-loss" && (
          <DeviceLossPanel
            grants={grants}
            onRevoke={revokeContinuityFacilityGrant}
            onChanged={refreshLedger}
          />
        )}
        {activeTab === "evidence" && (
          <EvidencePanel grants={grants} requestId={query.data.requestId} />
        )}
      </div>
    </div>
  );
}

export default function ContinuityFacilityContextPage() {
  const { role, loading } = usePermissions();

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <StatusPanel checking />
      </div>
    );
  }

  if (role !== "SUPER_ADMIN") {
    return (
      <div className="space-y-6">
        <PageHeader />
        <section className="rounded-xl border border-destructive/40 bg-destructive/10 p-5">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-error-on-surface" />
            <div>
              <h2 className="text-lg font-semibold">
                SUPER_ADMIN access required
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                This strict temporary portal mapping prevents the page from
                calling the backend for lower roles. The organizational role
                decision and dedicated backend capability remain open.
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return <FacilityContextSurface />;
}
