import { Activity, Check, Code2, KeyRound, Shield } from "lucide-react";
import type { DeveloperPortalSummary } from "@/lib/api/developerPortal";

export function MetricCards({ portal }: { portal: DeveloperPortalSummary }) {
  const metrics = [
    ["Clients", portal.counts.total_clients, Code2],
    ["Active", portal.counts.active_clients, Check],
    ["Sandbox", portal.counts.sandbox_clients, Shield],
    ["Production", portal.counts.production_clients, Shield],
    ["Keys", portal.counts.total_keys, KeyRound],
    ["Active keys", portal.counts.active_keys, Activity],
  ] as const;

  return (
    <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
      {metrics.map(([label, value, Icon]) => (
        <div key={label} className="rounded-md border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-500">{label}</span>
            <Icon className="h-4 w-4 text-teal-700" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div>
        </div>
      ))}
    </section>
  );
}
