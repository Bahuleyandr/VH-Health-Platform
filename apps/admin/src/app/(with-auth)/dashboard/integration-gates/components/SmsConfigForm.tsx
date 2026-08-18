"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import toast from "react-hot-toast";
import {
  listSmsTemplates,
  registerSmsTemplate,
  upsertSmsConfig,
  type SmsProviderConfigView,
} from "@/lib/api/integrationGates";

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";

export function SmsConfigForm({
  existing,
}: {
  existing?: SmsProviderConfigView | null;
}) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<"msg91" | "twilio" | "dry_run">(
    existing?.provider === "twilio"
      ? "twilio"
      : existing?.provider === "dry_run"
        ? "dry_run"
        : "msg91",
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [senderId, setSenderId] = useState(existing?.sender_id ?? "");
  const [dltEntityId, setDltEntityId] = useState(existing?.dlt_entity_id ?? "");
  const [accountSid, setAccountSid] = useState(existing?.account_sid ?? "");
  // Write-only credential: never prefilled, cleared after save.
  const [authKey, setAuthKey] = useState("");
  // The DLR callback token plaintext is returned exactly once by the PUT that
  // minted it. Surface it once; it is never retrievable again.
  const [mintedToken, setMintedToken] = useState<{
    token: string;
    path: string | null;
  } | null>(null);

  const [templateKey, setTemplateKey] = useState("");
  const [dltTemplateId, setDltTemplateId] = useState("");
  const [providerTemplateId, setProviderTemplateId] = useState("");

  const templates = useQuery({
    queryKey: ["integration-gates", "sms-templates"],
    queryFn: listSmsTemplates,
  });

  const saveConfig = useMutation({
    mutationFn: () =>
      upsertSmsConfig({
        provider,
        enabled,
        sender_id: senderId || undefined,
        dlt_entity_id: dltEntityId || undefined,
        auth_key: authKey || undefined,
        account_sid: accountSid || undefined,
      }),
    onSuccess: (view) => {
      setAuthKey("");
      if (view?.callback_token) {
        setMintedToken({
          token: view.callback_token,
          path: view.dlr_path ?? null,
        });
      }
      toast.success("SMS config saved");
      void queryClient.invalidateQueries({ queryKey: ["integration-gates"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Failed to save SMS config"),
  });

  const addTemplate = useMutation({
    mutationFn: () =>
      registerSmsTemplate({
        template_key: templateKey.trim(),
        dlt_template_id: dltTemplateId.trim(),
        provider_template_id: providerTemplateId.trim() || undefined,
      }),
    onSuccess: () => {
      setTemplateKey("");
      setDltTemplateId("");
      setProviderTemplateId("");
      toast.success("DLT template registered");
      void queryClient.invalidateQueries({ queryKey: ["integration-gates"] });
    },
    onError: (e) =>
      toast.error(
        e instanceof Error ? e.message : "Failed to register DLT template",
      ),
  });

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveConfig.mutate();
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Provider</span>
            <select
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as "msg91" | "twilio" | "dry_run")
              }
              className={inputClass}
            >
              <option value="msg91">msg91</option>
              <option value="twilio">twilio</option>
              <option value="dry_run">dry_run</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">
              Sender ID (DLT header)
            </span>
            <input
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">
              DLT entity ID
            </span>
            <input
              value={dltEntityId}
              onChange={(e) => setDltEntityId(e.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">
              Account SID (Twilio only)
            </span>
            <input
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </label>
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block text-muted-foreground">
              Auth key (write-only
              {existing?.has_auth_key ? "; one is stored" : ""})
            </span>
            <input
              type="password"
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
              className={inputClass}
              autoComplete="new-password"
              placeholder="leave blank to keep stored key"
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          Config row enabled
        </label>
        <button
          type="submit"
          disabled={saveConfig.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
        >
          {saveConfig.isPending ? "Saving..." : "Save SMS config"}
        </button>
      </form>

      {mintedToken && (
        <div className="rounded border border-warning bg-warning/10 p-3 text-sm text-warning">
          <p className="font-medium">
            DLR callback token minted — shown exactly once, copy it now:
          </p>
          <code className="break-all text-xs">{mintedToken.token}</code>
          {mintedToken.path && (
            <p className="mt-1 text-xs">Callback path: {mintedToken.path}</p>
          )}
        </div>
      )}

      <div>
        <h4 className="mb-2 text-sm font-medium text-foreground">
          DLT template registrations
        </h4>
        <p className="mb-3 text-xs text-muted-foreground">
          Sends of a template kind terminally reject until its TRAI DLT content
          template id is registered here (fail-closed).
        </p>
        <ul className="mb-3 space-y-1 text-xs text-muted-foreground">
          {(templates.data?.templates ?? []).map((t) => (
            <li key={t.id}>
              <span className="text-foreground">{t.template_key}</span> →{" "}
              {t.dlt_template_id}
              {t.active ? "" : " (inactive)"}
            </li>
          ))}
          {templates.isSuccess &&
            (templates.data?.templates ?? []).length === 0 && (
              <li>No template registrations yet.</li>
            )}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addTemplate.mutate();
          }}
          className="grid grid-cols-1 gap-3 md:grid-cols-4"
        >
          <input
            value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value)}
            className={inputClass}
            placeholder="template key (outbox)"
            required
          />
          <input
            value={dltTemplateId}
            onChange={(e) => setDltTemplateId(e.target.value)}
            className={inputClass}
            placeholder="DLT content template id"
            required
          />
          <input
            value={providerTemplateId}
            onChange={(e) => setProviderTemplateId(e.target.value)}
            className={inputClass}
            placeholder="provider template id (optional)"
          />
          <button
            type="submit"
            disabled={addTemplate.isPending}
            className="rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            {addTemplate.isPending ? "Registering..." : "Register template"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default SmsConfigForm;
