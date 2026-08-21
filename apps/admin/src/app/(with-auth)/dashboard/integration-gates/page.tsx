// src/app/(with-auth)/dashboard/integration-gates/page.tsx
//
// "Integrations & Gates" console (slate B1) — SUPER_ADMIN-only view of every
// dark-shipped feature gate per tenant (env switch AND tenant flag AND
// provider config, fail-closed), with the flip forms wired to the existing
// mutation endpoints. Secrets are write-only end to end.
"use client";

import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useActingTenant } from "@/contexts/ActingTenantContext";
import { usePermissions } from "@/hooks/usePermissions";
import {
  getIntegrationGates,
  type PaymentGatewayConfigView,
  type SmsProviderConfigView,
} from "@/lib/api/integrationGates";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import EnvFactsCard from "./components/EnvFactsCard";
import PaymentGatewayConfigForm from "./components/PaymentGatewayConfigForm";
import SmsConfigForm from "./components/SmsConfigForm";
import TenantGatesCard from "./components/TenantGatesCard";

export default function IntegrationGatesPage() {
  // Platform control plane — SUPER_ADMIN only (matches routePolicy, nav,
  // proxy sentinel gate, and the backend requireRole).
  const { allowed } = usePermissions({ requiredRole: "SUPER_ADMIN" });
  const { actingTenant } = useActingTenant();

  const report = useQuery({
    queryKey: ["integration-gates"],
    queryFn: () => getIntegrationGates(),
    enabled: allowed,
  });

  // The provider-config endpoints resolve the tenant server-side (acting
  // tenant when set, otherwise the operator's own tenant). Show the matching
  // tenant's stored config rows next to the forms.
  const configEntry = useMemo(() => {
    const tenants = report.data?.tenants ?? [];
    if (actingTenant) {
      return tenants.find((t) => t.tenant.id === actingTenant.id) ?? null;
    }
    return tenants.length === 1 ? tenants[0] : null;
  }, [report.data, actingTenant]);

  const existingGatewayConfig = useMemo(() => {
    const configs = (configEntry?.gates.payment_gateway?.layers
      ?.provider_configs ?? []) as PaymentGatewayConfigView[];
    return configs.find((c) => c.enabled) ?? configs[0] ?? null;
  }, [configEntry]);

  const existingSmsConfig = useMemo(() => {
    const configs = (configEntry?.gates.sms?.layers?.provider_configs ??
      []) as SmsProviderConfigView[];
    return configs.find((c) => c.enabled) ?? configs[0] ?? null;
  }, [configEntry]);

  if (!allowed) {
    return (
      <div className="p-6">
        <div className="rounded border bg-warning/10 p-4 text-warning">
          Integrations &amp; Gates is a SUPER_ADMIN-only console.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            Integrations &amp; Gates
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Effective state of every dark-shipped feature per tenant. A feature
            is live only when every layer (env switch, tenant flag, provider
            config) is on — all gates fail closed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void report.refetch()}
          className="rounded-md border border-input px-3 py-2 text-sm text-foreground hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {report.isLoading && (
        <div className="flex h-40 items-center justify-center">
          <LoadingSpinner />
        </div>
      )}

      {report.isError && (
        <div className="rounded border border-destructive bg-destructive/10 px-4 py-3 text-destructive">
          {report.error instanceof Error
            ? report.error.message
            : "Failed to load integration gate states"}
        </div>
      )}

      {report.data && (
        <>
          <EnvFactsCard env={report.data.env} />

          {report.data.tenants.map((entry) => (
            <TenantGatesCard key={entry.tenant.id} entry={entry} />
          ))}

          <div className="rounded-lg bg-card p-6 shadow">
            <h2 className="mb-1 text-lg font-medium text-foreground">
              Provider configuration
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">
              These writes go to the tenant resolved server-side:{" "}
              {actingTenant ? (
                <>
                  currently acting as{" "}
                  <span className="font-medium text-foreground">
                    {actingTenant.slug || actingTenant.id}
                  </span>
                  .
                </>
              ) : (
                <>
                  your own tenant. To configure another tenant, start &quot;act
                  as tenant&quot; from the Tenant Operator Console first.
                </>
              )}{" "}
              Secrets are write-only and never shown again.
            </p>

            <div className="space-y-8">
              <div>
                <h3 className="mb-3 text-base font-medium text-foreground">
                  Payment gateway
                </h3>
                <PaymentGatewayConfigForm existing={existingGatewayConfig} />
              </div>
              <div className="border-t pt-6">
                <h3 className="mb-3 text-base font-medium text-foreground">
                  SMS provider &amp; DLT templates
                </h3>
                <SmsConfigForm existing={existingSmsConfig} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
