import { FileClock } from "lucide-react";
import type { ContinuityFacilityGrant } from "@/lib/api/continuityFacilityContext";

type LedgerEvent =
  | {
      kind: "grant";
      id: string;
      revision: string;
      grant: ContinuityFacilityGrant;
    }
  | {
      kind: "revocation";
      id: string;
      revision: string;
      grant: ContinuityFacilityGrant;
    };

function compareUnsignedIntegerStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(normalizedLeft) || !/^\d+$/.test(normalizedRight)) {
    return left.localeCompare(right);
  }
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length - normalizedRight.length;
  }
  return normalizedLeft.localeCompare(normalizedRight);
}

function buildEvents(grants: ContinuityFacilityGrant[]): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const grant of grants) {
    events.push({
      kind: "grant",
      id: grant.id,
      revision: grant.capture_revision,
      grant,
    });
    if (grant.revocation_id && grant.revocation_revision) {
      events.push({
        kind: "revocation",
        id: grant.revocation_id,
        revision: grant.revocation_revision,
        grant,
      });
    }
  }
  return events.sort((left, right) =>
    compareUnsignedIntegerStrings(right.revision, left.revision),
  );
}

function EvidenceField({
  label,
  value,
}: {
  label: string;
  value: string | number | null;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-all font-mono text-xs text-foreground">
        {value ?? "Unavailable from server"}
      </dd>
    </div>
  );
}

interface EvidencePanelProps {
  grants: ContinuityFacilityGrant[];
  requestId?: string;
}

export function EvidencePanel({ grants, requestId }: EvidencePanelProps) {
  const events = buildEvents(grants);

  return (
    <section aria-labelledby="grant-ledger-evidence" className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <FileClock className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <h2 id="grant-ledger-evidence" className="text-lg font-semibold">
              Append-only grant-ledger evidence
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This on-screen view preserves the landed GET response. Grants and
              revocations are separate immutable events ordered by their exact
              integer revision strings; this is not a server-signed export.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Retrieval audit reference: {requestId ?? "Not returned"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Historic revoker UID is absent from the list contract and is not
              inferred from the current operator.
            </p>
          </div>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          The server returned no capture grant or revocation events.
        </div>
      ) : (
        <ol className="space-y-4">
          {events.map((event) => {
            const { grant } = event;
            const isRevocation = event.kind === "revocation";
            return (
              <li
                key={`${event.kind}:${event.id}`}
                className="rounded-xl border border-border bg-card p-5 shadow-sm"
              >
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {isRevocation ? "Revocation appended" : "Grant appended"}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {event.id}
                    </p>
                  </div>
                  <span className="rounded-lg border border-border bg-muted px-2.5 py-1 font-mono text-xs">
                    revision {event.revision}
                  </span>
                </div>
                <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <EvidenceField label="Event UUID" value={event.id} />
                  <EvidenceField label="Grant UUID" value={grant.id} />
                  <EvidenceField label="Purpose" value={grant.grant_purpose} />
                  <EvidenceField
                    label="Subject kind"
                    value={grant.subject_kind}
                  />
                  <EvidenceField label="Staff UID" value={grant.staff_uid} />
                  <EvidenceField
                    label="Stable device UUID"
                    value={grant.device_id}
                  />
                  <EvidenceField
                    label="Facility ID"
                    value={grant.facility_id}
                  />
                  <EvidenceField
                    label="Credential SHA-256"
                    value={grant.device_credential_sha256}
                  />
                  <EvidenceField
                    label="Policy UUID"
                    value={grant.policy_version_id}
                  />
                  <EvidenceField
                    label="Policy version"
                    value={grant.policy_version}
                  />
                  <EvidenceField label="Valid from" value={grant.valid_from} />
                  <EvidenceField
                    label="Valid until"
                    value={grant.valid_until}
                  />
                  <EvidenceField
                    label={isRevocation ? "Revoked at" : "Created at"}
                    value={isRevocation ? grant.revoked_at : grant.created_at}
                  />
                  <EvidenceField
                    label={isRevocation ? "Historic revoker UID" : "Created by"}
                    value={isRevocation ? null : grant.created_by}
                  />
                  {isRevocation && (
                    <EvidenceField label="Reason" value={grant.reason} />
                  )}
                </dl>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
