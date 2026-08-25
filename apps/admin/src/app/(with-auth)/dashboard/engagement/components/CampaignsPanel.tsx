"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  ENGAGEMENT_CAMPAIGN_STATUSES,
  getEngagementCampaign,
  type EngagementCampaign,
  type EngagementCampaignStatus,
  type EngagementPagination,
} from "@/lib/api/engagement";
import { useMutation } from "@tanstack/react-query";
import { ListChecks, RefreshCw } from "lucide-react";
import { useState } from "react";

import { SectionCard, StatusPill, formatDateTime, inputClass } from "./shared";

export type CampaignStatusFilter = EngagementCampaignStatus | "";

/**
 * Tenant-scoped campaign list, read from `GET /engagement/campaigns`, plus a
 * by-id lookup on `GET /engagement/campaigns/:campaignId`.
 *
 * Before this panel existed the console could only show campaigns the current
 * browser session had created, so a campaign submitted from another machine was
 * invisible and could not be opened. The lookup covers the case where someone
 * was given a campaign number that is not on the page the list currently shows.
 *
 * This makes a campaign findable by someone other than its author. It does NOT
 * make that separation a rule: the backend's approve step
 * (services/engagement/engagementCampaignService.js#approveCampaign) gates on
 * the caller's role alone and never compares the approver against
 * `submitted_by`, so the submitter may approve their own campaign.
 */
export function CampaignsPanel({
  campaigns,
  pagination,
  isLoading,
  isFetching,
  error,
  status,
  onStatusChange,
  selectedId,
  onSelect,
  onRefresh,
}: {
  campaigns: EngagementCampaign[];
  pagination?: EngagementPagination;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  status: CampaignStatusFilter;
  onStatusChange: (status: CampaignStatusFilter) => void;
  selectedId: number | null;
  onSelect: (campaign: EngagementCampaign) => void;
  onRefresh: () => void;
}) {
  const [lookupId, setLookupId] = useState("");
  const lookup = useMutation({
    mutationFn: (campaignId: number) => getEngagementCampaign(campaignId),
    onSuccess: onSelect,
  });

  const shown = pagination
    ? `${campaigns.length} of ${pagination.total}`
    : String(campaigns.length);

  return (
    <SectionCard
      title="Campaigns"
      icon={<ListChecks className="h-4 w-4" />}
      actions={
        <div className="flex items-center gap-2">
          <label
            htmlFor="campaign-status-filter"
            className="text-xs font-medium text-muted-foreground"
          >
            Status
          </label>
          <select
            id="campaign-status-filter"
            aria-label="Status"
            className={`${inputClass} w-44 py-1`}
            value={status}
            onChange={(e) =>
              onStatusChange(e.target.value as CampaignStatusFilter)
            }
          >
            <option value="">All statuses</option>
            {ENGAGEMENT_CAMPAIGN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground disabled:opacity-60"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      }
    >
      {error instanceof Error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          Could not load campaigns: {error.message}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label
          htmlFor="campaign-lookup-id"
          className="text-xs font-medium text-muted-foreground"
        >
          Open campaign by number
        </label>
        <input
          id="campaign-lookup-id"
          aria-label="Open campaign by number"
          inputMode="numeric"
          className={`${inputClass} w-28 py-1`}
          value={lookupId}
          placeholder="e.g. 77"
          onChange={(e) => setLookupId(e.target.value)}
        />
        <button
          type="button"
          onClick={() => lookup.mutate(Number.parseInt(lookupId, 10))}
          disabled={lookup.isPending || !/^[1-9][0-9]*$/.test(lookupId.trim())}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground disabled:opacity-60"
        >
          {lookup.isPending ? "Opening…" : "Open"}
        </button>
        {lookup.error instanceof Error && (
          <span role="alert" className="text-xs text-red-700">
            {lookup.error.message}
          </span>
        )}
      </div>

      {isLoading ? (
        <LoadingSpinner label="Loading campaigns…" />
      ) : campaigns.length === 0 ? (
        <EmptyState
          compact
          title={
            status
              ? `No campaigns with status "${status.replace(/_/g, " ")}"`
              : "No campaigns yet for this tenant"
          }
          description="Create a draft campaign below to start the dry-run → approval → queue workflow."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Campaign</th>
                  <th className="px-3 py-2">Objective</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Submitted</th>
                  <th className="px-3 py-2">Last updated</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Open campaign</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {campaigns.map((campaign) => (
                  <tr
                    key={campaign.id}
                    className={
                      campaign.id === selectedId ? "bg-teal-50/60" : undefined
                    }
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="font-medium text-foreground">
                        #{campaign.id}
                      </span>{" "}
                      <span className="text-xs text-muted-foreground">
                        {campaign.campaign_type.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 text-muted-foreground">
                      {campaign.objective}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill value={campaign.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {formatDateTime(campaign.submitted_at)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {formatDateTime(campaign.updated_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onSelect(campaign)}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground"
                      >
                        {campaign.status === "pending_approval"
                          ? `Review #${campaign.id}`
                          : `Open #${campaign.id}`}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Showing {shown} campaigns
            {pagination && pagination.hasNext
              ? ` — page ${pagination.page} of ${pagination.totalPages}; narrow the status filter to reach the rest.`
              : "."}
          </p>
        </>
      )}
    </SectionCard>
  );
}
