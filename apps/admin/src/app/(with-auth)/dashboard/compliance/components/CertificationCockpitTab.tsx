"use client";

import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, ClipboardList, ExternalLink, ShieldCheck } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

import type { CertificationCockpitResponse, CertificationTrack } from "./types";
import { fmtDate, StatCard, unwrap } from "./shared";

const STATUS_STYLES: Record<string, string> = {
  accepted: "border-green-200 bg-green-50 text-green-800",
  open: "border-amber-200 bg-amber-50 text-amber-800",
};

function prettify(value?: string | null) {
  return value ? value.replaceAll("_", " ") : "-";
}

function TrackStatus({ track }: { track: CertificationTrack }) {
  const cls = STATUS_STYLES[track.acceptance_state] ?? "border-border bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {track.acceptance_state}
    </span>
  );
}

function EvidenceLink({ uri }: { uri?: string | null }) {
  if (!uri) return <span className="text-muted-foreground">-</span>;
  if (/^https?:\/\//i.test(uri)) {
    return (
      <a className="inline-flex items-center gap-1 text-primary hover:underline" href={uri} target="_blank" rel="noreferrer">
        Evidence
        <ExternalLink className="h-3 w-3" />
      </a>
    );
  }
  return <span className="font-mono text-xs">{uri}</span>;
}

export function CertificationCockpitTab() {
  const { data, isLoading, isError, error } = useQuery<CertificationCockpitResponse>({
    queryKey: ["compliance-certification-cockpit"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/compliance/certification-cockpit");
      return unwrap<CertificationCockpitResponse>(res);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
        {error instanceof Error ? error.message : "Failed to load certification cockpit"}
      </div>
    );
  }

  const openTracks = data.tracks.filter((track) => track.acceptance_state === "open");
  const nextBlockers = openTracks.flatMap((track) =>
    track.blockers.slice(0, 2).map((blocker) => ({ stage: track.stage, blocker })),
  ).slice(0, 6);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Accepted rows"
          value={`${data.summary.accepted_count}/${data.summary.total_tracks}`}
          emphasis={data.summary.open_count === 0 ? "ok" : "neutral"}
        />
        <StatCard
          label="Open rows"
          value={data.summary.open_count}
          emphasis={data.summary.open_count > 0 ? "warn" : "ok"}
        />
        <StatCard
          label="Blockers"
          value={data.summary.blocker_count}
          emphasis={data.summary.blocker_count > 0 ? "danger" : "ok"}
        />
        <StatCard
          label="Externally certified"
          value={data.summary.externally_certified_count}
          hint={`${data.summary.cert_ready_count} cert-ready tracks`}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-6">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            ABDM and assurance evidence rows
          </h2>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Track</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Evidence state</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Engagement</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">External status</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Evidence</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Runbook</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.tracks.map((track) => (
                  <tr key={track.control_code} className="align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{track.stage}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{track.control_code}</div>
                      {track.supporting_controls.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {track.supporting_controls.map((control) => (
                            <span
                              key={control.control_code}
                              className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                                control.acceptance_state === "accepted"
                                  ? "border-green-200 bg-green-50 text-green-700"
                                  : "border-border bg-muted text-muted-foreground"
                              }`}
                            >
                              {control.control_code}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <TrackStatus track={track} />
                      <div className="mt-1 text-xs text-muted-foreground">{track.status}</div>
                    </td>
                    <td className="px-3 py-2 capitalize">{prettify(track.engagement_status)}</td>
                    <td className="px-3 py-2 capitalize">{prettify(track.external_certification_status)}</td>
                    <td className="px-3 py-2">
                      <EvidenceLink uri={track.evidence_uri} />
                      {track.verified_at ? (
                        <div className="mt-1 text-xs text-muted-foreground">{fmtDate(track.verified_at)}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{track.runbook_uri}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="space-y-3">
          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <BadgeCheck className="h-4 w-4" />
              Declaration boundary
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Cert-ready</dt>
                <dd className="font-medium">{data.declaration_boundary.cert_ready_label}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">External</dt>
                <dd className="font-medium">{data.declaration_boundary.externally_certified_label}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">{data.declaration_boundary.rule}</p>
          </section>

          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              Current blockers
            </h2>
            {nextBlockers.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No open blockers in the cockpit rows.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {nextBlockers.map((item) => (
                  <li key={`${item.stage}-${item.blocker}`} className="text-sm">
                    <span className="font-medium">{item.stage}:</span>{" "}
                    <span className="text-muted-foreground">{item.blocker}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <p className="text-xs text-muted-foreground">
        Snapshot: {fmtDate(data.generated_at)}.
      </p>
    </div>
  );
}

export default CertificationCockpitTab;
