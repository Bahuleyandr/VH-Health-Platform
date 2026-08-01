"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { ContinuityFacilityGrant } from "@/lib/api/continuityFacilityContext";
import {
  GrantDetails,
  RevokeGrantButton,
  type RevokeGrant,
} from "./GrantPanelPrimitives";

const DEVICE_LOSS_RUNBOOK_URL =
  "https://github.com/Bahuleyandr/VH-Health-Platform/blob/main/docs/continuity/c4-device-loss-operator-runbook.md";

interface DeviceLossPanelProps {
  grants: ContinuityFacilityGrant[];
  onRevoke: RevokeGrant;
  onChanged: () => void;
}

export function DeviceLossPanel({
  grants,
  onRevoke,
  onChanged,
}: DeviceLossPanelProps) {
  const [deviceId, setDeviceId] = useState("");
  const matchingGrants = useMemo(
    () =>
      deviceId.length === 0
        ? []
        : grants.filter(
            (grant) =>
              grant.device_id === deviceId && grant.revocation_id === null,
          ),
    [deviceId, grants],
  );

  return (
    <section aria-labelledby="device-loss-execution" className="space-y-5">
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-error-on-surface" />
          <div>
            <h2 id="device-loss-execution" className="text-lg font-semibold">
              Device-loss execution is partial
            </h2>
            <p className="mt-2 text-sm text-foreground">
              This portal executes only individual capture-grant revocations. It
              does not revoke sessions or edge-read grants, issue a wipe order,
              expire an offline pack, or route unsynced work to needs_review.
            </p>
            <p className="mt-2 text-sm font-medium text-foreground">
              The rest must be completed and evidenced elsewhere using the
              operator runbook. Capture-grant receipts alone never complete the
              C-D10 response.
            </p>
            <Link
              href={DEVICE_LOSS_RUNBOOK_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-primary underline underline-offset-4"
            >
              Open device-loss operator runbook
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)]">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <Input
            id="device-loss-stable-device-id"
            label="Exact stable device UUID"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            placeholder="Paste the full server-proved device UUID"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Exact match only. No browser, FCM, hostname, clinical-device, or
            friendly-name inference is performed.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h3 className="font-semibold text-foreground">
            Required completion outside this portal
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>Session revocation receipt</li>
            <li>C3 edge-read grant revocation receipt</li>
            <li>Signed governed wipe-order receipt</li>
            <li>Offline-pack expiry/risk record</li>
            <li>needs_review reconciliation routing receipt</li>
          </ul>
          <p className="mt-3 text-xs font-medium text-error-on-surface">
            No checkbox here can claim those systems completed their duty.
          </p>
        </div>
      </div>

      {deviceId.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Enter one exact stable device UUID to enumerate its active capture
          grants.
        </div>
      ) : matchingGrants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          The loaded capture-grant ledger contains no active exact match. This
          does not prove that sessions, edge-read grants, offline data, or
          unsynced work are safe.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
            {matchingGrants.length} active capture grant
            {matchingGrants.length === 1 ? " is" : "s are"} explicitly
            enumerated below. Revoke and confirm each one separately; there is
            no bulk action.
          </div>
          {matchingGrants.map((grant) => (
            <article
              key={grant.id}
              className="rounded-xl border border-border bg-card p-5 shadow-sm"
            >
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-mono text-sm font-semibold text-foreground">
                    {grant.id}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Explicit capture-grant item
                  </p>
                </div>
                <RevokeGrantButton
                  grant={grant}
                  onRevoke={onRevoke}
                  onChanged={onChanged}
                  defaultReason="Device loss response"
                />
              </div>
              <GrantDetails grant={grant} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
