"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  getEngagementSettings,
  listEngagementCampaigns,
  listEngagementTemplates,
  type EngagementCampaign,
} from "@/lib/api/engagement";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, RefreshCw } from "lucide-react";
import { useState } from "react";

import { CampaignComposer } from "./components/CampaignComposer";
import {
  CampaignsPanel,
  type CampaignStatusFilter,
} from "./components/CampaignsPanel";
import { CampaignWorkflow } from "./components/CampaignWorkflow";
import { SettingsPanel } from "./components/SettingsPanel";
import { TemplateStudio } from "./components/TemplateStudio";

const CAMPAIGNS_KEY = "engagement-campaigns";
const TEMPLATES_KEY = "engagement-templates";

/**
 * NL9 patient-engagement campaign authoring.
 *
 * Campaigns and templates are read back from the backend
 * (`GET /engagement/campaigns`, `/campaigns/:id`, `/templates`), all
 * tenant-scoped, so a campaign is visible to anyone who can open this console
 * rather than only to the browser session that created it. That is what lets a
 * campaign be approved from somewhere other than the tab that submitted it; it
 * is not a requester/approver separation, and the backend does not enforce one
 * (approveCampaign gates on role only — see
 * apps/backend/src/routes/engagement/engagementListQueries.js).
 *
 * The workflow panel always drives a campaign object the backend returned —
 * a list row, a by-id lookup, or the result of the last transition — never a
 * locally invented one. The list is re-fetched after every transition.
 */
export default function EngagementPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<CampaignStatusFilter>("");
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(
    null,
  );
  // The campaign the workflow panel is acting on, exactly as the backend last
  // returned it. It may not be on the list page currently loaded — a by-id
  // lookup deliberately reaches past the filter.
  const [openCampaign, setOpenCampaign] = useState<EngagementCampaign | null>(
    null,
  );

  const settingsQuery = useQuery({
    queryKey: ["engagement-settings"],
    queryFn: getEngagementSettings,
  });

  const campaignsQuery = useQuery({
    queryKey: [CAMPAIGNS_KEY, statusFilter],
    queryFn: () =>
      listEngagementCampaigns({
        ...(statusFilter ? { status: statusFilter } : {}),
        limit: 50,
      }),
  });

  const templatesQuery = useQuery({
    queryKey: [TEMPLATES_KEY],
    queryFn: () => listEngagementTemplates({ limit: 100 }),
  });

  const campaigns = campaignsQuery.data?.campaigns ?? [];
  const templates = templatesQuery.data?.templates ?? [];

  /** A row click or a by-id lookup: drive the workflow panel from this row. */
  const showCampaign = (campaign: EngagementCampaign) => {
    setOpenCampaign(campaign);
    setSelectedCampaignId(campaign.id);
  };

  /** A create or a state transition: show it at once, then re-read the list. */
  const onCampaignChanged = (campaign: EngagementCampaign) => {
    showCampaign(campaign);
    void queryClient.invalidateQueries({ queryKey: [CAMPAIGNS_KEY] });
  };

  const selectedCampaign =
    openCampaign && openCampaign.id === selectedCampaignId
      ? openCampaign
      : (campaigns.find((item) => item.id === selectedCampaignId) ?? null);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
            NL9 Engagement
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-950">
            Engagement Campaigns
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Consent-gated patient outreach with a mandatory dry-run and approval
            step before anything can be queued for delivery.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void settingsQuery.refetch()}
          className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh settings
        </button>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Campaigns and templates are listed for the whole tenant, so a campaign
          waiting on approval can be found and opened by an approver who did not
          submit it. Approval is gated on your role, and the backend records who
          approved.
        </span>
      </div>

      {settingsQuery.isLoading && (
        <LoadingSpinner label="Loading engagement settings…" />
      )}
      {settingsQuery.error instanceof Error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {settingsQuery.error.message}
        </div>
      )}
      {settingsQuery.data && <SettingsPanel settings={settingsQuery.data} />}

      <CampaignsPanel
        campaigns={campaigns}
        pagination={campaignsQuery.data?.pagination}
        isLoading={campaignsQuery.isLoading}
        isFetching={campaignsQuery.isFetching}
        error={campaignsQuery.error}
        status={statusFilter}
        onStatusChange={setStatusFilter}
        selectedId={selectedCampaignId}
        onSelect={showCampaign}
        onRefresh={() => void campaignsQuery.refetch()}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <TemplateStudio
          templates={templates}
          isLoading={templatesQuery.isLoading}
          error={templatesQuery.error}
          onCreated={() =>
            void queryClient.invalidateQueries({ queryKey: [TEMPLATES_KEY] })
          }
        />
        <CampaignComposer templates={templates} onCreated={onCampaignChanged} />
      </div>

      {selectedCampaign ? (
        <CampaignWorkflow
          key={selectedCampaign.id}
          campaign={selectedCampaign}
          onUpdate={onCampaignChanged}
        />
      ) : (
        <EmptyState
          compact
          title="No campaign selected"
          description="Open a campaign from the list above, or create a draft to start the dry-run → approval → queue workflow."
        />
      )}
    </div>
  );
}
