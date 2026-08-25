"use client";

// Instrument-set master: POST /cssd/sets and GET /cssd/sets/{id}/label.
// Neither had a caller before lane L, so instrument_sets was never written —
// which made every other CSSD surface unreachable, since loads and issues both
// take a set id.

import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  createInstrumentSet,
  getInstrumentSetLabel,
  type CssdInstrumentSet,
  type CssdSetContent,
} from "@/lib/api/cssd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { DialogError, Field, Modal, errorMessage, inputClass } from "./helpers";

type ContentRow = { name: string; quantity: string; critical: boolean };

/* ── New set ────────────────────────────────────────────────────────────── */

export function NewSetDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    set_code: "",
    display_name: "",
    set_type: "instrument_set",
    specialty: "",
    storage_location: "",
    notes: "",
  });
  const [rows, setRows] = useState<ContentRow[]>([
    { name: "", quantity: "1", critical: false },
  ]);
  const [failure, setFailure] = useState<string | null>(null);

  const contents: CssdSetContent[] = rows
    .filter((row) => row.name.trim() !== "")
    .map((row) => ({
      name: row.name.trim(),
      quantity: Number(row.quantity),
      critical: row.critical,
    }));

  // validateSetContents() rejects a non-positive quantity outright, so keep the
  // Create button off rather than posting a body the service will 400.
  const contentsValid = rows
    .filter((row) => row.name.trim() !== "")
    .every(
      (row) => /^\d+$/.test(row.quantity.trim()) && Number(row.quantity) > 0,
    );

  const create = useMutation({
    mutationFn: () =>
      createInstrumentSet({
        set_code: form.set_code.trim() || undefined,
        display_name: form.display_name.trim(),
        set_type: form.set_type.trim() || undefined,
        specialty: form.specialty.trim() || undefined,
        storage_location: form.storage_location.trim() || undefined,
        contents,
        notes: form.notes.trim() || undefined,
      }),
    onSuccess: (set) => {
      toast.success(`Set ${set.set_code} created`);
      qc.invalidateQueries({ queryKey: ["cssd"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(errorMessage(err, "Could not create the instrument set")),
  });

  const canCreate = form.display_name.trim() !== "" && contentsValid;

  return (
    <Modal
      title="New instrument set"
      onClose={onClose}
      wide
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
            disabled={!canCreate || create.isPending}
            onClick={() => {
              setFailure(null);
              create.mutate();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create set"}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      <p className="text-sm text-muted-foreground">
        A new set starts available and usable, with no passed sterilization load
        behind it — issuing it before its first passed load raises a sterility
        warning on the OT case.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Set code" hint="Generated when left blank.">
          <input
            aria-label="Set code"
            className={inputClass}
            value={form.set_code}
            placeholder="e.g. LAP-MAJOR-01"
            onChange={(e) =>
              setForm((f) => ({ ...f, set_code: e.target.value }))
            }
          />
        </Field>
        <Field label="Display name *">
          <input
            aria-label="Display name"
            className={inputClass}
            value={form.display_name}
            placeholder="e.g. Major laparotomy set"
            onChange={(e) =>
              setForm((f) => ({ ...f, display_name: e.target.value }))
            }
          />
        </Field>
        <Field label="Set type">
          <input
            aria-label="Set type"
            className={inputClass}
            value={form.set_type}
            onChange={(e) =>
              setForm((f) => ({ ...f, set_type: e.target.value }))
            }
          />
        </Field>
        <Field label="Specialty">
          <input
            aria-label="Specialty"
            className={inputClass}
            value={form.specialty}
            placeholder="e.g. General surgery"
            onChange={(e) =>
              setForm((f) => ({ ...f, specialty: e.target.value }))
            }
          />
        </Field>
        <Field label="Storage location">
          <input
            aria-label="Storage location"
            className={inputClass}
            value={form.storage_location}
            placeholder="e.g. CSSD rack B3"
            onChange={(e) =>
              setForm((f) => ({ ...f, storage_location: e.target.value }))
            }
          />
        </Field>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Contents</p>
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              className={inputClass}
              value={row.name}
              placeholder="Instrument"
              aria-label={`Instrument name ${index + 1}`}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, i) =>
                    i === index ? { ...r, name: e.target.value } : r,
                  ),
                )
              }
            />
            <input
              className={`${inputClass} max-w-20 text-right`}
              inputMode="numeric"
              value={row.quantity}
              aria-label={`Instrument quantity ${index + 1}`}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, i) =>
                    i === index ? { ...r, quantity: e.target.value } : r,
                  ),
                )
              }
            />
            <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                aria-label={`Instrument ${index + 1} is critical`}
                checked={row.critical}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) =>
                      i === index ? { ...r, critical: e.target.checked } : r,
                    ),
                  )
                }
              />
              Critical
            </label>
            <button
              type="button"
              className="shrink-0 rounded border border-border px-2 py-1 text-xs"
              onClick={() =>
                setRows((prev) => prev.filter((_, i) => i !== index))
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="rounded border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              { name: "", quantity: "1", critical: false },
            ])
          }
        >
          Add instrument
        </button>
      </div>

      <Field label="Notes">
        <textarea
          aria-label="Notes"
          className={inputClass}
          rows={2}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </Field>
    </Modal>
  );
}

/* ── Label ──────────────────────────────────────────────────────────────── */

/**
 * The backend returns the barcode as an SVG document string. It is rendered
 * through an <img> data URI rather than injected as markup: <img> is a
 * non-scripting context for SVG, so no backend string can execute here.
 */
function svgDataUri(svg?: string): string | null {
  const markup = String(svg ?? "").trim();
  if (!markup.startsWith("<svg")) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

export function SetLabelDialog({
  set,
  onClose,
}: {
  set: CssdInstrumentSet;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const label = useQuery({
    queryKey: ["cssd", "set-label", set.id],
    queryFn: async () => {
      const result = await getInstrumentSetLabel(set.id);
      // The GET also stamps label_printed_at on the set, so the list is stale.
      qc.invalidateQueries({ queryKey: ["cssd", "sets"] });
      return result;
    },
    retry: false,
    gcTime: 0,
  });

  const dataUri = svgDataUri(label.data?.svg);

  return (
    <Modal
      title={`Label — ${set.set_code}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-4 py-2 text-sm"
        >
          Close
        </button>
      }
    >
      {label.isLoading && <LoadingSpinner label="Generating label" />}
      {label.error instanceof Error && (
        <DialogError message={label.error.message} />
      )}
      {label.data && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-white p-4 text-center">
            {dataUri ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={dataUri}
                alt={`Code 39 barcode for ${label.data.barcode}`}
                className="mx-auto max-w-full"
              />
            ) : (
              <p className="text-sm text-slate-700">
                Barcode image unavailable — the value is{" "}
                <span className="font-mono">{label.data.barcode}</span>.
              </p>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Set</dt>
            <dd>{label.data.display_name}</dd>
            <dt className="text-muted-foreground">Barcode</dt>
            <dd className="font-mono text-xs">{label.data.barcode}</dd>
            <dt className="text-muted-foreground">Symbology</dt>
            <dd className="uppercase">{label.data.barcode_symbology}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            Opening this label records it as printed against the set and writes
            an audit entry.
          </p>
        </div>
      )}
    </Modal>
  );
}
