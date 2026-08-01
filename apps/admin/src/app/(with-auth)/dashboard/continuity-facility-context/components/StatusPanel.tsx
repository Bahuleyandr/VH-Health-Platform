"use client";

import {
  AlertTriangle,
  CheckCircle2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ContinuityFacilityFailure } from "@/lib/api/continuityFacilityContext";

interface StatusPanelProps {
  checking?: boolean;
  failure?: ContinuityFacilityFailure;
  requestId?: string;
  onRetry?: () => void;
}

export function StatusPanel({
  checking = false,
  failure,
  requestId,
  onRetry,
}: StatusPanelProps) {
  const available = !checking && !failure;
  const title = checking
    ? "Checking server state"
    : failure?.state === "not_activated"
      ? "Not yet activated"
      : failure?.state === "denied"
        ? "Denied"
        : failure?.state === "service_unavailable"
          ? "Service unavailable"
          : "Available from server";
  const description = checking
    ? "The portal is asking the facility-context grant endpoint for its current state."
    : failure?.state === "not_activated"
      ? "The C-D14 backend gate is closed. Facility-context grants cannot be viewed or changed."
      : failure?.state === "denied"
        ? "The server denied facility-context access. No grant data or action is available."
        : failure?.state === "service_unavailable"
          ? "The server did not return the known typed-absence state. No grant data or action is available."
          : "The server returned the facility-context ledger. Exact, individually confirmed actions are available below.";
  const statusClasses = available
    ? "border-success/40 bg-success/10"
    : failure?.state === "denied" || failure?.state === "service_unavailable"
      ? "border-destructive/40 bg-destructive/10"
      : "border-warning/50 bg-warning/10";
  const StatusIcon = available
    ? CheckCircle2
    : failure?.state === "denied" || failure?.state === "service_unavailable"
      ? AlertTriangle
      : LockKeyhole;

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="facility-context-status"
        className={`rounded-xl border p-5 shadow-sm ${statusClasses}`}
      >
        <div className="flex items-start gap-3">
          <StatusIcon className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="facility-context-status" className="text-lg font-semibold">
              {title}
            </h2>
            <p className="mt-1 text-sm text-foreground">{description}</p>
            {failure?.message && failure.message !== description && (
              <p className="mt-2 text-sm text-muted-foreground">
                Server message: {failure.message}
              </p>
            )}
            {failure?.code && (
              <p className="mt-3 break-all font-mono text-xs font-medium">
                {failure.code}
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Audit reference:{" "}
              {failure?.requestId ?? requestId ?? "Not returned"}
            </p>
            {failure?.state === "service_unavailable" && onRetry && (
              <Button variant="outline" className="mt-4" onClick={onRetry}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry server check
              </Button>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <h2 className="font-semibold text-foreground">C-D14 authority</h2>
              <blockquote className="mt-2 text-sm text-muted-foreground">
                “IT/security alone maintains the staff-to-facility authorization
                set and performs device enrollment, re-provisioning, and
                revocation.”
              </blockquote>
              <p className="mt-2 text-sm text-muted-foreground">
                Personal and floating devices reconfirm at every login and at
                least every 12 hours. This portal does not implement that Staff
                confirmation seam.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="font-semibold text-foreground">
            Role mapping remains open
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Access is temporarily limited to SUPER_ADMIN, the strictest existing
            portal role. Loosen only after the owner mapping and a
            deny-by-default backend capability are decided in a separate slice.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Portal visibility, code merge, and deployment are not clinical
            activation.
          </p>
        </section>
      </div>
    </div>
  );
}
