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
// twice; `reset()` once the attempt settles means the operator's genuinely
// separate next action is a new attempt rather than a swallowed replay.
//
// Only the transitions cathDeviceReuseService's state machine allows are
// offered (see ACTIONS_BY_STATUS in DevicesTab) — anything else could only ever
// answer 409 CATH_DEVICE_INVALID_TRANSITION.

import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import {
  CATH_DEVICE_CYCLE_TYPES,
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
  onClose,
}: {
  device: CathDevice;
  action: DeviceAction;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const attemptKey = useIdempotencyKey("cssd-device-transition");
  const [cycleType, setCycleType] = useState<CathDeviceCycleType>("eto");
  const [functionCheck, setFunctionCheck] = useState<
    "" | CathDeviceFunctionCheck
  >("");
  const [quarantineReason, setQuarantineReason] = useState("");
  const [discardReason, setDiscardReason] =
    useState<CathDeviceDiscardReason>("other");
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
      attemptKey.reset();
      setFailure(errorMessage(err, "Could not update the device"));
    },
  });

  const disabled =
    run.isPending ||
    (action === "quarantine" && quarantineReason.trim() === "");

  return (
    <Modal
      title={TITLE[action]}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm"
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
                setCycleType(e.target.value as CathDeviceCycleType)
              }
            >
              {CATH_DEVICE_CYCLE_TYPES.map((type) => (
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
            the device leaves CSSD.
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
              setDiscardReason(e.target.value as CathDeviceDiscardReason)
            }
          >
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
