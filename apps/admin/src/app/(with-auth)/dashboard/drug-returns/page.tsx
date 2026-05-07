// src/app/(with-auth)/dashboard/drug-returns/page.tsx
//
// Sprint 20 — Drug controller returns workflow.
// Status walk: draft → quarantined → approved → dispatched →
// acknowledged. Schedule H1/X/narcotics need 2nd-pharmacist witness.

"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface Batch {
  id: number;
  batch_serial: string;
  initiated_at: string;
  reason: string;
  counterparty_kind: string;
  counterparty_name: string;
  counterparty_licence_no: string | null;
  status: string;
  ack_reference_no: string | null;
  disposition_method: string | null;
  notes: string | null;
}

interface Line {
  id: number;
  drug_name: string;
  drug_code: string | null;
  schedule: string | null;
  manufacturer: string | null;
  mfr_batch_no: string;
  mfr_date: string | null;
  expiry_date: string | null;
  qty_units: number;
  qty_uom: string;
  storage_condition_at_return: string | null;
  is_narcotic: boolean;
  witness_name: string | null;
  notes: string | null;
}

interface BatchDetail extends Batch {
  lines: Line[];
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

const NEXT_BY_STATUS: Record<string, Array<[string, string]>> = {
  draft: [["quarantined", "Move to quarantine"], ["cancelled", "Cancel"]],
  quarantined: [["approved", "Chief pharmacist approve"], ["cancelled", "Cancel"]],
  approved: [["dispatched", "Mark dispatched"], ["cancelled", "Cancel"]],
  dispatched: [["acknowledged", "Record acknowledgement"]],
};

export default function DrugReturnsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: list = [], isLoading } = useQuery<Batch[]>({
    queryKey: ["drug-returns", "batches", statusFilter],
    queryFn: async () => {
      const q = statusFilter ? `?status=${statusFilter}` : "";
      return unwrapList<Batch>(
        await fetchAdminAPI<unknown>(`/compliance/drug-returns/batches${q}`),
      );
    },
    refetchInterval: 30_000,
  });

  const { data: detail } = useQuery<BatchDetail>({
    queryKey: ["drug-returns", "detail", selectedId],
    queryFn: async () => unwrap<BatchDetail>(
      await fetchAdminAPI<unknown>(`/compliance/drug-returns/batches/${selectedId}`),
    ),
    enabled: selectedId != null,
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Drug Controller Returns</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Schedule H1 / X / narcotic returns workflow with quarantine,
          chief-pharmacist approval, dispatch, and counterparty
          acknowledgement.
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted-foreground">Status:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="quarantined">Quarantined</option>
            <option value="approved">Approved</option>
            <option value="dispatched">Dispatched</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          + New return batch
        </button>
      </div>

      {isLoading && <LoadingSpinner />}
      {!isLoading && list.length === 0 && (
        <EmptyState title="No drug return batches in this view." />
      )}

      {list.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-3">Serial</th>
                <th className="text-left p-3">Reason</th>
                <th className="text-left p-3">Counterparty</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Initiated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id} className="border-t border-border">
                  <td className="p-3 font-mono">{b.batch_serial}</td>
                  <td className="p-3 text-xs uppercase">{b.reason}</td>
                  <td className="p-3">
                    <div>{b.counterparty_name}</div>
                    <div className="text-xs text-muted-foreground uppercase">
                      {b.counterparty_kind}
                    </div>
                  </td>
                  <td className="p-3"><StatusBadge status={b.status} /></td>
                  <td className="p-3 text-xs">{new Date(b.initiated_at).toLocaleDateString()}</td>
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={() => setSelectedId(b.id)}
                      className="text-xs underline"
                    >
                      View / advance
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateBatchModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ["drug-returns"] });
            setShowCreate(false);
            setSelectedId(id);
          }}
        />
      )}

      {selectedId && detail && (
        <BatchDetailModal
          detail={detail}
          onClose={() => setSelectedId(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ["drug-returns"] })}
        />
      )}
    </div>
  );
}

