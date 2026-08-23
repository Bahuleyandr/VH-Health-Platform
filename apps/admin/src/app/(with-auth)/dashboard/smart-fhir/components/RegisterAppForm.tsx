"use client";

import {
  describeSmartApiError,
  registerSmartApp,
  SMART_APP_KINDS,
  SMART_ENVIRONMENTS,
  SMART_FHIR_VERSIONS,
  type RegisterSmartAppPayload,
  type RegisterSmartAppResult,
  type SmartApiErrorInfo,
  type SmartAppKind,
  type SmartEnvironment,
  type SmartFhirVersion,
} from "@/lib/api/smartFhir";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

interface FormState {
  client_id: string;
  display_name: string;
  description: string;
  app_kind: SmartAppKind;
  environment: SmartEnvironment;
  fhir_version: SmartFhirVersion;
  redirect_uris: string;
  allowed_scopes: string;
  launch_uri: string;
  jwks_url: string;
  production_contract_ref: string;
  approval_notes: string;
  mark_production_approved: boolean;
}

const BLANK: FormState = {
  client_id: "",
  display_name: "",
  description: "",
  app_kind: "public",
  environment: "sandbox",
  fhir_version: "R4",
  redirect_uris: "",
  allowed_scopes: "",
  launch_uri: "",
  jwks_url: "",
  production_contract_ref: "",
  approval_notes: "",
  mark_production_approved: false,
};

