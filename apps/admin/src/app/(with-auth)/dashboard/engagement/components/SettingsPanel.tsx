"use client";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  updateEngagementSettings,
  type EngagementSettings,
  type EngagementSettingsPatch,
} from "@/lib/api/engagement";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { OctagonAlert, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";

import { FieldLabel, SectionCard, StatusPill, inputClass } from "./shared";

/**
 * Tenant-level engagement guardrails. Enabling outreach requires an
 * acceptance snapshot (backend ENGAGEMENT_ACCEPTANCE_REQUIRED); the
 * emergency stop suppresses every candidate regardless of campaign state.
 */
export function SettingsPanel({ settings }: { settings: EngagementSettings }) {
  const queryClient = useQueryClient();
  const [quietStart, setQuietStart] = useState(settings.quiet_hours_start);
  const [quietEnd, setQuietEnd] = useState(settings.quiet_hours_end);
  const [dailyCap, setDailyCap] = useState(String(settings.tenant_daily_cap));
  const [cooldown, setCooldown] = useState(
    String(settings.per_patient_cooldown_hours),
  );
  const [confirmStop, setConfirmStop] = useState(false);

  useEffect(() => {
    setQuietStart(settings.quiet_hours_start);
    setQuietEnd(settings.quiet_hours_end);
    setDailyCap(String(settings.tenant_daily_cap));
    setCooldown(String(settings.per_patient_cooldown_hours));
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (patch: EngagementSettingsPatch) =>
      updateEngagementSettings({
        // The PUT is a full upsert server-side; resend current values so a
        // partial edit cannot silently reset the other guardrails.
        enabled: settings.enabled,
        acceptance_snapshot: settings.acceptance_snapshot,
        emergency_stop: settings.emergency_stop,
        quiet_hours_start: quietStart,
        quiet_hours_end: quietEnd,
        tenant_daily_cap: Number.parseInt(dailyCap, 10) || 0,
        per_patient_cooldown_hours: Number.parseInt(cooldown, 10) || 0,
        consent_max_age_days: settings.consent_max_age_days,
        channel_caps: settings.channel_caps,
        default_consent_map: settings.default_consent_map,
        ...patch,
      }),
    onSuccess: () => {
      toast.success("Engagement settings updated");
      void queryClient.invalidateQueries({ queryKey: ["engagement-settings"] });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Settings update failed"),
  });

  return (
    <SectionCard
      title="Tenant Guardrails"
      icon={<Settings2 className="h-4 w-4" />}
      actions={
        <div className="flex items-center gap-2">
          <StatusPill value={settings.enabled ? "running" : "draft"} />
          <span className="text-xs text-muted-foreground">
            {settings.enabled ? "outreach enabled" : "outreach disabled"}
          </span>
        </div>
      }
    >
      {settings.emergency_stop && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <OctagonAlert className="h-4 w-4" />
          Emergency stop is active — every candidate is suppressed until it is
          lifted.
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-4">
        <FieldLabel label="Quiet hours start" htmlFor="quiet-start">
          <input
            id="quiet-start"
            aria-label="Quiet hours start"
            className={inputClass}
            value={quietStart}
            onChange={(e) => setQuietStart(e.target.value)}
            placeholder="21:00"
          />
        </FieldLabel>
        <FieldLabel label="Quiet hours end" htmlFor="quiet-end">
          <input
            id="quiet-end"
            aria-label="Quiet hours end"
            className={inputClass}
            value={quietEnd}
            onChange={(e) => setQuietEnd(e.target.value)}
            placeholder="08:00"
          />
        </FieldLabel>
        <FieldLabel label="Tenant daily cap" htmlFor="daily-cap">
          <input
            id="daily-cap"
            aria-label="Tenant daily cap"
            className={inputClass}
            inputMode="numeric"
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
          />
        </FieldLabel>
        <FieldLabel label="Per-patient cooldown (hours)" htmlFor="cooldown">
          <input
            id="cooldown"
            aria-label="Per-patient cooldown (hours)"
            className={inputClass}
            inputMode="numeric"
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
          />
        </FieldLabel>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => mutation.mutate({})}
          disabled={mutation.isPending}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          Save guardrails
        </button>
        <button
          type="button"
          onClick={() => setConfirmStop(true)}
          disabled={mutation.isPending}
          className={`rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60 ${
            settings.emergency_stop
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-red-300 bg-red-50 text-red-700"
          }`}
        >
          {settings.emergency_stop
            ? "Lift emergency stop"
            : "Emergency stop all outreach"}
        </button>
      </div>
      <ConfirmDialog
        open={confirmStop}
        setOpen={setConfirmStop}
        variant={settings.emergency_stop ? "default" : "destructive"}
        title={
          settings.emergency_stop
            ? "Lift the emergency stop?"
            : "Stop all engagement outreach?"
        }
        message={
          settings.emergency_stop
            ? "Campaigns will resume being able to queue eligible recipients."
            : "Every campaign candidate for this tenant will be suppressed until the stop is lifted."
        }
        confirmLabel={
          settings.emergency_stop ? "Lift stop" : "Activate emergency stop"
        }
        onConfirm={() =>
          mutation.mutate({ emergency_stop: !settings.emergency_stop })
        }
      />
    </SectionCard>
  );
}
