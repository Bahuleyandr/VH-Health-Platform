// src/app/(with-auth)/dashboard/physiotherapy/page.tsx
"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw, Stethoscope, TrendingUp } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";

type PhysioPlan = {
  care_plan_id: number;
  patient_uid: string;
  patient_name: string;
  display_name: string;
  status: string;
  start_date?: string | null;
  target_end_date?: string | null;
  assessment_count: number;
  session_count: number;
  completed_session_count: number;
  latest_outcome_score?: number | string | null;
  latest_outcome_kind?: string | null;
  latest_outcome_at?: string | null;
};

type PhysioProgress = {
  plans: PhysioPlan[];
  count: number;
};

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString();
}

function titleize(value?: string | null) {
  return String(value || "-").replace(/_/g, " ");
}

function score(value?: number | string | null) {
  if (value === null || value === undefined || value === "") return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(0) : String(value);
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
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

export default function PhysiotherapyPage() {
  const progress = useQuery({
    queryKey: ["physio", "admin-progress"],
    queryFn: () =>
      fetchAdminAPI<PhysioProgress>("/physio/admin/progress?limit=100"),
    refetchInterval: 60_000,
  });

  const rows = useMemo(
    () => progress.data?.plans ?? [],
    [progress.data?.plans],
  );
  const metrics = useMemo(() => {
    const active = rows.filter((row) =>
      ["active", "draft", "on_hold", "paused"].includes(row.status),
    ).length;
    const sessions = rows.reduce(
      (sum, row) => sum + Number(row.completed_session_count || 0),
      0,
    );
    const latestScores = rows
      .map((row) => Number(row.latest_outcome_score))
      .filter((value) => Number.isFinite(value));
    const avgScore = latestScores.length
      ? Math.round(
          latestScores.reduce((sum, value) => sum + value, 0) /
            latestScores.length,
        )
      : "-";
    return { active, sessions, avgScore };
  }, [rows]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Physiotherapy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rehab plans, session completion, and latest outcome score movement.
          </p>
        </div>
        <button
          type="button"
          onClick={() => progress.refetch()}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          disabled={progress.isFetching}
        >
          <RefreshCw
            className={`h-4 w-4 ${progress.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard
          icon={Stethoscope}
          label="Active rehab plans"
          value={metrics.active}
        />
        <MetricCard
          icon={Activity}
          label="Completed sessions"
          value={metrics.sessions}
        />
        <MetricCard
          icon={TrendingUp}
          label="Average latest outcome"
          value={metrics.avgScore}
        />
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">
            Plan Progress
          </h2>
        </div>
        {progress.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">
            Loading physiotherapy progress...
          </div>
        ) : progress.error ? (
          <div className="p-6 text-sm text-red-600">
            Unable to load physiotherapy progress.
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No rehab plans found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Assessments</th>
                  <th className="px-4 py-3">Sessions</th>
                  <th className="px-4 py-3">Latest Outcome</th>
                  <th className="px-4 py-3">Window</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.care_plan_id} className="border-t">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">
                        {row.patient_name || row.patient_uid}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {row.patient_uid}
                      </div>
                    </td>
                    <td className="px-4 py-3">{row.display_name}</td>
                    <td className="px-4 py-3 capitalize">
                      {titleize(row.status)}
                    </td>
                    <td className="px-4 py-3">{row.assessment_count}</td>
                    <td className="px-4 py-3">
                      {row.completed_session_count}/{row.session_count}
                    </td>
                    <td className="px-4 py-3">
                      <div>{score(row.latest_outcome_score)}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.latest_outcome_kind
                          ? titleize(row.latest_outcome_kind)
                          : "-"}{" "}
                        - {formatDate(row.latest_outcome_at)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {formatDate(row.start_date)} -{" "}
                      {formatDate(row.target_end_date)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