function CreateBatchModal({
  onClose, onCreated,
}: { onClose: () => void; onCreated: (id: number) => void }) {
  const [form, setForm] = useState({
    reason: "expired",
    counterparty_kind: "manufacturer",
    counterparty_name: "",
    counterparty_licence_no: "",
    notes: "",
  });

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetchAdminAPI<unknown>("/compliance/drug-returns/batches", {
        method: "POST", body: JSON.stringify(form),
      });
      return unwrap<{ id: number }>(r);
    },
    onSuccess: (row) => onCreated(row.id),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New drug return batch</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Reason
          </label>
          <select value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
            <option value="expired">Expired</option>
            <option value="near_expiry">Near expiry</option>
            <option value="damaged">Damaged</option>
            <option value="recalled">Recalled (CDSCO)</option>
            <option value="temp_breach">Cold chain breach</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Counterparty
          </label>
          <select value={form.counterparty_kind}
            onChange={(e) => setForm({ ...form, counterparty_kind: e.target.value })}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
            <option value="manufacturer">Manufacturer</option>
            <option value="distributor">Distributor</option>
            <option value="sdc">State Drug Controller (SDC)</option>
          </select>
        </div>

        <Field label="Counterparty name *" v={form.counterparty_name}
          on={(v) => setForm({ ...form, counterparty_name: v })} />
        <Field label="Counterparty licence #" v={form.counterparty_licence_no}
          on={(v) => setForm({ ...form, counterparty_licence_no: v })} />
        <Field label="Notes" v={form.notes} multiline
          on={(v) => setForm({ ...form, notes: v })} />

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!form.counterparty_name.trim() || m.isPending}
            onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Creating…" : "Create draft"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BatchDetailModal({
  detail, onClose, onChanged,
}: {
  detail: BatchDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [showAddLine, setShowAddLine] = useState(false);

  const transitions = NEXT_BY_STATUS[detail.status] ?? [];

  const transition = useMutation({
    mutationFn: async (input: {
      to_status: string;
      ack_reference_no?: string;
      disposition_method?: string;
      quarantine_location?: string;
    }) => fetchAdminAPI<unknown>(
      `/compliance/drug-returns/batches/${detail.id}/transition`,
      { method: "POST", body: JSON.stringify(input) },
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drug-returns"] });
      onChanged();
    },
  });

  const [ackRef, setAckRef] = useState("");
  const [disposition, setDisposition] = useState("returned_to_manufacturer");
  const [quarantineLoc, setQuarantineLoc] = useState("");

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-lg border border-border bg-card p-6 space-y-4 my-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{detail.batch_serial}</h2>
            <div className="text-xs text-muted-foreground">
              {detail.reason} → {detail.counterparty_name} ({detail.counterparty_kind})
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={detail.status} />
            <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
          </div>
        </div>

        {detail.ack_reference_no && (
          <div className="rounded bg-emerald-500/10 p-3 text-sm">
            <strong>Acknowledged:</strong> {detail.ack_reference_no}
            {detail.disposition_method && (
              <> &middot; <span className="text-muted-foreground">disposition:</span> {detail.disposition_method}</>
            )}
          </div>
        )}

        <div className="rounded-lg border border-border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-muted/40">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Lines</div>
            {["draft", "quarantined"].includes(detail.status) && (
              <button type="button" onClick={() => setShowAddLine(true)}
                className="text-xs underline">
                + Add line
              </button>
            )}
          </div>
          {detail.lines.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No lines yet. Add at least one drug before quarantining.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left p-2">Drug</th>
                  <th className="text-left p-2">Sched</th>
                  <th className="text-left p-2">Mfr batch</th>
                  <th className="text-left p-2">Expiry</th>
                  <th className="text-right p-2">Qty</th>
                  <th className="text-left p-2">Witness</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="p-2">
                      {l.drug_name}
                      {l.manufacturer && (
                        <div className="text-xs text-muted-foreground">{l.manufacturer}</div>
                      )}
                    </td>
                    <td className="p-2 text-xs">{l.schedule ?? "—"}</td>
                    <td className="p-2 font-mono text-xs">{l.mfr_batch_no}</td>
                    <td className="p-2 text-xs">{l.expiry_date ?? "—"}</td>
                    <td className="p-2 text-right">
                      {l.qty_units} {l.qty_uom}
                    </td>
                    <td className="p-2 text-xs">
                      {l.is_narcotic && <span className="text-amber-400">⚠ </span>}
                      {l.witness_name ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {transitions.length > 0 && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Advance workflow
            </div>

            {detail.status === "draft" && (
              <div>
                <label className="block text-xs mb-1">Quarantine location</label>
                <input
                  type="text"
                  value={quarantineLoc}
                  onChange={(e) => setQuarantineLoc(e.target.value)}
                  placeholder="e.g. Pharma store room — locked cage"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                />
              </div>
            )}

            {detail.status === "dispatched" && (
              <>
                <div>
                  <label className="block text-xs mb-1">Acknowledgement reference *</label>
                  <input
                    type="text"
                    value={ackRef}
                    onChange={(e) => setAckRef(e.target.value)}
                    placeholder="Counterparty receipt no."
                    className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1">Disposition method *</label>
                  <select value={disposition}
                    onChange={(e) => setDisposition(e.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
                    <option value="returned_to_manufacturer">Returned to manufacturer</option>
                    <option value="incinerated">Incinerated</option>
                    <option value="destroyed_via_sdc">Destroyed via SDC</option>
                    <option value="witnessed_destruction">Witnessed destruction</option>
                  </select>
                </div>
              </>
            )}

            {transition.error instanceof Error && (
              <div className="text-sm text-rose-400">{transition.error.message}</div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {transitions.map(([to, label]) => (
                <button
                  key={to}
                  type="button"
                  disabled={transition.isPending}
                  onClick={() =>
                    transition.mutate({
                      to_status: to,
                      ack_reference_no: to === "acknowledged" ? ackRef : undefined,
                      disposition_method: to === "acknowledged" ? disposition : undefined,
                      quarantine_location: to === "quarantined" ? quarantineLoc : undefined,
                    })
                  }
                  className={`rounded px-3 py-1.5 text-sm ${
                    to === "cancelled"
                      ? "border border-rose-500/40 text-rose-300"
                      : "bg-primary text-primary-foreground"
                  } disabled:opacity-50`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {showAddLine && (
          <AddLineModal
            batchId={detail.id}
            onClose={() => setShowAddLine(false)}
            onAdded={() => {
              qc.invalidateQueries({ queryKey: ["drug-returns"] });
              setShowAddLine(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function AddLineModal({
  batchId, onClose, onAdded,
}: { batchId: number; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({
    drug_name: "",
    schedule: "H",
    manufacturer: "",
    mfr_batch_no: "",
    expiry_date: "",
    qty_units: "",
    qty_uom: "unit",
    is_narcotic: false,
    witness_name: "",
    notes: "",
  });

  const isControlled = form.schedule === "H1" || form.schedule === "X" || form.is_narcotic;
  const witnessRequired = isControlled;

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/compliance/drug-returns/batches/${batchId}/lines`,
      {
        method: "POST",
        body: JSON.stringify({
          ...form,
          qty_units: Number(form.qty_units),
          expiry_date: form.expiry_date || undefined,
        }),
      }),
    onSuccess: () => onAdded(),
  });

  const valid = form.drug_name.trim() && form.mfr_batch_no.trim() &&
    Number(form.qty_units) > 0 && (!witnessRequired || form.witness_name.trim());

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/70 p-6 overflow-y-auto">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Add line</h3>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        <Field label="Drug name *" v={form.drug_name}
          on={(v) => setForm({ ...form, drug_name: v })} />
        <Field label="Manufacturer" v={form.manufacturer}
          on={(v) => setForm({ ...form, manufacturer: v })} />
        <Field label="Mfr batch no. *" v={form.mfr_batch_no}
          on={(v) => setForm({ ...form, mfr_batch_no: v })} />
        <Field label="Expiry date" v={form.expiry_date} type="date"
          on={(v) => setForm({ ...form, expiry_date: v })} />

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Schedule
            </label>
            <select value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
              {["NONE", "G", "C", "C1", "H", "H1", "X"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Qty *
            </label>
            <input type="number" value={form.qty_units}
              onChange={(e) => setForm({ ...form, qty_units: e.target.value })}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.is_narcotic}
            onChange={(e) => setForm({ ...form, is_narcotic: e.target.checked })} />
          Narcotic / controlled substance
        </label>

        <Field label={`Witness ${witnessRequired ? "*" : "(optional)"}`} v={form.witness_name}
          on={(v) => setForm({ ...form, witness_name: v })} />

        {witnessRequired && (
          <div className="text-xs text-amber-300">
            Schedule {form.schedule} / narcotics require a 2nd-pharmacist witness on disposal.
          </div>
        )}

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Adding…" : "Add line"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    quarantined: "bg-amber-500/15 text-amber-300",
    approved: "bg-blue-500/15 text-blue-300",
    dispatched: "bg-indigo-500/15 text-indigo-300",
    acknowledged: "bg-emerald-500/15 text-emerald-300",
    cancelled: "bg-rose-500/15 text-rose-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${tone[status] ?? "bg-muted"}`}>
      {status}
    </span>
  );
}

function Field({
  label, v, on, type = "text", multiline,
}: {
  label: string;
  v: string;
  on: (v: string) => void;
  type?: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </label>
      {multiline ? (
        <textarea rows={2} value={v} onChange={(e) => on(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      ) : (
        <input type={type} value={v} onChange={(e) => on(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      )}
    </div>
  );
}
