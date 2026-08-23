"use client";

import {
  ENGAGEMENT_CAMPAIGN_TYPES,
  ENGAGEMENT_CHANNELS,
  ENGAGEMENT_TEMPLATE_VARIABLES,
  createEngagementTemplate,
  type EngagementCampaignType,
  type EngagementChannel,
  type EngagementTemplate,
} from "@/lib/api/engagement";
import { useMutation } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { FieldLabel, SectionCard, StatusPill, inputClass } from "./shared";

/**
 * Template authoring. A template binds an existing notification template
 * (by id) to a campaign kind + channel with a whitelisted variable set —
 * the backend rejects any variable outside ENGAGEMENT_TEMPLATE_VARIABLES
 * and any clinical-content value outright.
 */
export function TemplateStudio({
  templates,
  onCreated,
}: {
  templates: EngagementTemplate[];
  onCreated: (template: EngagementTemplate) => void;
}) {
  const [kind, setKind] = useState<EngagementCampaignType>(
    ENGAGEMENT_CAMPAIGN_TYPES[0],
  );
  const [channel, setChannel] = useState<EngagementChannel>("push");
  const [notificationTemplateId, setNotificationTemplateId] = useState("");
  const [locale, setLocale] = useState("en-IN");
  const [variables, setVariables] = useState<string[]>([
    "first_name",
    "clinic_name",
  ]);

  const mutation = useMutation({
    mutationFn: () =>
      createEngagementTemplate({
        template_kind: kind,
        channel,
        notification_template_id:
          Number.parseInt(notificationTemplateId, 10) || 0,
        allowed_variables: variables,
        locale: locale.trim() || "en-IN",
      }),
    onSuccess: (template) => {
      toast.success(`Template #${template.id} created`);
      onCreated(template);
    },
    onError: (err: Error) =>
      toast.error(err.message || "Template creation failed"),
  });

  const toggleVariable = (name: string) =>
    setVariables((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );

  return (
    <SectionCard title="Templates" icon={<FileText className="h-4 w-4" />}>
      <div className="grid gap-3 md:grid-cols-2">
        <FieldLabel label="Campaign kind" htmlFor="template-kind">
          <select
            id="template-kind"
            className={inputClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as EngagementCampaignType)}
          >
            {ENGAGEMENT_CAMPAIGN_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </FieldLabel>
        <FieldLabel label="Channel" htmlFor="template-channel">
          <select
            id="template-channel"
            className={inputClass}
            value={channel}
            onChange={(e) => setChannel(e.target.value as EngagementChannel)}
          >
            {ENGAGEMENT_CHANNELS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </FieldLabel>
        <FieldLabel
          label="Notification template id"
          htmlFor="notification-template-id"
        >
          <input
            id="notification-template-id"
            aria-label="Notification template id"
            className={inputClass}
            inputMode="numeric"
            value={notificationTemplateId}
            onChange={(e) => setNotificationTemplateId(e.target.value)}
            placeholder="existing notification_templates id"
          />
        </FieldLabel>
        <FieldLabel label="Locale" htmlFor="template-locale">
          <input
            id="template-locale"
            aria-label="Locale"
            className={inputClass}
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
          />
        </FieldLabel>
      </div>
      <fieldset className="mt-3">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          Allowed variables (clinical content is blocked server-side)
        </legend>
        <div className="flex flex-wrap gap-2">
          {ENGAGEMENT_TEMPLATE_VARIABLES.map((name) => (
            <label
              key={name}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
            >
              <input
                type="checkbox"
                aria-label={name}
                checked={variables.includes(name)}
                onChange={() => toggleVariable(name)}
              />
              {name}
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || !notificationTemplateId.trim()}
        className="mt-4 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        Create template
      </button>

      <div className="mt-4 divide-y divide-border border-t border-border">
        {templates.length === 0 ? (
          <p className="pt-3 text-sm text-muted-foreground">
            Templates created in this session appear here (the engagement API
            has no template listing endpoint).
          </p>
        ) : (
          templates.map((template) => (
            <div
              key={template.id}
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <div>
                <span className="font-medium text-foreground">
                  #{template.id} · {template.template_kind.replace(/_/g, " ")}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {template.channel} · notification template{" "}
                  {template.notification_template_id}
                </span>
              </div>
              <StatusPill
                value={template.approved_at ? "scheduled" : "pending_approval"}
              />
            </div>
          ))
        )}
      </div>
    </SectionCard>
  );
}
