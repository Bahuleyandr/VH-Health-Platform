"use client";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ENGAGEMENT_CHANNELS,
  approveCampaign,
  dryRunCampaign,
  materializeCampaignRecipients,
  queueDueCampaignRecipients,
  submitCampaignForApproval,
  type CampaignCandidateInput,
  type DryRunRecipient,
  type EngagementCampaign,
  type EngagementChannel,
} from "@/lib/api/engagement";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, FlaskConical, Send, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import {
  CAMPAIGN_PIPELINE,
  FieldLabel,
  SectionCard,
  StatusPill,
  inputClass,
} from "./shared";

const MATERIALIZE_STATUSES = new Set([
  "dry_run",
  "pending_approval",
  "scheduled",
  "running",
]);
const QUEUE_STATUSES = new Set(["scheduled", "running"]);

function PipelineStepper({ status }: { status: string }) {
  const activeIndex = CAMPAIGN_PIPELINE.findIndex(
    (step) => step.status === status,
  );
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {CAMPAIGN_PIPELINE.map((step, index) => (
        <li key={step.status} className="flex items-center gap-2">
          {index > 0 && <span className="text-muted-foreground">→</span>}
          <span
            className={`rounded-full border px-2 py-0.5 font-medium ${
              index === activeIndex
                ? "border-teal-300 bg-teal-50 text-teal-800"
                : index < activeIndex
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-border bg-background text-muted-foreground"
            }`}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function RecipientsTable({ recipients }: { recipients: DryRunRecipient[] }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Patient UID</th>
            <th className="px-3 py-2">Channel</th>
            <th className="px-3 py-2">Consent</th>
            <th className="px-3 py-2">Verdict</th>
            <th className="px-3 py-2">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {recipients.map((row, index) => (
            <tr key={row.idempotency_key ?? `${row.patient_uid}-${index}`}>
              <td className="px-3 py-2 font-mono text-xs">
                {row.patient_uid ?? "—"}
              </td>
              <td className="px-3 py-2">{row.channel ?? "—"}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {row.required_consent_type ?? "—"}
              </td>
              <td className="px-3 py-2">
                <StatusPill value={row.eligible ? "eligible" : "suppressed"} />
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {row.reason ? row.reason.replace(/_/g, " ") : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Walks one campaign through the backend's enforced order:
 * dry-run -> submit for approval -> approve -> materialize/queue.
 * Buttons are gated on the campaign status the backend reported, and any
 * backend refusal is surfaced verbatim.
 */
export function CampaignWorkflow({
  campaign,
  onUpdate,
}: {
  campaign: EngagementCampaign;
  onUpdate: (campaign: EngagementCampaign) => void;
}) {
  const [candidateText, setCandidateText] = useState("");
  const [channelOverride, setChannelOverride] = useState<
    "" | EngagementChannel
  >("");
  const [reason, setReason] = useState("");
  const [queueLimit, setQueueLimit] = useState("50");
  const [lastRefusal, setLastRefusal] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    kind: "dry_run" | "materialized";
    counts: { materialized: number; eligible: number; suppressed: number };
    recipients: DryRunRecipient[];
  } | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmMaterialize, setConfirmMaterialize] = useState(false);
  const [confirmQueue, setConfirmQueue] = useState(false);

  const refuse = (err: Error) => {
    // Surface the backend's message verbatim — it names the exact guard
    // (invalid transition, missing consent type, disabled tenant, …).
    setLastRefusal(err.message);
    toast.error(err.message);
  };

  const candidateInput = (): CampaignCandidateInput => {
    const patients = candidateText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((patient_uid) => ({
        patient_uid,
        ...(channelOverride ? { channel: channelOverride } : {}),
      }));
    return { patients };
  };

  const dryRunMutation = useMutation({
    mutationFn: () => dryRunCampaign(campaign.id, candidateInput()),
    onSuccess: (result) => {
      setLastRefusal(null);
      setPreview({ kind: "dry_run", ...result });
      onUpdate({
        ...campaign,
        status: campaign.status === "draft" ? "dry_run" : campaign.status,
        current_audience_snapshot_id: result.snapshot.id,
      });
      toast.success(
        `Dry run: ${result.counts.eligible} eligible, ${result.counts.suppressed} suppressed`,
      );
    },
    onError: refuse,
  });

  const submitMutation = useMutation({
    mutationFn: () =>
      submitCampaignForApproval(campaign.id, reason.trim() || undefined),
    onSuccess: (updated) => {
      setLastRefusal(null);
      onUpdate(updated);
      toast.success("Campaign submitted for approval");
    },
    onError: refuse,
  });

  const approveMutation = useMutation({
    mutationFn: () => approveCampaign(campaign.id, reason.trim()),
    onSuccess: (updated) => {
      setLastRefusal(null);
      onUpdate(updated);
      toast.success("Campaign approved and scheduled");
    },
    onError: refuse,
  });

  const materializeMutation = useMutation({
    mutationFn: () =>
      materializeCampaignRecipients(campaign.id, candidateInput()),
    onSuccess: (result) => {
      setLastRefusal(null);
      setPreview({
        kind: "materialized",
        counts: result.counts,
        recipients: result.recipients.map((row) => ({
          eligible: row.status === "eligible",
          reason: row.suppression_reason,
          patient_uid: row.patient_uid,
          channel: row.channel,
          required_consent_type: row.required_consent_type,
          idempotency_key: row.idempotency_key,
        })),
      });
      onUpdate({
        ...campaign,
        current_audience_snapshot_id: result.snapshot.id,
        frozen_audience_hash: result.snapshot.cohort_hash,
      });
      toast.success(`${result.counts.materialized} recipients materialized`);
    },
    onError: refuse,
  });

  const queueMutation = useMutation({
    mutationFn: () =>
      queueDueCampaignRecipients(
        campaign.id,
        Number.parseInt(queueLimit, 10) || 50,
      ),
    onSuccess: (result) => {
      setLastRefusal(null);
      if (result.queued > 0 && campaign.status === "scheduled") {
        onUpdate({ ...campaign, status: "running" });
      }
      toast.success(
        `Queued ${result.queued} of ${result.claimed} due recipients (${result.suppressed} suppressed, ${result.failed} failed)`,
      );
    },
    onError: refuse,
  });

  const busy =
    dryRunMutation.isPending ||
    submitMutation.isPending ||
    approveMutation.isPending ||
    materializeMutation.isPending ||
    queueMutation.isPending;
  const hasCandidates = candidateText.trim().length > 0;

  return (
    <SectionCard
      title={`Campaign #${campaign.id} — ${campaign.campaign_type.replace(/_/g, " ")}`}
      icon={<FlaskConical className="h-4 w-4" />}
      actions={<StatusPill value={campaign.status} />}
    >
      <PipelineStepper status={campaign.status} />
      <p className="mt-2 text-sm text-muted-foreground">{campaign.objective}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Audience: {campaign.audience_kind} · approval by{" "}
        {campaign.approval_required_role === "admin_quality"
          ? "admin/quality leadership"
          : "care team"}
      </p>

      {lastRefusal && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          Backend refused: {lastRefusal}
        </div>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <FieldLabel
          label="Candidate patient UIDs (one per line)"
          htmlFor="candidates"
        >
          <textarea
            id="candidates"
            aria-label="Candidate patient UIDs (one per line)"
            className={`${inputClass} min-h-28 font-mono text-xs`}
            value={candidateText}
            onChange={(e) => setCandidateText(e.target.value)}
            placeholder={"11111111-1111-4111-8111-111111111111"}
          />
        </FieldLabel>
        <div className="space-y-3">
          <FieldLabel
            label="Channel override (optional)"
            htmlFor="channel-override"
          >
            <select
              id="channel-override"
              className={inputClass}
              value={channelOverride}
              onChange={(e) =>
                setChannelOverride(e.target.value as "" | EngagementChannel)
              }
            >
              <option value="">campaign default</option>
              {ENGAGEMENT_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </select>
          </FieldLabel>
          <FieldLabel
            label="Approval reason (required to approve; optional on submit)"
            htmlFor="workflow-reason"
          >
            <input
              id="workflow-reason"
              aria-label="Approval reason (required to approve; optional on submit)"
              className={inputClass}
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </FieldLabel>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => dryRunMutation.mutate()}
          disabled={busy || !hasCandidates}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          <FlaskConical className="h-4 w-4" />
          Run dry run
        </button>
        <button
          type="button"
          onClick={() => submitMutation.mutate()}
          disabled={busy || campaign.status !== "dry_run"}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          Submit for approval
        </button>
        <button
          type="button"
          onClick={() => setConfirmApprove(true)}
          disabled={
            busy ||
            campaign.status !== "pending_approval" ||
            reason.trim().length === 0
          }
          className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 disabled:opacity-50"
        >
          <ShieldCheck className="h-4 w-4" />
          Approve campaign
        </button>
        <button
          type="button"
          onClick={() => setConfirmMaterialize(true)}
          disabled={
            busy || !hasCandidates || !MATERIALIZE_STATUSES.has(campaign.status)
          }
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
        >
          Materialize recipients
        </button>
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={() => setConfirmQueue(true)}
            disabled={busy || !QUEUE_STATUSES.has(campaign.status)}
            className="inline-flex items-center gap-2 rounded-md border border-teal-300 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-800 disabled:opacity-50"
          >
            <CheckCircle2 className="h-4 w-4" />
            Queue due recipients
          </button>
          <input
            aria-label="Queue limit"
            className={`${inputClass} w-20`}
            inputMode="numeric"
            value={queueLimit}
            onChange={(e) => setQueueLimit(e.target.value)}
          />
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        The backend enforces this order — dry run before approval, approval
        by a distinct authenticated reviewer before queueing. Approval requires
        a reason. Queueing hands eligible recipients to the notification outbox.
      </p>

      {preview && (
        <div className="mt-4">
          <div className="text-sm font-semibold text-foreground">
            {preview.kind === "dry_run"
              ? "Dry-run preview"
              : "Materialized recipients"}{" "}
            — {preview.counts.eligible} eligible / {preview.counts.suppressed}{" "}
            suppressed of {preview.counts.materialized}
          </div>
          <RecipientsTable recipients={preview.recipients} />
        </div>
      )}

      <ConfirmDialog
        open={confirmApprove}
        setOpen={setConfirmApprove}
        title={`Approve campaign #${campaign.id}?`}
        message="Approval schedules this campaign for delivery. Recipients that pass consent and cap checks can then be queued to the notification outbox."
        confirmLabel="Approve"
        onConfirm={() => approveMutation.mutate()}
      />
      <ConfirmDialog
        open={confirmMaterialize}
        setOpen={setConfirmMaterialize}
        title="Materialize recipient list?"
        message="This writes per-patient recipient rows (with consent re-checks) for the entered candidates. Existing rows for the same patient+channel are updated."
        confirmLabel="Materialize"
        onConfirm={() => materializeMutation.mutate()}
      />
      <ConfirmDialog
        open={confirmQueue}
        setOpen={setConfirmQueue}
        variant="destructive"
        title="Queue due recipients for sending?"
        message="Eligible, due recipients will be re-checked and handed to the notification outbox for real delivery. This cannot be recalled once sent."
        confirmLabel="Queue for delivery"
        onConfirm={() => queueMutation.mutate()}
      />
    </SectionCard>
  );
}
