"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  getCathConsumablesBillingSettings,
  updateCathConsumablesBillingSettings,
  type CathConsumablesBillingSettings,
  type CathConsumablesBillingSettingsInput,
} from "@/lib/api/cathConsumables";

const SETTINGS_QUERY_KEY = ["cath-consumables", "billing-settings"] as const;

type BillingSettings = CathConsumablesBillingSettings["settings"];

interface BillingSettingsFormState {
  charge_enabled: boolean;
  procedure_billing_code: string;
  procedure_unit_price: string;
  gst_rate: string;
  finance_reviewed_at: string;
}

function toLocalDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const offset = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function settingsKey(settings: BillingSettings) {
  return [
    settings.charge_enabled,
    settings.procedure_billing_code,
    settings.procedure_unit_price,
    settings.gst_rate,
    settings.finance_reviewed_at,
  ].join(":");
}

export function BillingSettingsPanel() {
  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => getCathConsumablesBillingSettings(),
  });

  if (settingsQuery.isLoading) {
    return (
      <section className="rounded-lg border border-border bg-card px-4">
        <LoadingSpinner label="Loading cath billing settings" size={24} />
      </section>
    );
  }

  if (settingsQuery.error || !settingsQuery.data?.settings) {
    return (
      <section className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {settingsQuery.error instanceof Error
          ? settingsQuery.error.message
          : "Cath billing settings could not be loaded"}
      </section>
    );
  }

  return (
    <BillingSettingsForm
      key={settingsKey(settingsQuery.data.settings)}
      settings={settingsQuery.data.settings}
    />
  );
}

function BillingSettingsForm({ settings }: { settings: BillingSettings }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<BillingSettingsFormState>(() => ({
    charge_enabled: settings.charge_enabled,
    procedure_billing_code: settings.procedure_billing_code ?? "",
    procedure_unit_price:
      settings.procedure_unit_price === null ||
      settings.procedure_unit_price === undefined
        ? ""
        : String(settings.procedure_unit_price),
    gst_rate:
      settings.gst_rate === null || settings.gst_rate === undefined
        ? ""
        : String(settings.gst_rate),
    finance_reviewed_at: toLocalDateTime(settings.finance_reviewed_at),
  }));
  const [validationError, setValidationError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: (payload: CathConsumablesBillingSettingsInput) =>
      updateCathConsumablesBillingSettings(payload),
    onSuccess: () => {
      toast.success("Cath billing settings saved");
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Billing settings could not be saved",
      );
    },
  });

  function update<K extends keyof BillingSettingsFormState>(
    key: K,
    value: BillingSettingsFormState[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const unitPrice = optionalNumber(form.procedure_unit_price);
    const parsedGstRate = optionalNumber(form.gst_rate);
    const gstRate = parsedGstRate ?? 0;
    if (
      form.procedure_unit_price.trim() &&
      (unitPrice === null || unitPrice < 0)
    ) {
      setValidationError("Procedure unit price must be a non-negative number.");
      return;
    }
    const hasProcedureCode = Boolean(form.procedure_billing_code.trim());
    const hasProcedurePrice = unitPrice !== null;
    if (hasProcedureCode !== hasProcedurePrice) {
      setValidationError(
        "Procedure billing code and unit price must be mapped together.",
      );
      return;
    }
    if (
      form.gst_rate.trim() &&
      (parsedGstRate === null || gstRate < 0 || gstRate > 28)
    ) {
      setValidationError("GST rate must be between 0 and 28.");
      return;
    }
    if (form.charge_enabled && !form.procedure_billing_code.trim()) {
      setValidationError(
        "A procedure billing code is required before charging can be enabled.",
      );
      return;
    }
    if (form.charge_enabled && unitPrice === null) {
      setValidationError(
        "A procedure unit price is required before charging can be enabled.",
      );
      return;
    }
    if (form.charge_enabled && !form.finance_reviewed_at) {
      setValidationError(
        "Finance review must be recorded before charging can be enabled.",
      );
      return;
    }

    const financeReviewedAt = form.finance_reviewed_at
      ? new Date(form.finance_reviewed_at).toISOString()
      : null;

    const payload: CathConsumablesBillingSettingsInput = {
      charge_enabled: form.charge_enabled,
      procedure_billing_code: form.procedure_billing_code.trim() || null,
      procedure_unit_price: unitPrice,
      gst_rate: gstRate,
      finance_reviewed_at: financeReviewedAt,
    };
    setValidationError(null);
    saveMutation.mutate(payload);
  }

  return (
    <section
      aria-labelledby="cath-billing-settings-heading"
      className="rounded-lg border border-border bg-card p-4"
    >
      <form className="space-y-4" onSubmit={submit}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2
                id="cath-billing-settings-heading"
                className="text-base font-semibold text-foreground"
              >
                Billing settings
              </h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  form.charge_enabled
                    ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {form.charge_enabled ? "Charging enabled" : "Inert"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Procedure charging stays inert until finance enables it after code
              and price review.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <input
              aria-label="Enable cath procedure charging"
              checked={form.charge_enabled}
              className="h-4 w-4 rounded border-input"
              onChange={(event) =>
                update("charge_enabled", event.target.checked)
              }
              type="checkbox"
            />
            Enable charging
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs font-medium text-muted-foreground">
            Procedure billing code
            <input
              aria-label="Procedure billing code"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground"
              onChange={(event) =>
                update("procedure_billing_code", event.target.value)
              }
              placeholder="Owner supplied"
              value={form.procedure_billing_code}
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Procedure unit price
            <input
              aria-label="Procedure unit price"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              min="0"
              onChange={(event) =>
                update("procedure_unit_price", event.target.value)
              }
              step="0.01"
              type="number"
              value={form.procedure_unit_price}
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            GST rate (%)
            <input
              aria-label="GST rate"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              max="28"
              min="0"
              onChange={(event) => update("gst_rate", event.target.value)}
              step="0.01"
              type="number"
              value={form.gst_rate}
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Finance reviewed at
            <input
              aria-label="Finance reviewed at"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              onChange={(event) =>
                update("finance_reviewed_at", event.target.value)
              }
              type="datetime-local"
              value={form.finance_reviewed_at}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          {validationError ? (
            <p className="text-sm text-destructive">{validationError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Consumables without billing mappings remain visible in the report
              below.
            </p>
          )}
          <button
            className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saveMutation.isPending}
            type="submit"
          >
            {saveMutation.isPending ? "Saving…" : "Save billing settings"}
          </button>
        </div>
      </form>
    </section>
  );
}
