"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  getEngagementSettings,
  type EngagementCampaign,
  type EngagementTemplate,
} from "@/lib/api/engagement";
import { useQuery } from "@tanstack/react-query";
import { Info, RefreshCw } from "lucide-react";
import { useState } from "react";

import { CampaignComposer } from "./components/CampaignComposer";
import { CampaignWorkflow } from "./components/CampaignWorkflow";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusPill } from "./components/shared";
import { TemplateStudio } from "./components/TemplateStudio";

/**
 * NL9 patient-engagement campaign authoring.
 *
 * The backend deliberately ships no list/read endpoints for templates or
 * campaigns — only creates and audited state transitions — so this page is a
 * session workspace: objects created here stay editable here, and every
 * status shown is the one the backend last returned.
 */
export default function EngagementPage() {
  const [templates, setTemplates] = useState<EngagementTemplate[]>([]);
  const [campaigns, setCampaigns] = useState<EngagementCampaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(
    null,
  );

  const settingsQuery = useQuery({
    queryKey: ["engagement-settings"],
    queryFn: getEngagementSettings,
  });

  const upsertCampaign = (campaign: EngagementCampaign) => {
    setCampaigns((current) => {
      const exists = current.some((item) => item.id === campaign.id);
      return exists
        ? current.map((item) => (item.id === campaign.id ? campaign : item))
        : [...current, campaign];
    });
    setSelectedCampaignId(campaign.id);
  };

  const selectedCampaign =
    campaigns.find((item) => item.id === selectedCampaignId) ?? null;

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
          The engagement API exposes no listing endpoints — templates and
          campaigns created or transitioned in this session appear below.
          Reloading the page clears the workspace, not the backend records.
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

      <div className="grid gap-4 xl:grid-cols-2">
        <TemplateStudio
          templates={templates}
          onCreated={(template) =>
            setTemplates((current) => [...current, template])
          }
        />
        <CampaignComposer templates={templates} onCreated={upsertCampaign} />
      </div>

      {campaigns.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {campaigns.map((campaign) => (
            <button
              key={campaign.id}
              type="button"
              onClick={() => setSelectedCampaignId(campaign.id)}
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                campaign.id === selectedCampaignId
                  ? "border-teal-400 bg-teal-50 text-teal-900"
                  : "border-border bg-background text-foreground"
              }`}
            >
              #{campaign.id} {campaign.campaign_type.replace(/_/g, " ")}
              <StatusPill value={campaign.status} />
            </button>
          ))}
        </div>
      )}

      {selectedCampaign ? (
        <CampaignWorkflow
          key={selectedCampaign.id}
          campaign={selectedCampaign}
          onUpdate={upsertCampaign}
        />
      ) : (
        <EmptyState
          compact
          title="No campaign selected"
          description="Create a draft campaign above to start the dry-run → approval → queue workflow."
        />
      )}
    </div>
  );
}
