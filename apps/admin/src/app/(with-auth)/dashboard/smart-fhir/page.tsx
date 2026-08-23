"use client";

// SMART-on-FHIR app registry + token lifecycle console.
// Backend surface: /api/v1/admin/smart-fhir
// (apps/backend/src/routes/admin/smartFhirRoutes.js).

import { LoadingSpinner } from "@/components/LoadingSpinner";
import { describeSmartApiError, listSmartApps } from "@/lib/api/smartFhir";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { AppsPanel } from "./components/AppsPanel";
import { ErrorBanner } from "./components/shared";
import { TokensPanel } from "./components/TokensPanel";

export default function SmartFhirPage() {
  const appsQuery = useQuery({
    queryKey: ["smart-fhir", "apps"],
    queryFn: () => listSmartApps(),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
            Interoperability
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">
            SMART-on-FHIR Apps
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Registry and lifecycle management for third-party SMART apps. The
            public OAuth surface at{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              /api/v1/fhir
            </code>{" "}
            is live (including{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              /.well-known/smart-configuration
            </code>
            ) — apps registered here can immediately request tokens against it,
            and revoking a token here cuts that access off.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void appsQuery.refetch()}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh apps
        </button>
      </div>

      {appsQuery.isLoading ? (
        <LoadingSpinner label="Loading SMART apps..." fullHeight />
      ) : appsQuery.error ? (
        <ErrorBanner
          message={describeSmartApiError(appsQuery.error).message}
          code={describeSmartApiError(appsQuery.error).code}
          requestId={describeSmartApiError(appsQuery.error).requestId}
        />
      ) : (
        <>
          <AppsPanel apps={appsQuery.data?.apps ?? []} />
          <TokensPanel apps={appsQuery.data?.apps ?? []} />
        </>
      )}
    </div>
  );
}
