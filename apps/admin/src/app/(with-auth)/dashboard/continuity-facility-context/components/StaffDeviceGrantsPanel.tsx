"use client";

import { UserRoundCheck } from "lucide-react";
import type { ContinuityFacilityGrant } from "@/lib/api/continuityFacilityContext";
import {
  EnrollmentForm,
  GrantDetails,
  RevokeGrantButton,
  type EnrollGrant,
  type RevokeGrant,
} from "./GrantPanelPrimitives";

interface StaffDeviceGrantsPanelProps {
  grants: ContinuityFacilityGrant[];
  onEnroll: EnrollGrant;
  onRevoke: RevokeGrant;
  onChanged: () => void;
}

export function StaffDeviceGrantsPanel({
  grants,
  onEnroll,
  onRevoke,
  onChanged,
}: StaffDeviceGrantsPanelProps) {
  const staffGrants = grants.filter(
    (grant) => grant.grant_purpose === "capture_staff_facility",
  );

  return (
    <section aria-labelledby="staff-device-grants" className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <UserRoundCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <h2 id="staff-device-grants" className="text-lg font-semibold">
              Staff/device facility grants
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Authority is the exact Staff UID + stable device UUID + facility
              ID tuple returned by the ledger. A person&apos;s authorized set is
              the set of that person&apos;s grants; this page does not invent a
              standalone roster.
            </p>
          </div>
        </div>
        <div className="mt-5">
          <EnrollmentForm
            purpose="capture_staff_facility"
            onEnroll={onEnroll}
            onChanged={onChanged}
          />
        </div>
      </div>

      {staffGrants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          The server returned no staff/device facility grants.
        </div>
      ) : (
        <div className="space-y-4">
          {staffGrants.map((grant) => (
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
