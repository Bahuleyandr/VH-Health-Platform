"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ENGINE_EVALUATED_SCOPES,
  ENGINE_EVALUATED_TRIGGERS,
  ENGINE_EXECUTABLE_ACTIONS,
  ESCALATION_ACTIONS,
  ESCALATION_SCOPES,
  ESCALATION_TRIGGERS,
  type EscalationAction,
  type EscalationRule,
  type EscalationRulePayload,
  type EscalationScope,
  type EscalationTrigger,
} from "@/lib/api/workflowEscalations";

interface FormState {
  display_name: string;
  description: string;
  scope: EscalationScope;
  trigger_condition: EscalationTrigger;
  trigger_window_minutes: string;
  action_kind: EscalationAction;
  match_filter_json: string;
  action_payload_json: string;
  is_active: boolean;
}

function toForm(rule: EscalationRule | null): FormState {
  return {
    display_name: rule?.display_name ?? "",
    description: rule?.description ?? "",
    scope: rule?.scope ?? "task",
    trigger_condition: rule?.trigger_condition ?? "sla_breach",
    trigger_window_minutes:
      rule?.trigger_window_minutes != null
        ? String(rule.trigger_window_minutes)
        : "",
    action_kind: rule?.action_kind ?? "notify",
    match_filter_json: JSON.stringify(rule?.match_filter ?? {}, null, 2),
    action_payload_json: JSON.stringify(rule?.action_payload ?? {}, null, 2),
    is_active: rule?.is_active ?? true,
  };
}

