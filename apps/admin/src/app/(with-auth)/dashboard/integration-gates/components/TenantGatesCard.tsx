"use client";

import {
  setTenantGateFlag,
  type GateKey,
  type IntegrationGateTenantEntry,
  type TenantGateSettingKey,
} from "@/lib/api/integrationGates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import toast from "react-hot-toast";

import GateStateBadge from "./GateStateBadge";

// Gate → the tenants.settings key its flag lives under. `abdm_scan_share`
// rides the enrolment gate and has no flag of its own.
const GATE_ROWS: Array<{
  key: GateKey;
  label: string;
  settingKey: TenantGateSettingKey | null;
  note?: string;
}> = [
  {
    key: "payment_gateway",
    label: "Payment gateway",
    settingKey: "paymentGateway",
  },
  { key: "sms", label: "SMS (DLT)", settingKey: "sms" },
  {
    key: "abdm_enrolment",
    label: "ABHA enrolment",
    settingKey: "abdmEnrolment",
  },
  {
    key: "abdm_scan_share",
    label: "Scan & Share",
    settingKey: null,
    note: "rides ABHA enrolment",
  },
  { key: "abdm_hiu", label: "ABDM thin HIU", settingKey: "abdmHiu" },
  { key: "uhi", label: "UHI adapter", settingKey: "uhi" },
  {
    key: "ambulance_gps",
    label: "Ambulance GPS",
    settingKey: "ambulanceGpsTracking",
  },
  // Embedded BI (wt/bi-app): env layer is METABASE_URL + METABASE_EMBED_SECRET;
  // per-dashboard METABASE_DASH_* ids surface in the env facts card.
  {
    key: "analytics_bi",
    label: "Analytics BI embeds",
    settingKey: "analyticsBi",
  },
];

export function TenantGatesCard({
  entry,
}: {
  entry: IntegrationGateTenantEntry;
}) {
  const queryClient = useQueryClient();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const flipFlag = useMutation({
    mutationFn: ({
      settingKey,
      enabled,
    }: {
      settingKey: TenantGateSettingKey;
      enabled: boolean;
    }) => setTenantGateFlag(entry.tenant.id, settingKey, enabled),
    onMutate: ({ settingKey }) => setPendingKey(settingKey),
    onSuccess: () => {
      toast.success("Tenant gate flag updated");
      void queryClient.invalidateQueries({ queryKey: ["integration-gates"] });
    },
    onError: (e) =>
      toast.error(
        e instanceof Error ? e.message : "Failed to update tenant flag",
      ),
    onSettled: () => setPendingKey(null),
  });

  return (
    <div className="rounded-lg bg-card p-6 shadow">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-foreground">
            {entry.tenant.name || entry.tenant.slug}
          </h3>
          <p className="text-xs text-muted-foreground">
            {entry.tenant.slug} · {entry.tenant.status}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-4">Feature</th>
              <th className="py-2 pr-4">Effective</th>
              <th className="py-2 pr-4">Detail</th>
              <th className="py-2 pr-4">Tenant flag</th>
            </tr>
          </thead>
          <tbody>
            {GATE_ROWS.map(({ key, label, settingKey, note }) => {
              const state = entry.gates[key];
              if (!state) return null;
              const tenantFlagOn = state.layers?.tenant_setting === true;
              return (
                <tr key={key} className="border-b last:border-b-0">
                  <td className="py-2 pr-4 text-foreground">{label}</td>
                  <td className="py-2 pr-4">
                    <GateStateBadge state={state} />
                  </td>
                  <td className="py-2 pr-4 text-xs text-muted-foreground">
                    {note ??
                      ([
                        state.provider ? `provider: ${state.provider}` : null,
                        state.environment ? `env: ${state.environment}` : null,
                        state.dlt_templates
                          ? `DLT templates: ${state.dlt_templates.active}/${state.dlt_templates.total} active`
                          : null,
                        key === "ambulance_gps" &&
                        state.retention_days !== undefined
                          ? `retention ${state.retention_days}d`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") ||
                        "—")}
                  </td>
                  <td className="py-2 pr-4">
                    {settingKey ? (
                      <button
                        type="button"
                        disabled={flipFlag.isPending}
                        onClick={() =>
                          flipFlag.mutate({
                            settingKey,
                            enabled: !tenantFlagOn,
                          })
                        }
                        className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                          tenantFlagOn
                            ? "border-success text-success hover:bg-success/10"
                            : "border-input text-muted-foreground hover:bg-muted"
                        } ${flipFlag.isPending && pendingKey === settingKey ? "opacity-50" : ""}`}
                      >
                        {tenantFlagOn
                          ? "enabled — disable"
                          : "disabled — enable"}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default TenantGatesCard;