function splitLines(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildPayload(form: FormState): RegisterSmartAppPayload {
  const payload: RegisterSmartAppPayload = {
    client_id: form.client_id.trim(),
    display_name: form.display_name.trim(),
    app_kind: form.app_kind,
    environment: form.environment,
    fhir_version: form.fhir_version,
    redirect_uris: splitLines(form.redirect_uris),
    allowed_scopes: splitLines(form.allowed_scopes),
  };
  if (form.description.trim()) payload.description = form.description.trim();
  if (form.launch_uri.trim()) payload.launch_uri = form.launch_uri.trim();
  if (form.jwks_url.trim()) payload.jwks_url = form.jwks_url.trim();
  if (form.production_contract_ref.trim())
    payload.production_contract_ref = form.production_contract_ref.trim();
  if (form.approval_notes.trim())
    payload.approval_notes = form.approval_notes.trim();
  if (form.environment === "production" && form.mark_production_approved) {
    payload.registration_status = "production_approved";
  }
  return payload;
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
const labelClass = "mb-1 block text-xs font-medium text-muted-foreground";

export function RegisterAppForm({ onDone }: { onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>({ ...BLANK });
  const [error, setError] = useState<SmartApiErrorInfo | null>(null);
  const [registered, setRegistered] = useState<RegisterSmartAppResult | null>(
    null,
  );

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const mutation = useMutation({
    mutationFn: () => registerSmartApp(buildPayload(form)),
    onSuccess: (result) => {
      setError(null);
      setRegistered(result);
      toast.success(`SMART app ${result.app.client_id} registered`);
      void queryClient.invalidateQueries({ queryKey: ["smart-fhir", "apps"] });
    },
    onError: (err: unknown) => setError(describeSmartApiError(err)),
  });

  const canSubmit =
    form.client_id.trim().length > 0 &&
    form.display_name.trim().length > 0 &&
    !mutation.isPending;

  if (registered) {
    const secret = registered.plaintext_client_secret;
    return (
      <div className="space-y-3 rounded-md border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">
          Registered {registered.app.display_name} ({registered.app.client_id})
        </div>
        {secret ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldAlert className="h-4 w-4" />
              One-time client secret — it cannot be shown again
            </div>
            <div className="mt-2 flex items-center gap-2">
              <code className="break-all rounded bg-amber-100 px-2 py-1 font-mono text-xs">
                {secret}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(secret);
                  toast.success("Client secret copied");
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                <Copy className="h-3 w-3" />
                Copy
              </button>
            </div>
            <p className="mt-2 text-xs">
              Store it in the integrating system now. The backend keeps only a
              hash.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No client secret was issued ({registered.app.app_kind} apps
            authenticate without one).
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setRegistered(null);
            setForm({ ...BLANK });
            onDone?.();
          }}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3 rounded-md border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) mutation.mutate();
      }}
    >
      <div className="text-sm font-semibold text-foreground">
        Register SMART app
      </div>
      <p className="text-xs text-muted-foreground">
        Registration is create-only: the admin API exposes no edit endpoint,
        so re-register under a new client_id to change an app. Production
        registrations start paused (production_pending) until a super-admin
        approves activation; confidential apps receive a one-time client
        secret on this screen.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="smart-client-id">
            Client ID
          </label>
          <input
            id="smart-client-id"
            aria-label="Client ID"
            className={inputClass}
            value={form.client_id}
            onChange={(e) => set("client_id", e.target.value)}
            placeholder="my-ehr-app"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="smart-display-name">
            Display name
          </label>
          <input
            id="smart-display-name"
            aria-label="Display name"
            className={inputClass}
            value={form.display_name}
            onChange={(e) => set("display_name", e.target.value)}
            placeholder="My EHR App"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="smart-app-kind">
            App kind
          </label>
          <select
            id="smart-app-kind"
            className={inputClass}
            value={form.app_kind}
            onChange={(e) => set("app_kind", e.target.value as SmartAppKind)}
          >
            {SMART_APP_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="smart-environment">
            Environment
          </label>
          <select
            id="smart-environment"
            className={inputClass}
            value={form.environment}
            onChange={(e) =>
              set("environment", e.target.value as SmartEnvironment)
            }
          >
            {SMART_ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="smart-fhir-version">
            FHIR version
          </label>
          <select
            id="smart-fhir-version"
            className={inputClass}
            value={form.fhir_version}
            onChange={(e) =>
              set("fhir_version", e.target.value as SmartFhirVersion)
            }
          >
            {SMART_FHIR_VERSIONS.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="smart-launch-uri">
            Launch URI (optional)
          </label>
          <input
            id="smart-launch-uri"
            aria-label="Launch URI"
            className={inputClass}
            value={form.launch_uri}
            onChange={(e) => set("launch_uri", e.target.value)}
            placeholder="https://app.example.com/launch"
          />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="smart-redirect-uris">
          Redirect URIs (one per line; exact HTTPS URIs, no wildcards —
          sandbox loopback http allowed)
        </label>
        <textarea
          id="smart-redirect-uris"
          aria-label="Redirect URIs"
          className={`${inputClass} min-h-16 font-mono text-xs`}
          value={form.redirect_uris}
          onChange={(e) => set("redirect_uris", e.target.value)}
          placeholder={"https://app.example.com/callback"}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="smart-allowed-scopes">
          Allowed scopes (one per line, SMART syntax — e.g.
          patient/Observation.read, launch/patient, offline_access)
        </label>
        <textarea
          id="smart-allowed-scopes"
          aria-label="Allowed scopes"
          className={`${inputClass} min-h-16 font-mono text-xs`}
          value={form.allowed_scopes}
          onChange={(e) => set("allowed_scopes", e.target.value)}
          placeholder={"patient/Observation.read\nlaunch/patient"}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="smart-jwks-url">
            JWKS URL (optional, backend services)
          </label>
          <input
            id="smart-jwks-url"
            aria-label="JWKS URL"
            className={inputClass}
            value={form.jwks_url}
            onChange={(e) => set("jwks_url", e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="smart-description">
            Description (optional)
          </label>
          <input
            id="smart-description"
            aria-label="Description"
            className={inputClass}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>
      </div>
      {form.environment === "production" && (
        <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50/60 p-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="smart-contract-ref">
                Production contract ref (required for broad system/*.write
                scopes)
              </label>
              <input
                id="smart-contract-ref"
                aria-label="Production contract ref"
                className={inputClass}
                value={form.production_contract_ref}
                onChange={(e) =>
                  set("production_contract_ref", e.target.value)
                }
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="smart-approval-notes">
                Approval notes (optional)
              </label>
              <input
                id="smart-approval-notes"
                aria-label="Approval notes"
                className={inputClass}
                value={form.approval_notes}
                onChange={(e) => set("approval_notes", e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              aria-label="Mark production-approved now"
              checked={form.mark_production_approved}
              onChange={(e) =>
                set("mark_production_approved", e.target.checked)
              }
            />
            Mark production-approved now (SUPER_ADMIN only — the API rejects
            this for other roles)
          </label>
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error.message}
          {error.code && (
            <code className="ml-2 rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">
              {error.code}
            </code>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {mutation.isPending ? "Registering..." : "Register app"}
        </button>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
