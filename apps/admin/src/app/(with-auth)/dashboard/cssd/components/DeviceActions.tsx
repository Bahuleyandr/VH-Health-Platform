"use client";

// The five reprocessable-device transitions on POST /cssd/devices/{id}/*.
//
// Every one of them is mounted with
// `requireIdempotencyKey({ required: true, scope: 'cssd_device_transition' })`,
// so the header is not optional — a transition sent without it is a hard 400,
// not a degraded save. The attempt store lives HERE, in the dialog, not in the
// api module: `keyFor` is stable while the payload identity is unchanged, so a
// double-click or the 401→refresh replay in `api/core.ts` reuses the key and
// the backend replays its recorded response instead of running the transition
// twice.
//
// `reset()` runs on SUCCESS ONLY, as it does at every other call site
// (CatalogTab, PayrollRunsTab, PaymentLinksTab, ward-indents ActionPanel). A
// FAILED attempt deliberately keeps its key: idempotencyMiddleware caches a 4xx
// outcome and deletes the claim on a 5xx, so pressing the button again replays
// the recorded refusal or runs the transition exactly once. Re-minting on error
// throws that away — a request that timed out on the wire but committed on the
// server would run a second time under a key the server has never seen.
//
// Only the transitions cathDeviceReuseService's state machine allows are
// offered (see ACTIONS_BY_STATUS in DevicesTab) — anything else could only ever
// answer 409 CATH_DEVICE_INVALID_TRANSITION. The cycle-type picker is narrowed
// the same way, one gate further in: `allowedCycleTypes` is the category
// policy's list, computed by DevicesTab, and a type outside it could only ever
// answer 409 CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED. Both narrowings are
// convenience, not authority — the policy can change under an open dialog, and
// the backend's refusal is what the operator then sees.

import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import {
  CATH_DEVICE_DISCARD_REASONS,
  discardCssdDevice,
  markCssdDeviceReprocessed,
  quarantineCssdDevice,
  receiveCssdDevice,
  releaseCssdDevice,
  type CathDevice,
  type CathDeviceCycleType,
  type CathDeviceDiscardReason,
  type CathDeviceFunctionCheck,
} from "@/lib/api/cathDevices";
import { payloadIdentity } from "@/lib/idempotencyKey";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "react-hot-toast";

import {
  DialogError,
  Field,
  Modal,
  errorMessage,
  humanize,
  inputClass,
} from "./helpers";

export type DeviceAction =
  "receive" | "reprocessed" | "quarantine" | "release" | "discard";

export const DEVICE_ACTION_LABEL: Record<DeviceAction, string> = {
  receive: "Receive",
  reprocessed: "Mark reprocessed",
  quarantine: "Quarantine",
  release: "Release",
  discard: "Discard",
};

const TITLE: Record<DeviceAction, string> = {
  receive: "Receive device in CSSD",
  reprocessed: "Mark device reprocessed",
  quarantine: "Quarantine device",
  release: "Release device for reprocessing",
  discard: "Discard device",
};

