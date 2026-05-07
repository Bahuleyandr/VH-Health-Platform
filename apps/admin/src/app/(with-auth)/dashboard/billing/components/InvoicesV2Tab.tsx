"use client";

// Sprint 1 — Billing v2 invoice list + create. Hits the /api/v1/billing/v2
// surface (line-item invoices with GST split, payments, advances, refunds).

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface InvoiceV2 {
  id: number;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_type: string;
  status: "draft" | "issued" | "paid" | "partially_paid" | "void" | "refunded";
  patient_uid: string;
  patient_name: string | null;
  subtotal: number | string;
  gst_total: number | string;
  discount_total: number | string;
  grand_total: number | string;
  amount_paid: number | string;
  amount_due: number | string;
  currency: string;
}

const STATUS_COLOURS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  issued: "bg-blue-100 text-blue-800",
  paid: "bg-emerald-200 text-emerald-900",
  partially_paid: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  void: "bg-rose-100 text-rose-800",
  refunded: "bg-amber-100 text-amber-800",
};

function fmtINR(n: number | string | null | undefined): string {
  const num = Number(n ?? 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(num);
}

interface DraftItem {
  service_code: string;
  description: string;
  quantity: string;
  unit_price: string;
  gst_rate: string;
}

const EMPTY_ITEM: DraftItem = {
  service_code: "",
  description: "",
  quantity: "1",
  unit_price: "",
  gst_rate: "18",
};

export function InvoicesV2Tab() {
  const [rows, setRows] = useState<InvoiceV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");

  // Create-invoice modal state
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    patient_uid: "",
    patient_state: "",
    hospital_state: "",
    invoice_type: "OP",
  });
  const [items, setItems] = useState<DraftItem[]>([{ ...EMPTY_ITEM }]);
  const [creating, setCreating] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetchAdminAPI<{ data: InvoiceV2[] } | InvoiceV2[]>(
        `/billing/v2/invoices?${params.toString()}`,
      );
      const data = (r as { data?: InvoiceV2[] }).data ?? (r as InvoiceV2[]);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invoices");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  function addItem() {
    setItems([...items, { ...EMPTY_ITEM }]);
  }

  function removeItem(idx: number) {
    setItems(items.filter((_, i) => i !== idx));
  }

  function updateItem(idx: number, key: keyof DraftItem, value: string) {
    const next = [...items];
    next[idx] = { ...next[idx], [key]: value };
    setItems(next);
  }

  async function createInvoice() {
    setCreating(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: InvoiceV2 } | InvoiceV2>(
        "/billing/v2/invoices",
        {
          method: "POST",
          body: JSON.stringify({
            ...createForm,
          }),
        },
      );
      const inv = (r as { data?: InvoiceV2 }).data ?? (r as InvoiceV2);
      // Add each item.
      for (const item of items) {
        if (!item.description || !item.unit_price) continue;
        await fetchAdminAPI(`/billing/v2/invoices/${inv.id}/items`, {
          method: "POST",
          body: JSON.stringify({
            service_code: item.service_code || null,
            description: item.description,
            quantity: Number(item.quantity || 1),
            unit_price: Number(item.unit_price),
            gst_rate: Number(item.gst_rate || 0),
          }),
        });
      }
      setShowCreate(false);
      setCreateForm({
        patient_uid: "",
        patient_state: "",
        hospital_state: "",
        invoice_type: "OP",
      });
      setItems([{ ...EMPTY_ITEM }]);
      await fetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {[
              "draft",
              "issued",
              "partially_paid",
              "paid",
              "void",
              "refunded",
            ].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          + New invoice
        </button>
        <div className="flex-1" />
        <button
          onClick={fetch}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No invoices" description="Try clearing the filter or create a new invoice." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Invoice #</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Subtotal</th>
                <th className="px-3 py-2">GST</th>
                <th className="px-3 py-2">Total</th>
                <th className="px-3 py-2">Paid</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.invoice_number ?? `#${r.id}`}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.invoice_date ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.invoice_type}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.patient_name ?? r.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 font-mono">{fmtINR(r.subtotal)}</td>
                  <td className="px-3 py-2 font-mono">{fmtINR(r.gst_total)}</td>
                  <td className="px-3 py-2 font-mono font-semibold">
                    {fmtINR(r.grand_total)}
                  </td>
                  <td className="px-3 py-2 font-mono">{fmtINR(r.amount_paid)}</td>
                  <td className="px-3 py-2 font-mono">
                    {Number(r.amount_due) > 0 ? (
                      <span className="text-rose-700">{fmtINR(r.amount_due)}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[r.status] ?? ""
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-3xl">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="text-lg font-semibold">New invoice</h2>
              <button
                onClick={() => setShowCreate(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Patient UID
                  </label>
                  <input
                    value={createForm.patient_uid}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, patient_uid: e.target.value })
                    }
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Type
                  </label>
                  <select
                    value={createForm.invoice_type}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, invoice_type: e.target.value })
                    }
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="OP">OP (Outpatient)</option>
                    <option value="IP">IP (Inpatient)</option>
                    <option value="DAYCARE">Daycare</option>
                    <option value="LAB">Lab</option>
                    <option value="PHARMACY">Pharmacy</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Patient state (for GST)
                  </label>
                  <input
                    value={createForm.patient_state}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, patient_state: e.target.value })
                    }
                    placeholder="Karnataka"
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Hospital state
                  </label>
                  <input
                    value={createForm.hospital_state}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, hospital_state: e.target.value })
                    }
                    placeholder="Karnataka"
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-muted-foreground">Items</label>
                  <button
                    onClick={addItem}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    + add item
                  </button>
                </div>
                <div className="space-y-2">
                  {items.map((item, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2 items-center bg-muted/30 p-2 rounded"
                    >
                      <input
                        value={item.service_code}
                        onChange={(e) => updateItem(idx, "service_code", e.target.value)}
                        placeholder="Code"
                        className="col-span-2 border rounded px-2 py-1 text-xs font-mono"
                      />
                      <input
                        value={item.description}
                        onChange={(e) => updateItem(idx, "description", e.target.value)}
                        placeholder="Description"
                        className="col-span-4 border rounded px-2 py-1 text-xs"
                      />
                      <input
                        value={item.quantity}
                        onChange={(e) => updateItem(idx, "quantity", e.target.value)}
                        placeholder="Qty"
                        className="col-span-1 border rounded px-2 py-1 text-xs font-mono text-right"
                      />
                      <input
                        value={item.unit_price}
                        onChange={(e) => updateItem(idx, "unit_price", e.target.value)}
                        placeholder="Unit ₹"
                        className="col-span-2 border rounded px-2 py-1 text-xs font-mono text-right"
                      />
                      <input
                        value={item.gst_rate}
                        onChange={(e) => updateItem(idx, "gst_rate", e.target.value)}
                        placeholder="GST %"
                        className="col-span-2 border rounded px-2 py-1 text-xs font-mono text-right"
                      />
                      <button
                        onClick={() => removeItem(idx)}
                        disabled={items.length === 1}
                        className="col-span-1 text-rose-600 disabled:opacity-30"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="p-4 border-t flex items-center justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={createInvoice}
                disabled={creating || !createForm.patient_uid}
                className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
              >
                {creating ? "Creating…" : "Create draft"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
