"use client";

import type { IntegrationGateState } from "@/lib/api/integrationGates";

const LAYER_LABEL: Record<string, string> = {
  env: "env switch",
  tenant_setting: "tenant flag",
  provider_config: "provider config",
  unknown: "unknown layer",
};

export function GateStateBadge({ state }: { state: IntegrationGateState }) {
  if (state.effective) {
    return (
      <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
        ON
      </span>
    );
  }
  const layer = state.blocking_layer
    ? (LAYER_LABEL[state.blocking_layer] ?? state.blocking_layer)
    : null;
  return (
    <span
      className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      title={state.reason ?? undefined}
    >
      off{layer ? ` — ${layer}` : ""}
    </span>
  );
}

export default GateStateBadge;
