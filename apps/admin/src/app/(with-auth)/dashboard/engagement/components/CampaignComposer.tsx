"use client";

import {
  ENGAGEMENT_CAMPAIGN_TYPES,
  ENGAGEMENT_CHANNELS,
  createEngagementCampaign,
  type EngagementCampaign,
  type EngagementCampaignType,
  type EngagementChannel,
  type EngagementTemplate,
} from "@/lib/api/engagement";
import { useMutation } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { FieldLabel, SectionCard, inputClass } from "./shared";

/**
 * Campaign creation. Campaigns are born as drafts; the workflow panel walks
 * them through dry-run -> approval -> queueing. A broad audience escalates
 * the approval requirement to admin/quality roles server-side.
 */
export function CampaignComposer({
  templates,
  onCreated,
}: {
  templates: EngagementTemplate[];
  onCreated: (campaign: EngagementCampaign) => void;
}) {
  const [campaignType, setCampaignType] = useState<EngagementCampaignType>(
    ENGAGEMENT_CAMPAIGN_TYPES[0],
  );
  const [templateId, setTemplateId] = useState("");
  const [objective, setObjective] = useState("");
  const [channels, setChannels] = useState<EngagementChannel[]>([]);
  const [audienceKind, setAudienceKind] = useState<"cohort" | "broad">(
    "cohort",
  );

  const mutation = useMutation({
    mutationFn: () =>
      createEngagementCampaign({
        campaign_type: campaignType,
        template_id: Number.parseInt(templateId, 10) || 0,
        objective: objective.trim(),
        channels: channels.length ? channels : undefined,
        audience_kind: audienceKind,
      }),
    onSuccess: (campaign) => {
      toast.success(`Campaign #${campaign.id} created as draft`);
      onCreated(campaign);
      setObjective("");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Campaign creation failed"),
  });

  const toggleChannel = (channel: EngagementChannel) =>
    setChannels((current) =>
      current.includes(channel)
        ? current.filter((item) => item !== channel)
        : [...current, channel],
    );

  return (
    <SectionCard title="New Campaign" icon={<Megaphone className="h-4 w-4" />}>
      <div className="grid gap-3 md:grid-cols-2">
        <FieldLabel label="Campaign type" htmlFor="campaign-type">
          <select
            id="campaign-type"
            className={inputClass}
            value={campaignType}
            onChange={(e) =>
              setCampaignType(e.target.value as EngagementCampaignType)
            }
          >
            {ENGAGEMENT_CAMPAIGN_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </FieldLabel>
        <FieldLabel label="Template id" htmlFor="campaign-template-id">
          {templates.length > 0 ? (
            <select
              id="campaign-template-id"
              className={inputClass}
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">Select a session template…</option>
              {templates.map((template) => (
                <option key={template.id} value={String(template.id)}>
                  #{template.id} — {template.template_kind.replace(/_/g, " ")} (
                  {template.channel})
                </option>
              ))}
            </select>
          ) : (
            <input
              id="campaign-template-id"
              aria-label="Template id"
              className={inputClass}
              inputMode="numeric"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              placeholder="approved engagement template id"
            />
          )}
        </FieldLabel>
        <div className="md:col-span-2">
          <FieldLabel label="Objective" htmlFor="campaign-objective">
            <textarea
              id="campaign-objective"
              aria-label="Objective"
              className={`${inputClass} min-h-16`}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Why this outreach exists — recorded on the campaign."
            />
          </FieldLabel>
        </div>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-muted-foreground">
            Channels (defaults to the template channel)
          </legend>
          <div className="flex flex-wrap gap-2">
            {ENGAGEMENT_CHANNELS.map((channel) => (
              <label
                key={channel}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
              >
                <input
                  type="checkbox"
                  aria-label={channel}
                  checked={channels.includes(channel)}
                  onChange={() => toggleChannel(channel)}
                />
                {channel}
              </label>
            ))}
          </div>
        </fieldset>
        <FieldLabel label="Audience kind" htmlFor="campaign-audience">
          <select
            id="campaign-audience"
            className={inputClass}
            value={audienceKind}
            onChange={(e) =>
              setAudienceKind(e.target.value === "broad" ? "broad" : "cohort")
            }
          >
            <option value="cohort">cohort — care-team approval</option>
            <option value="broad">broad — admin/quality approval</option>
          </select>
        </FieldLabel>
      </div>
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || !templateId.trim() || !objective.trim()}
        className="mt-4 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        Create draft campaign
      </button>
    </SectionCard>
  );
}
