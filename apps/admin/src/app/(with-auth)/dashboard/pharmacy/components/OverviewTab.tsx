"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import type { SLAData } from "./types";
import { StatCard } from "./shared";
import {
  FACILITY_SCOPE_NOTICE,
  useFacilityAuthority,
} from "./useFacilityAuthority";

export function OverviewTab() {
  const [sla, setSla] = useState<SLAData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // OPEN-25. Ask before firing, rather than firing and rendering the refusal.
  //
  // /orders/sla is facility-scoped: it resolves the actor's pharmacy custody
  // and answers 403 PHARMACY_FACILITY_GRANT_REQUIRED when they hold none. That
  // is not a role problem — FACILITY_OPERATION_ROLES admits ADMIN and
  // SUPER_ADMIN — so it cannot be decided from the session. An administrator
  // who has simply not been assigned a facility is a legitimate viewer, and
  // this tab used to greet them with a red "Failed to load SLA data" box.
  //
  // The probe is a 200-always sibling of the same route with the same guards,
  // so its answer predicts the call rather than approximating it. Firing the
  // scoped read only when it can succeed is also what keeps the authenticated
  // route crawl honest: the crawl flags any >=400 on /api/proxy/* at the
  // network layer, so handling the refusal in the UI alone would not have
  // helped — the page has to not make the call.
  const {
    authority,
    error: authorityError,
    loading: authorityLoading,
  } = useFacilityAuthority();
  const hasFacilityAuthority = authority?.has_authority === true;

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetchAdminAPI<{ data: SLAData }>("/pharmacy-orders/orders/sla")
      .then((res) => {
        const data = (res as Record<string, unknown>).data ?? res;
        setSla(data as SLAData);
      })
      .catch((err: unknown) => {
        setLoadError(
          err instanceof Error ? err.message : "Could not load SLA data",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // `authority === null` means UNRESOLVED, not "no authority": firing on it
    // would reintroduce the call this gate exists to avoid.
    if (authorityLoading) return;
    if (!hasFacilityAuthority) {
      setSla(null);
      setLoading(false);
      return;
    }
    load();
  }, [authorityLoading, hasFacilityAuthority, load]);

  if (authorityLoading || loading)
    return <div className="p-8 text-center">Loading SLA data...</div>;
  if (authorityError)
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
        {authorityError}
      </div>
    );
  if (!hasFacilityAuthority)
    // Deliberately not styled as an error, and deliberately avoiding the route
    // crawl's visible-failure vocabulary: this is a scope notice, not a fault.
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        {FACILITY_SCOPE_NOTICE}
      </div>
    );
  if (loadError)
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 flex items-center justify-between gap-3">
        <span>{loadError}</span>
        <button
          onClick={load}
          className="shrink-0 font-medium text-red-700 hover:text-red-900 underline"
        >
          Retry
        </button>
      </div>
    );
  if (!sla)
    return <div className="p-8 text-center text-muted-foreground">No data</div>;

  const s = sla.summary;
  const avg = sla.avg_times;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard label="Total" value={s.total} />
        <StatCard label="Placed" value={s.placed} color="text-orange-600" />
        <StatCard label="Confirmed" value={s.confirmed} color="text-blue-600" />
        <StatCard
          label="Preparing"
          value={s.preparing}
          color="text-amber-600"
        />
        <StatCard
          label="Dispatched"
          value={s.dispatched}
          color="text-teal-600"
        />
        <StatCard
          label="Delivered"
          value={s.delivered}
          color="text-green-600"
        />
        <StatCard label="Cancelled" value={s.cancelled} color="text-red-600" />
        <StatCard
          label="Revenue"
          value={`₹${Number(s.total_revenue || 0).toLocaleString()}`}
          color="text-green-700"
          bg="bg-green-50"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Avg. Confirm Time</p>
          <p className="text-xl font-semibold">
            {avg.avg_confirm_mins
              ? `${Number(avg.avg_confirm_mins).toFixed(1)} min`
              : "—"}
          </p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Avg. Dispatch Time</p>
          <p className="text-xl font-semibold">
            {avg.avg_dispatch_mins
              ? `${Number(avg.avg_dispatch_mins).toFixed(1)} min`
              : "—"}
          </p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Avg. Delivery Time</p>
          <p className="text-xl font-semibold">
            {avg.avg_delivery_mins
              ? `${Number(avg.avg_delivery_mins).toFixed(1)} min`
              : "—"}
          </p>
        </div>
      </div>

      {sla.sla_breaches > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700 font-semibold">
            ⚠ {sla.sla_breaches} SLA breach{sla.sla_breaches !== 1 ? "es" : ""}{" "}
            (orders not confirmed within 15 min)
          </p>
        </div>
      )}
    </div>
  );
}