export function DeviceActionDialog({
  device,
  action,
  allowedCycleTypes,
  onClose,
}: {
  device: CathDevice;
  action: DeviceAction;
  /**
   * The cycle types this device's CATEGORY POLICY allows, computed by the
   * caller from GET /cath-reprocessing/policies. Passed in rather than read
   * here so the queue row and the dialog cannot disagree about whether the
   * action is offerable at all. An empty list leaves the picker with nothing
   * to choose and the confirm disabled — the caller disables the action
   * outright in that case, so it is a backstop, not a state the operator
   * should reach.
   */
  allowedCycleTypes: readonly CathDeviceCycleType[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const attemptKey = useIdempotencyKey("cssd-device-transition");
  // Cycle type and discard reason start EMPTY, like the quarantine reason: a
  // pre-selected "eto" or "other" is a choice the operator never made, recorded
  // on an irreversible transition as though they had.
  const [cycleType, setCycleType] = useState<"" | CathDeviceCycleType>("");
  const [functionCheck, setFunctionCheck] = useState<
    "" | CathDeviceFunctionCheck
  >("");
  const [quarantineReason, setQuarantineReason] = useState("");
  const [discardReason, setDiscardReason] = useState<
    "" | CathDeviceDiscardReason
  >("");
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      const trimmedNote = note.trim() || undefined;
      switch (action) {
        case "receive": {
          return receiveCssdDevice(
            device.id,
            attemptKey.keyFor(
              payloadIdentity({ id: device.id, action, body: {} }),
            ),
          );
        }
        case "reprocessed": {
          // Unreachable through the UI (the confirm stays disabled), but the
          // narrowing has to be real: `cycle_type` is required by the route.
          if (!cycleType) throw new Error("Choose a cycle type");
          const body = {
            cycle_type: cycleType,
            ...(functionCheck ? { function_check_result: functionCheck } : {}),
            ...(trimmedNote ? { note: trimmedNote } : {}),
          };
          return markCssdDeviceReprocessed(
            device.id,
            body,
            attemptKey.keyFor(payloadIdentity({ id: device.id, action, body })),
          );
        }
        case "quarantine": {
          const body = { reason: quarantineReason.trim() };
          return quarantineCssdDevice(
            device.id,
            body,
            attemptKey.keyFor(payloadIdentity({ id: device.id, action, body })),
          );
        }
        case "release": {
          const body = trimmedNote ? { note: trimmedNote } : {};
          return releaseCssdDevice(
            device.id,
            body,
            attemptKey.keyFor(payloadIdentity({ id: device.id, action, body })),
          );
        }
        case "discard": {
          if (!discardReason) throw new Error("Choose a discard reason");
          const body = {
            reason: discardReason,
            ...(trimmedNote ? { note: trimmedNote } : {}),
          };
          return discardCssdDevice(
            device.id,
            body,
            attemptKey.keyFor(payloadIdentity({ id: device.id, action, body })),
          );
        }
        default:
          throw new Error(`Unsupported device action: ${String(action)}`);
      }
    },
    onSuccess: (updated) => {
      // The attempt concluded: the operator's next action on this device is a
      // new attempt, even if it produces the same payload identity.
      attemptKey.reset();
      toast.success(`${updated.device_tag} is now ${humanize(updated.status)}`);
      void qc.invalidateQueries({ queryKey: ["cssd", "devices"] });
      onClose();
    },
    onError: (err: unknown) => {
      // NO reset() here — see the header. The retry must carry the same key.
      // The row is refetched anyway: the commonest refusal is a 409 invalid
      // transition, which means the status this dialog was opened from is
      // already stale on the server.
      void qc.invalidateQueries({ queryKey: ["cssd", "devices"] });
      setFailure(errorMessage(err, "Could not update the device"));
    },
  });

  const disabled =
    run.isPending ||
    (action === "quarantine" && quarantineReason.trim() === "") ||
    (action === "reprocessed" && cycleType === "") ||
    (action === "discard" && discardReason === "");

  return (
    <Modal
      title={TITLE[action]}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            // Closing mid-flight unmounts the attempt store, so the operator
            // could not retry the in-flight key even if the write did land.
            disabled={run.isPending}
            className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            aria-label="Confirm device action"
            disabled={disabled}
            onClick={() => {
              setFailure(null);
              run.mutate();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {run.isPending ? "Saving…" : TITLE[action]}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      <p className="text-sm text-muted-foreground">
        <span className="font-mono">{device.device_tag}</span> ·{" "}
        {device.item_name} · cycle {device.cycle_count} of{" "}
        {device.max_cycles_snapshot}
        {device.exposure_flag ? " · exposure flagged" : ""}
      </p>

      {action === "reprocessed" && (
        <>
          <Field label="Cycle type">
            <select
              aria-label="Cycle type"
              className={inputClass}
              value={cycleType}
              onChange={(e) =>
                setCycleType(e.target.value as "" | CathDeviceCycleType)
              }
            >
              <option value="" disabled>
                Select cycle type
              </option>
              {allowedCycleTypes.map((type) => (
                <option key={type} value={type}>
                  {humanize(type)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Function check"
            hint="Required when the category policy demands it. A fail discards the device instead of returning it to available."
          >
            <select
              aria-label="Function check"
              className={inputClass}
              value={functionCheck}
              onChange={(e) =>
                setFunctionCheck(e.target.value as "" | CathDeviceFunctionCheck)
              }
            >
              <option value="">Not recorded</option>
              <option value="not_required">Not required</option>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
            </select>
          </Field>
          <p className="text-xs text-muted-foreground">
            Print and affix the label carrying tag {device.device_tag} before
            the device leaves CSSD — the queue row&apos;s{" "}
            <span className="font-medium">Print label</span> action opens it.
          </p>
        </>
      )}

      {action === "quarantine" && (
        <Field label="Reason">
          <input
            aria-label="Quarantine reason"
            className={inputClass}
            value={quarantineReason}
            onChange={(e) => setQuarantineReason(e.target.value)}
          />
        </Field>
      )}

      {action === "discard" && (
        <Field label="Reason">
          <select
            aria-label="Discard reason"
            className={inputClass}
            value={discardReason}
            onChange={(e) =>
              setDiscardReason(e.target.value as "" | CathDeviceDiscardReason)
            }
          >
            <option value="" disabled>
              Select a discard reason
            </option>
            {CATH_DEVICE_DISCARD_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {humanize(reason)}
              </option>
            ))}
          </select>
        </Field>
      )}

      {(action === "release" ||
        action === "discard" ||
        action === "reprocessed") && (
        <Field label="Note">
          <input
            aria-label="Note"
            className={inputClass}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      )}
    </Modal>
  );
}
