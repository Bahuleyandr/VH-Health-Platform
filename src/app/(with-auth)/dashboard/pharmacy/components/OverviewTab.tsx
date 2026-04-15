"use client";

import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import type { SLAData } from "./types";
import { StatCard } from "./shared";

export function OverviewTab() {
  const [sla, setSla] = useState<SLAData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAdminAPI<{ data: SLAData }>("/pharmacy-orders/orders/sla")
      .then((r) => {
        const data = (r as Record<string, unknown>).data ?? r;
        setSla(data as SLAData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-center">Loading SLA data...</div>;
  if (!sla) return <div className="p-8 text-center text-muted-foreground">No data</div>;

  const s = sla.summary;
  const avg = sla.avg_times;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard label="Total" value={s.total} />
        <StatCard label="Placed" value={s.placed} color="text-orange-600" />
        <StatCard label="Confirmed" value={s.confirmed} color="text-blue-600" />
        <StatCard label="Preparing" value={s.preparing} color="text-amber-600" />
        <StatCard label="Dispatched" value={s.dispatched} color="text-teal-600" />
        <StatCard label="Delivered" value={s.delivered} color="text-green-600" />
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
            {avg.avg_confirm_mins ? `${Number(avg.avg_confirm_mins).toFixed(1)} min` : "—"}
          </p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Avg. Dispatch Time</p>
          <p className="text-xl font-semibold">
            {avg.avg_dispatch_mins ? `${Number(avg.avg_dispatch_mins).toFixed(1)} min` : "—"}
          </p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Avg. Delivery Time</p>
          <p className="text-xl font-semibold">
            {avg.avg_delivery_mins ? `${Number(avg.avg_delivery_mins).toFixed(1)} min` : "—"}
          </p>
        </div>
      </div>

      {sla.sla_breaches > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700 font-semibold">
            ⚠ {sla.sla_breaches} SLA breach{sla.sla_breaches !== 1 ? "es" : ""} (orders not
            confirmed within 15 min)
          </p>
        </div>
      )}
    </div>
  );
}
