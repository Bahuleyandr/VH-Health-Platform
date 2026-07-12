"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import {
  OUTCOMES,
  REVIEW_STATUSES,
  SEVERITIES,
  type RegistryEntry,
  type RegistryResponse,
} from "./types";

const SEVERITY_STYLES: Record<string, string> = {
  unspecified: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  minor: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  moderate: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  severe: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  fatal: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString();
}

type ReviewDraft = {
  review_status: string;
  outcome: string;
  review_notes: string;
};

export default function ComplicationRegistryTab() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>({
    review_status: "under_review",
    outcome: "",
    review_notes: "",
  });

  const registryQuery = useQuery({
    queryKey: ["cath-complication-registry", statusFilter, severityFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("review_status", statusFilter);
      if (severityFilter) params.set("severity", severityFilter);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return fetchAdminAPI<RegistryResponse>(
        `/quality/cath/complication-registry${suffix}`,
      );
    },
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, string> }) =>
      fetchAdminAPI<{ entry: RegistryEntry }>(
        `/quality/cath/complication-registry/${id}/review`,
        { method: "POST", body },
      ),
    onSuccess: () => {
      toast.success("Review updated");
      setReviewingId(null);
      queryClient.invalidateQueries({ queryKey: ["cath-complication-registry"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Failed to update review");
    },
  });

  const openReview = (entry: RegistryEntry) => {
    setReviewingId(entry.id);
    setDraft({
      review_status: entry.review_status === "closed" ? "under_review" : "reviewed",
      outcome: entry.outcome ?? "",
      review_notes: "",
    });
  };

  const submitReview = (entry: RegistryEntry) => {
    const body: Record<string, string> = { review_status: draft.review_status };
    if (draft.outcome) body.outcome = draft.outcome;
    if (draft.review_notes.trim()) body.review_notes = draft.review_notes.trim();
    reviewMutation.mutate({ id: entry.id, body });
  };

  const entries = registryQuery.data?.entries ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">
            <span className="mb-1 block text-gray-600 dark:text-gray-300">
              Review status
            </span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
            >
              <option value="">All</option>
              {REVIEW_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-gray-600 dark:text-gray-300">Severity</span>
            <select
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
            >
              <option value="">All</option>
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </label>
          <p className="ml-auto text-xs text-gray-500 dark:text-gray-400">
            Registry rows derive from procedure-log complications; category codes
            follow the hospital&apos;s own taxonomy.
          </p>
        </div>

        {registryQuery.isLoading ? (
          <LoadingSpinner label="Loading registry" />
        ) : registryQuery.isError ? (
          <EmptyState
            compact
            title="Couldn't load the complication registry"
            description={
              registryQuery.error instanceof Error
                ? registryQuery.error.message
                : undefined
            }
          />
        ) : entries.length === 0 ? (
          <EmptyState
            compact
            title="No complication registry entries"
            description="Entries appear when cath procedure logs capture complications."
          />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="py-2 pr-3 font-medium">Occurred</th>
                  <th className="py-2 pr-3 font-medium">Patient</th>
                  <th className="py-2 pr-3 font-medium">Procedure</th>
                  <th className="py-2 pr-3 font-medium">Category</th>
                  <th className="py-2 pr-3 font-medium">Severity</th>
                  <th className="py-2 pr-3 font-medium">Outcome</th>
                  <th className="py-2 pr-3 font-medium">Review</th>
                  <th className="py-2 pr-3 font-medium" aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-gray-100 align-top last:border-0 dark:border-gray-800"
                  >
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {formatDate(entry.occurred_at ?? entry.created_at)}
                    </td>
                    <td className="py-2 pr-3">{entry.patient_name ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <div>{entry.requested_procedure}</div>
                      {entry.description ? (
                        <div className="mt-0.5 max-w-xs text-gray-500 dark:text-gray-400">
                          {entry.description}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <div>{entry.complication_category}</div>
                      {entry.complication_code ? (
                        <div className="text-gray-500 dark:text-gray-400">
                          {entry.complication_code}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 font-medium ${
                          SEVERITY_STYLES[entry.severity] ?? SEVERITY_STYLES.unspecified
                        }`}
                      >
                        {entry.severity}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{entry.outcome ?? "—"}</td>
                    <td className="py-2 pr-3 capitalize">
                      {entry.review_status.replaceAll("_", " ")}
                    </td>
                    <td className="py-2 pr-3">
                      {reviewingId === entry.id ? (
                        <div className="w-56 space-y-2">
                          <select
                            value={draft.review_status}
                            onChange={(event) =>
                              setDraft((prev) => ({
                                ...prev,
                                review_status: event.target.value,
                              }))
                            }
                            className="w-full rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
                          >
                            {REVIEW_STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {status.replaceAll("_", " ")}
                              </option>
                            ))}
                          </select>
                          <select
                            value={draft.outcome}
                            onChange={(event) =>
                              setDraft((prev) => ({
                                ...prev,
                                outcome: event.target.value,
                              }))
                            }
                            className="w-full rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
                          >
                            <option value="">outcome unchanged</option>
                            {OUTCOMES.map((outcome) => (
                              <option key={outcome} value={outcome}>
                                {outcome}
                              </option>
                            ))}
                          </select>
                          <textarea
                            value={draft.review_notes}
                            onChange={(event) =>
                              setDraft((prev) => ({
                                ...prev,
                                review_notes: event.target.value,
                              }))
                            }
                            placeholder="Review notes"
                            rows={2}
                            className="w-full rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => submitReview(entry)}
                              disabled={reviewMutation.isPending}
                              className="rounded-md bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              {reviewMutation.isPending ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setReviewingId(null)}
                              className="rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openReview(entry)}
                          className="rounded-md border border-gray-300 px-2 py-1 font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
                        >
                          Review
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
