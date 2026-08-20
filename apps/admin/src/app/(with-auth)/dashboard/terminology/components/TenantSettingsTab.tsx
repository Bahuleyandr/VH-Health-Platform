"use client";

// Tab 3 — tenant terminology settings: preferred diagnosis system, enabled
// systems, the dark snomed_pickers_enabled flag, and (WP2) per-surface
// coding enforcement. Backed by GET/PUT /terminology/settings; the tenant is
// resolved server-side (acting tenant when set).

import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  CODING_ENFORCEMENT_LEVELS,
  CODING_ENFORCEMENT_SURFACES,
  getTerminologySettings,
  TERMINOLOGY_SYSTEMS,
  updateTerminologySettings,
  type CodingEnforcementLevel,
  type CodingEnforcementSurface,
} from "@/lib/api/terminologyAdmin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";

import { QueryErrorNotice, SectionCard } from "./shared";

const SURFACE_LABELS: Record<CodingEnforcementSurface, string> = {
  death_certificate: "Death certification (ICD-10 parts)",
  insurance_claim: "Insurance preauth / claims (icd10_codes)",
  discharge_summary: "Discharge summary (icd10_codes)",
};

export default function TenantSettingsTab() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["terminology", "settings"],
    queryFn: () => getTerminologySettings(),
  });

  const [preferred, setPreferred] = useState<string>("ICD11");
  const [enabledSystems, setEnabledSystems] = useState<string[]>([]);
  const [snomedPickers, setSnomedPickers] = useState(false);
  const [enforcement, setEnforcement] = useState<
    Partial<Record<CodingEnforcementSurface, CodingEnforcementLevel>>
  >({});

  useEffect(() => {
    const value = settings.data?.settings;
    if (!value) return;
    setPreferred(value.preferred_diagnosis_system);
    setEnabledSystems(value.enabled_systems);
    setSnomedPickers(value.snomed_pickers_enabled);
    setEnforcement(value.coding_enforcement ?? {});
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      updateTerminologySettings({
        preferred_diagnosis_system: preferred,
        enabled_systems: enabledSystems,
        snomed_pickers_enabled: snomedPickers,
        coding_enforcement: enforcement,
      }),
    onSuccess: () => {
      toast.success("Terminology settings saved");
      void queryClient.invalidateQueries({
        queryKey: ["terminology", "settings"],
      });
      void queryClient.invalidateQueries({ queryKey: ["integration-gates"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Failed to save settings"),
  });

  if (settings.isLoading) return <LoadingSpinner />;
  if (settings.isError) {
    return (
      <QueryErrorNotice
        error={settings.error}
        notAvailableMessage="Terminology settings not available."
      />
    );
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="Diagnosis coding preferences"
        description="Which code systems clinical pickers offer for this tenant. Defaults keep today's behaviour byte-identical; SNOMED pickers additionally require imported SNOMED CT content."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="text-sm text-foreground">
            <span className="mb-1 block text-xs text-muted-foreground">
              Preferred diagnosis system
            </span>
            <select
              value={preferred}
              onChange={(e) => setPreferred(e.target.value)}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            >
              {TERMINOLOGY_SYSTEMS.map((system) => (
                <option key={system} value={system}>
                  {system}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="text-sm">
            <legend className="mb-1 text-xs text-muted-foreground">
              Enabled systems
            </legend>
            <div className="flex flex-wrap gap-3">
              {TERMINOLOGY_SYSTEMS.map((system) => (
                <label key={system} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={enabledSystems.includes(system)}
                    onChange={(e) =>
                      setEnabledSystems((previous) =>
                        e.target.checked
                          ? [...previous, system]
                          : previous.filter((s) => s !== system),
                      )
                    }
                  />
                  <span className="text-foreground">{system}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={snomedPickers}
            onChange={(e) => setSnomedPickers(e.target.checked)}
          />
          SNOMED CT pickers enabled (dark flag; needs imported RF2 content)
        </label>
      </SectionCard>

      <SectionCard
        title="Per-surface coding enforcement"
        description="off = free text unchanged; warn = invalid codes attach warnings + audit; block = invalid codes reject the write. Effective only when the TERMINOLOGY_CODING_ENFORCEMENT deployment switch is also on — see the Integrations & Gates console."
      >
        <div className="space-y-3">
          {CODING_ENFORCEMENT_SURFACES.map((surface) => (
            <div
              key={surface}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            >
              <span className="text-sm text-foreground">
                {SURFACE_LABELS[surface]}
              </span>
              <div className="flex gap-1">
                {CODING_ENFORCEMENT_LEVELS.map((level) => {
                  const active = (enforcement[surface] ?? "off") === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() =>
                        setEnforcement((previous) => ({
                          ...previous,
                          [surface]: level,
                        }))
                      }
                      className={`rounded-md border px-3 py-1 text-xs font-medium ${
                        active
                          ? "border-success text-success"
                          : "border-input text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {level}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div>
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