function parseJsonObject(
  value: string,
  label: string,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value || "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

export function EscalationRuleDialog({
  rule,
  open,
  onClose,
  onSave,
  saving,
  errorMessage,
}: {
  /** null = create a new rule */
  rule: EscalationRule | null;
  open: boolean;
  onClose: () => void;
  onSave: (payload: EscalationRulePayload) => void;
  saving: boolean;
  errorMessage: string | null;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(rule));
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingPayload, setPendingPayload] =
    useState<EscalationRulePayload | null>(null);

  useEffect(() => {
    if (open) {
      setForm(toForm(rule));
      setFormError(null);
      setConfirmOpen(false);
      setPendingPayload(null);
    }
  }, [open, rule]);

  if (!open) return null;

  const set = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const outsideEngineSubset =
    form.is_active &&
    (!(ENGINE_EVALUATED_SCOPES as readonly string[]).includes(form.scope) ||
      !(ENGINE_EVALUATED_TRIGGERS as readonly string[]).includes(
        form.trigger_condition,
      ) ||
      !(ENGINE_EXECUTABLE_ACTIONS as readonly string[]).includes(
        form.action_kind,
      ));

  const requestSave = () => {
    setFormError(null);
    try {
      if (!form.display_name.trim()) {
        throw new Error("Display name is required");
      }
      const windowMinutes = form.trigger_window_minutes.trim()
        ? Number.parseInt(form.trigger_window_minutes, 10)
        : null;
      if (windowMinutes !== null && (!Number.isFinite(windowMinutes) || windowMinutes < 1)) {
        throw new Error("Trigger window must be a positive number of minutes");
      }
      const payload: EscalationRulePayload = {
        ...(rule ? { id: rule.id } : {}),
        display_name: form.display_name.trim(),
        description: form.description.trim() || null,
        scope: form.scope,
        match_filter: parseJsonObject(form.match_filter_json, "Match filter"),
        trigger_condition: form.trigger_condition,
        trigger_window_minutes: windowMinutes,
        action_kind: form.action_kind,
        action_payload: parseJsonObject(
          form.action_payload_json,
          "Action payload",
        ),
        is_active: form.is_active,
      };
      setPendingPayload(payload);
      setConfirmOpen(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const consequence = rule
    ? `Saving changes to "${rule.display_name}" takes effect immediately. This rule pages clinicians on breached critical-result SLAs — a wrong edit can silence a critical-result page.`
    : "This creates an escalation rule that takes effect immediately. Escalation rules page clinicians on breached critical-result SLAs.";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={rule ? "Edit escalation rule" : "New escalation rule"}
      className="fixed inset-0 z-40 flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 mx-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-foreground">
          {rule ? `Edit rule — ${rule.display_name}` : "New escalation rule"}
        </h2>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <label htmlFor="rule-display-name" className="mb-1 block text-xs font-medium text-muted-foreground">
              Display name
            </label>
            <input
              id="rule-display-name"
              className={inputClass}
              value={form.display_name}
              onChange={(e) => set({ display_name: e.target.value })}
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="rule-description" className="mb-1 block text-xs font-medium text-muted-foreground">
              Description
            </label>
            <input
              id="rule-description"
              className={inputClass}
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="rule-scope" className="mb-1 block text-xs font-medium text-muted-foreground">
              Scope
            </label>
            <select
              id="rule-scope"
              className={inputClass}
              value={form.scope}
              onChange={(e) => set({ scope: e.target.value as EscalationScope })}
            >
              {ESCALATION_SCOPES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="rule-trigger" className="mb-1 block text-xs font-medium text-muted-foreground">
              Trigger condition
            </label>
            <select
              id="rule-trigger"
              className={inputClass}
              value={form.trigger_condition}
              onChange={(e) => set({ trigger_condition: e.target.value as EscalationTrigger })}
            >
              {ESCALATION_TRIGGERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="rule-window" className="mb-1 block text-xs font-medium text-muted-foreground">
              Trigger window (minutes)
            </label>
            <input
              id="rule-window"
              type="number"
              min={1}
              className={inputClass}
              value={form.trigger_window_minutes}
              onChange={(e) => set({ trigger_window_minutes: e.target.value })}
              placeholder="e.g. 30"
            />
          </div>
          <div>
            <label htmlFor="rule-action" className="mb-1 block text-xs font-medium text-muted-foreground">
              Action kind
            </label>
            <select
              id="rule-action"
              className={inputClass}
              value={form.action_kind}
              onChange={(e) => set({ action_kind: e.target.value as EscalationAction })}
            >
              {ESCALATION_ACTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label htmlFor="rule-match-filter" className="mb-1 block text-xs font-medium text-muted-foreground">
              Match filter (JSON object)
            </label>
            <textarea
              id="rule-match-filter"
              className={`${inputClass} min-h-20 font-mono text-xs`}
              value={form.match_filter_json}
              onChange={(e) => set({ match_filter_json: e.target.value })}
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="rule-action-payload" className="mb-1 block text-xs font-medium text-muted-foreground">
              Action payload — tiers / roles (JSON object)
            </label>
            <textarea
              id="rule-action-payload"
              className={`${inputClass} min-h-20 font-mono text-xs`}
              value={form.action_payload_json}
              onChange={(e) => set({ action_payload_json: e.target.value })}
            />
          </div>
          <div className="md:col-span-2 flex items-center gap-2">
            <input
              id="rule-is-active"
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => set({ is_active: e.target.checked })}
            />
            <label htmlFor="rule-is-active" className="text-sm text-foreground">
              Enabled (rule is evaluated by the escalation engine)
            </label>
          </div>
        </div>

        {outsideEngineSubset && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              The escalation engine only evaluates scope{" "}
              <code>{ENGINE_EVALUATED_SCOPES.join(", ")}</code>, triggers{" "}
              <code>{ENGINE_EVALUATED_TRIGGERS.join(", ")}</code> and actions{" "}
              <code>{ENGINE_EXECUTABLE_ACTIONS.join(", ")}</code>. The backend
              refuses to save an enabled rule outside those — save it as
              disabled instead.
            </span>
          </div>
        )}

        {(formError || errorMessage) && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {formError ?? errorMessage}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={requestSave}
            disabled={saving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save rule"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        setOpen={setConfirmOpen}
        title="Confirm escalation rule change"
        message={consequence}
        confirmLabel="Confirm save"
        variant="destructive"
        onConfirm={() => {
          if (pendingPayload) onSave(pendingPayload);
        }}
      />
    </div>
  );
}
