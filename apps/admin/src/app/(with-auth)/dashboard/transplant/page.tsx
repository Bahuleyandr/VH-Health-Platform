// src/app/(with-auth)/dashboard/transplant/page.tsx
"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ClipboardCheck,
  FileCheck2,
  HeartPulse,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";

type TransplantProgram = {
  id: number;
  organ: string;
  service_line: string;
  site: string;
  status: string;
  notto_evidence_reference?: string | null;
};

type TransplantCandidate = {
  id: number;
  program_id: number;
  patient_uid: string;
  patient_name?: string | null;
  diagnosis: string;
  required_organs: string[];
  listing_evaluation_status: string;
  committee_status: string;
  updated_at?: string | null;
};

type WaitlistRow = {
  candidate_id: number;
  status: string;
  reason?: string | null;
  created_at?: string | null;
};

type CommitteeReview = {
  id: number;
  candidate_id?: number | null;
  review_date?: string | null;
  decision: string;
  quorum_policy_reference: string;
  affects_candidate: boolean;
};

type DonorReferral = {
  id: number;
  donor_type: string;
  source: string;
  relation_category?: string | null;
  status: string;
  created_at?: string | null;
};

type NottoExport = {
  id: number;
  owner_reviewed_status: string;
  upload_reference_id?: string | null;
  released_at?: string | null;
};

type TransplantDashboard = {
  enabled: boolean;
  programs: TransplantProgram[];
  candidates: TransplantCandidate[];
  waitlist: WaitlistRow[];
  committee_reviews: CommitteeReview[];
  donor_referrals: DonorReferral[];
  notto_exports: NottoExport[];
  counts: {
    programs: number;
    candidates: number;
    listed: number;
    committee_reviews: number;
    donor_referrals: number;
    notto_exports: number;
  };
};

function titleize(value?: string | null) {
  return String(value || "-").replace(/_/g, " ");
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString();
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof HeartPulse;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

export default function TransplantPage() {
  const dashboard = useQuery({
    queryKey: ["transplant", "dashboard"],
    queryFn: () =>
      fetchAdminAPI<{ dashboard: TransplantDashboard }>(
        "/transplant/dashboard?limit=100",
      ),
    refetchInterval: 60_000,
  });

  const data = dashboard.data?.dashboard;
  const waitlistByCandidate = useMemo(() => {
    const map = new Map<number, WaitlistRow>();
    for (const row of data?.waitlist ?? []) map.set(Number(row.candidate_id), row);
    return map;
  }, [data?.waitlist]);

  const latestCommitteeByCandidate = useMemo(() => {
    const map = new Map<number, CommitteeReview>();
    for (const review of data?.committee_reviews ?? []) {
      if (review.candidate_id && !map.has(Number(review.candidate_id))) {
        map.set(Number(review.candidate_id), review);
      }
    }
    return map;
  }, [data?.committee_reviews]);

  const rows = data?.candidates ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            Transplant Program
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Candidate evaluation, waitlist coordination, committee outcomes, donor referrals, and NOTTO evidence status.
          </p>
        </div>
        <button
          type="button"
          onClick={() => dashboard.refetch()}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          disabled={dashboard.isFetching}
        >
          <RefreshCw
            className={`h-4 w-4 ${dashboard.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard
          icon={HeartPulse}
          label="Active programs"
          value={(data?.programs ?? []).filter((program) => program.status === "active").length}
        />
        <MetricCard icon={Users} label="Candidates" value={data?.counts.candidates ?? "-"} />
        <MetricCard icon={ClipboardCheck} label="Listed" value={data?.counts.listed ?? "-"} />
        <MetricCard icon={FileCheck2} label="NOTTO ledgers" value={data?.counts.notto_exports ?? "-"} />
      </div>

      {data && !data.enabled ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Transplant program management is configured but not enabled for this tenant.
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">
            Candidate Coordination
          </h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            Privileged clinical acts
          </div>
        </div>
        {dashboard.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">
            Loading transplant program data...
          </div>
        ) : dashboard.error ? (
          <div className="p-6 text-sm text-red-600">
            Unable to load transplant program data.
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No transplant candidates found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">Organs</th>
                  <th className="px-4 py-3">Evaluation</th>
                  <th className="px-4 py-3">Committee</th>
                  <th className="px-4 py-3">Waitlist</th>
                  <th className="px-4 py-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const waitlist = waitlistByCandidate.get(Number(row.id));
                  const committee = latestCommitteeByCandidate.get(Number(row.id));
                  return (
                    <tr key={row.id} className="border-t">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">
                          {row.patient_name || row.patient_uid}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.diagnosis}
                        </div>
                      </td>
                      <td className="px-4 py-3 capitalize">
                        {row.required_organs.map(titleize).join(", ")}
                      </td>
                      <td className="px-4 py-3 capitalize">
                        {titleize(row.listing_evaluation_status)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="capitalize">
                          {titleize(row.committee_status)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {committee ? titleize(committee.decision) : "No review"}
                        </div>
                      </td>
                      <td className="px-4 py-3 capitalize">
                        {waitlist ? titleize(waitlist.status) : "-"}
                      </td>
                      <td className="px-4 py-3">{formatDate(row.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-base font-semibold text-foreground">
              Donor Referrals
            </h2>
          </div>
          {(data?.donor_referrals ?? []).length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No donor referrals recorded.
            </div>
          ) : (
            <div className="divide-y">
              {data?.donor_referrals.slice(0, 6).map((referral) => (
                <div key={referral.id} className="p-4 text-sm">
                  <div className="font-medium text-foreground">{referral.source}</div>
                  <div className="mt-1 text-muted-foreground">
                    {titleize(referral.donor_type)} donor - {titleize(referral.status)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-base font-semibold text-foreground">
              NOTTO Ledger
            </h2>
          </div>
          {(data?.notto_exports ?? []).length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No NOTTO export packages recorded.
            </div>
          ) : (
            <div className="divide-y">
              {data?.notto_exports.slice(0, 6).map((row) => (
                <div key={row.id} className="p-4 text-sm">
                  <div className="font-medium capitalize text-foreground">
                    {titleize(row.owner_reviewed_status)}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {row.upload_reference_id || "Awaiting owner reference"} - {formatDate(row.released_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
