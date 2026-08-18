"use client";

import {
  upsertPaymentGatewayConfig,
  type PaymentGatewayConfigView,
} from "@/lib/api/integrationGates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import toast from "react-hot-toast";

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";

export function PaymentGatewayConfigForm({
  existing,
}: {
  existing?: PaymentGatewayConfigView | null;
}) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState(existing?.provider ?? "razorpay");
  const [environment, setEnvironment] = useState<"sandbox" | "production">(
    existing?.environment === "production" ? "production" : "sandbox",
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [displayName, setDisplayName] = useState(existing?.display_name ?? "");
  const [keyId, setKeyId] = useState(existing?.key_id ?? "");
  // Write-only secrets: never prefilled, sent only when non-empty, cleared
  // after a successful save.
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const save = useMutation({
    mutationFn: () =>
      upsertPaymentGatewayConfig({
        provider,
        environment,
        enabled,
        display_name: displayName || undefined,
        key_id: keyId || undefined,
        key_secret: keySecret || undefined,
        webhook_secret: webhookSecret || undefined,
      }),
    onSuccess: (config) => {
      setKeySecret("");
      setWebhookSecret("");
      toast.success(
        config?.webhook_path
          ? `Gateway config saved. Webhook path: ${config.webhook_path}`
          : "Gateway config saved",
      );
      void queryClient.invalidateQueries({ queryKey: ["integration-gates"] });
    },
    onError: (e) =>
      toast.error(
        e instanceof Error ? e.message : "Failed to save gateway config",
      ),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Provider</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className={inputClass}
          >
            <option value="razorpay">razorpay</option>
            <option value="dry_run">dry_run (no credentials needed)</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Environment</span>
          <select
            value={environment}
            onChange={(e) =>
              setEnvironment(
                e.target.value === "production" ? "production" : "sandbox",
              )
            }
            className={inputClass}
          >
            <option value="sandbox">sandbox</option>
            <option value="production">production</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Display name</span>
          <input
            aria-label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={inputClass}
            maxLength={120}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Key ID</span>
          <input
            aria-label="Key ID"
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">
            Key secret (write-only
            {existing?.has_key_secret ? "; one is stored" : ""})
          </span>
          <input
            aria-label="Key secret"
            type="password"
            value={keySecret}
            onChange={(e) => setKeySecret(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
            placeholder="leave blank to keep stored secret"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">
            Webhook secret (write-only
            {existing?.has_webhook_secret ? "; one is stored" : ""})
          </span>
          <input
            aria-label="Webhook secret"
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
            placeholder="leave blank to keep stored secret"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          aria-label="Config row enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-input"
        />
        Config row enabled
      </label>
      <button
        type="submit"
        disabled={save.isPending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
      >
        {save.isPending ? "Saving..." : "Save gateway config"}
      </button>
    </form>
  );
}

export default PaymentGatewayConfigForm;
