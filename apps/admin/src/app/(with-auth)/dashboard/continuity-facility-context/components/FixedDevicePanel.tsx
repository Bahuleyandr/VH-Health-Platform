"use client";

import { MonitorCog } from "lucide-react";
import type { ContinuityFacilityGrant } from "@/lib/api/continuityFacilityContext";
import {
  EnrollmentForm,
  GrantDetails,
  RevokeGrantButton,
  type EnrollGrant,
  type RevokeGrant,
} from "./GrantPanelPrimitives";

interface FixedDevicePanelProps {
  grants: ContinuityFacilityGrant[];
  onEnroll: EnrollGrant;
  onRevoke: RevokeGrant;
  onChanged: () => void;
}

export function FixedDevicePanel({
  grants,
  onEnroll,
  onRevoke,
  onChanged,
}: FixedDevicePanelProps) {
  const fixedGrants = grants.filter(
    (grant) => grant.grant_purpose === "capture_fixed_device",
  );

  return (
    <section aria-labelledby="fixed-device-enrollment" className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <MonitorCog className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <h2 id="fixed-device-enrollment" className="text-lg font-semibold">
              Fixed-device enrollment and lifecycle
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Device identity is the exact stable UUID and credential hash
              proved by this contract. Moving or re-provisioning a device is a
              revoke-then-enroll sequence; the old row is never edited.
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
          Re-provisioning is not atomic. Revoke the old grant first, keep its
          receipt, then create the replacement with a second confirmation. If
          enrollment fails, the safe state is “old grant revoked; replacement
          not enrolled.”
        </div>
        <div className="mt-5">
          <EnrollmentForm
            purpose="capture_fixed_device"
            onEnroll={onEnroll}
            onChanged={onChanged}
          />
        </div>
      </div>

      {fixedGrants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          The server returned no fixed-device facility grants.
        </div>
      ) : (
        <div className="space-y-4">
          {fixedGrants.map((grant) => (
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
                    {grant.revocation_id ? "Revoked" : "Active server row"}
                  </p>
                </div>
                <RevokeGrantButton
                  grant={grant}
                  onRevoke={onRevoke}
                  onChanged={onChanged}
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
