// src/app/(with-auth)/dashboard/billing/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";
import type {
  RevenueStats,
  Invoice,
  InvoiceDetail,
  InsuranceClaim,
  RecordPaymentPayload,
  UpdateClaimPayload,
} from "@/lib/api";

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function StatCard({
  label,
  value,
  color = "text-foreground",
  bg = "bg-card",
}: {
  label: string;
  value: string | number;
  color?: string;
  bg?: string;
}) {
  return (
    <div className={`${bg} border border-border rounded-lg p-4`}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

const INVOICE_STATUS_COLORS: Record<string, string> = {
  paid: "bg-green-100 text-green-700",
  pending: "bg-orange-100 text-orange-700",
  partial: "bg-blue-100 text-blue-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-600",
};

const CLAIM_STATUS_COLORS: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-700",
  under_review: "bg-amber-100 text-amber-700",
  approved: "bg-green-100 text-green-700",
  partially_approved: "bg-teal-100 text-teal-700",
  rejected: "bg-red-100 text-red-700",
  paid: "bg-emerald-100 text-emerald-700",
};

function StatusBadge({
  status,
  colorMap,
}: {
  status: string;
  colorMap: Record<string, string>;
}) {
  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${
        colorMap[status.toLowerCase()] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {status}
    </span>
  );
}

function fmt(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REVENUE SUMMARY TAB
// ═══════════════════════════════════════════════════════════════════════════════

function RevenueSummaryTab() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
    .toISOString()
    .split("T")[0];
  const todayStr = today.toISOString().split("T")[0];

  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);
  const [stats, setStats] = useState<RevenueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRevenue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: RevenueStats }>(
        `/billing/revenue?date_from=${dateFrom}&date_to=${dateTo}`,
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setStats(data as RevenueStats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load revenue data");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    fetchRevenue();
  }, [fetchRevenue]);

  return (
    <div className="space-y-6">
      {/* Date Range Filter */}
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={fetchRevenue}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90"
        >
          Apply
        </button>
      </div>

      {loading && <div className="text-center py-8 text-muted-foreground">Loading revenue data...</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {stats && !loading && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Total Billed"
              value={fmt(stats.summary.total_billed)}
              color="text-foreground"
            />
            <StatCard
              label="Total Collected"
              value={fmt(stats.summary.total_collected)}
              color="text-green-700"
              bg="bg-green-50"
            />
            <StatCard
              label="Outstanding"
              value={fmt(stats.summary.total_outstanding)}
              color="text-orange-600"
              bg="bg-orange-50"
            />
            <StatCard
              label="Total Invoices"
              value={stats.summary.total_invoices}
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Paid"
              value={stats.summary.paid_count}
              color="text-green-600"
            />
            <StatCard
              label="Pending"
              value={stats.summary.pending_count}
              color="text-orange-600"
            />
            <StatCard
              label="Partial"
              value={stats.summary.partial_count}
              color="text-blue-600"
            />
            <StatCard
              label="Discounts Given"
              value={fmt(stats.summary.total_discounts)}
              color="text-muted-foreground"
            />
          </div>

          {/* By Type */}
          {stats.by_type.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="bg-muted px-4 py-2 font-medium text-sm">Revenue by Type</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left bg-muted/50">
                      <th className="py-2 px-3">Type</th>
                      <th className="py-2 px-3">Invoices</th>
                      <th className="py-2 px-3">Billed</th>
                      <th className="py-2 px-3">Collected</th>
                      <th className="py-2 px-3">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.by_type.map((row) => (
                      <tr key={row.type} className="border-b border-border hover:bg-muted/30">
                        <td className="py-2 px-3 capitalize font-medium">{row.type.replace("_", " ")}</td>
                        <td className="py-2 px-3">{row.invoice_count}</td>
                        <td className="py-2 px-3">{fmt(row.total_billed)}</td>
                        <td className="py-2 px-3">{fmt(row.total_collected)}</td>
                        <td className="py-2 px-3">{fmt(row.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* By Payment Method */}
          {stats.by_payment_method.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="bg-muted px-4 py-2 font-medium text-sm">By Payment Method</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left bg-muted/50">
                      <th className="py-2 px-3">Method</th>
                      <th className="py-2 px-3">Transactions</th>
                      <th className="py-2 px-3">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.by_payment_method.map((row) => (
                      <tr key={row.payment_method} className="border-b border-border hover:bg-muted/30">
                        <td className="py-2 px-3 uppercase font-medium">{row.payment_method}</td>
                        <td className="py-2 px-3">{row.transaction_count}</td>
                        <td className="py-2 px-3">{fmt(row.total_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICES TAB
// ═══════════════════════════════════════════════════════════════════════════════

function InvoicesTab() {
  const [patientUid, setPatientUid] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInvoices = useCallback(async (uid: string) => {
    if (!uid.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: Invoice[] }>(
        `/billing/invoices/patient/${uid.trim()}`,
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setInvoices(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invoices");
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const openInvoiceDetail = async (invoiceId: number) => {
    setDetailLoading(true);
    try {
      const r = await fetchAdminAPI<{ data: InvoiceDetail }>(
        `/billing/invoice/${invoiceId}`,
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setSelectedInvoice(data as InvoiceDetail);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to load invoice detail");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSearch = () => {
    setPatientUid(searchInput);
    fetchInvoices(searchInput);
  };

  return (
    <div className="space-y-4">
      {/* Patient UID search */}
      <div className="flex gap-2">
        <input
          placeholder="Enter Patient UID to search invoices"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1 border border-border rounded-lg px-3 py-2 text-sm"
        />
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90"
        >
          Search
        </button>
      </div>

      {!patientUid && (
        <div className="text-center py-12 text-muted-foreground text-sm">
          Enter a Patient UID above to view their invoices
        </div>
      )}

      {loading && <div className="text-center py-8 text-muted-foreground">Loading invoices...</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>
      )}

      {!loading && patientUid && invoices.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">No invoices found for this patient</div>
      )}

      {invoices.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Invoice #</th>
                <th className="py-2 px-3">Type</th>
                <th className="py-2 px-3">Total</th>
                <th className="py-2 px-3">Paid</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Date</th>
                <th className="py-2 px-3">Due</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-border hover:bg-muted/40">
                  <td className="py-2 px-3 font-medium text-primary">
                    {inv.invoice_number}
                  </td>
                  <td className="py-2 px-3 capitalize">{inv.type.replace("_", " ")}</td>
                  <td className="py-2 px-3">{fmt(inv.total_amount)}</td>
                  <td className="py-2 px-3">{fmt(inv.paid_amount)}</td>
                  <td className="py-2 px-3">
                    <StatusBadge
                      status={inv.payment_status}
                      colorMap={INVOICE_STATUS_COLORS}
                    />
                  </td>
                  <td className="py-2 px-3">{fmtDate(inv.issued_at)}</td>
                  <td className="py-2 px-3">{fmtDate(inv.due_date)}</td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() => openInvoiceDetail(inv.id)}
                      disabled={detailLoading}
                      className="text-xs text-primary hover:underline disabled:opacity-50"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Invoice Detail Modal */}
      {selectedInvoice && (
        <InvoiceDetailModal
          invoice={selectedInvoice}
          onClose={() => setSelectedInvoice(null)}
          onPaymentRecorded={() => {
            setSelectedInvoice(null);
            fetchInvoices(patientUid);
          }}
        />
      )}
    </div>
  );
}

// ── Invoice Detail Modal ─────────────────────────────────────────────────────

function InvoiceDetailModal({
  invoice,
  onClose,
  onPaymentRecorded,
}: {
  invoice: InvoiceDetail;
  onClose: () => void;
  onPaymentRecorded: () => void;
}) {
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentForm, setPaymentForm] = useState<RecordPaymentPayload>({
    amount: 0,
    method: "cash",
    transaction_ref: "",
  });
  const [paying, setPaying] = useState(false);

  const submitPayment = async () => {
    if (!paymentForm.amount || paymentForm.amount <= 0) {
      alert("Enter a valid payment amount");
      return;
    }
    setPaying(true);
    try {
      await postJSON(`/api/v1/billing/invoice/${invoice.id}/payment`, paymentForm);
      onPaymentRecorded();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setPaying(false);
    }
  };

  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const transactions = Array.isArray(invoice.payment_transactions)
    ? invoice.payment_transactions
    : [];

  const canRecordPayment = !["paid", "cancelled"].includes(
    invoice.payment_status.toLowerCase(),
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-xl w-full max-h-[85vh] overflow-y-auto p-6">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-bold">{invoice.invoice_number}</h3>
            <p className="text-sm text-gray-500">{fmtDate(invoice.issued_at)}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <StatusBadge status={invoice.payment_status} colorMap={INVOICE_STATUS_COLORS} />
          <span className="text-xs text-gray-500 capitalize">
            {invoice.type.replace("_", " ")}
          </span>
        </div>

        {/* Invoice Items */}
        {items.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-semibold text-gray-700 mb-2">Line Items</p>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="py-2 px-3 text-left">Description</th>
                    <th className="py-2 px-3 text-right">Qty</th>
                    <th className="py-2 px-3 text-right">Unit</th>
                    <th className="py-2 px-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="py-2 px-3">{item.description}</td>
                      <td className="py-2 px-3 text-right">{item.quantity}</td>
                      <td className="py-2 px-3 text-right">{fmt(item.unit_price)}</td>
                      <td className="py-2 px-3 text-right">{fmt(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Totals */}
        <div className="space-y-1 text-sm mb-4 bg-gray-50 rounded-lg p-3">
          <div className="flex justify-between">
            <span className="text-gray-500">Subtotal</span>
            <span>{fmt(invoice.subtotal)}</span>
          </div>
          {parseFloat(invoice.tax_amount) > 0 && (
            <div className="flex justify-between">
              <span className="text-gray-500">Tax</span>
              <span>{fmt(invoice.tax_amount)}</span>
            </div>
          )}
          {parseFloat(invoice.discount_amount) > 0 && (
            <div className="flex justify-between">
              <span className="text-gray-500">Discount</span>
              <span className="text-green-600">-{fmt(invoice.discount_amount)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold border-t border-gray-200 pt-1 mt-1">
            <span>Total</span>
            <span>{fmt(invoice.total_amount)}</span>
          </div>
          <div className="flex justify-between text-green-700">
            <span>Paid</span>
            <span>{fmt(invoice.paid_amount)}</span>
          </div>
          {parseFloat(invoice.total_amount) - parseFloat(invoice.paid_amount) > 0 && (
            <div className="flex justify-between text-orange-600 font-semibold">
              <span>Balance Due</span>
              <span>{fmt(parseFloat(invoice.total_amount) - parseFloat(invoice.paid_amount))}</span>
            </div>
          )}
        </div>

        {/* Payment History */}
        {transactions.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-semibold text-gray-700 mb-2">Payment History</p>
            <div className="space-y-2">
              {transactions.map((txn) => (
                <div
                  key={txn.id}
                  className="flex justify-between items-center text-sm bg-green-50 rounded-lg px-3 py-2"
                >
                  <div>
                    <span className="font-medium uppercase">{txn.payment_method}</span>
                    {txn.transaction_ref && (
                      <span className="text-gray-500 ml-2 text-xs">
                        ref: {txn.transaction_ref}
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-green-700">{fmt(txn.amount)}</div>
                    <div className="text-xs text-gray-400">{fmtDate(txn.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        {invoice.notes && (
          <div className="mb-4 text-sm text-gray-600 bg-yellow-50 rounded-lg p-3">
            <span className="font-medium">Notes: </span>{invoice.notes}
          </div>
        )}

        {/* Record Payment */}
        {canRecordPayment && (
          <div className="border-t border-gray-200 pt-4">
            {!showPaymentForm ? (
              <button
                onClick={() => setShowPaymentForm(true)}
                className="w-full py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90 font-medium"
              >
                + Record Payment
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-700">Record Payment</p>
                <input
                  type="number"
                  placeholder="Amount (₹)"
                  min={0}
                  value={paymentForm.amount || ""}
                  onChange={(e) =>
                    setPaymentForm({ ...paymentForm, amount: parseFloat(e.target.value) || 0 })
                  }
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
                <select
                  value={paymentForm.method}
                  onChange={(e) =>
                    setPaymentForm({
                      ...paymentForm,
                      method: e.target.value as RecordPaymentPayload["method"],
                    })
                  }
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="upi">UPI</option>
                  <option value="insurance">Insurance</option>
                  <option value="cheque">Cheque</option>
                </select>
                <input
                  placeholder="Transaction Reference (optional)"
                  value={paymentForm.transaction_ref ?? ""}
                  onChange={(e) =>
                    setPaymentForm({ ...paymentForm, transaction_ref: e.target.value })
                  }
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowPaymentForm(false)}
                    className="flex-1 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitPayment}
                    disabled={paying}
                    className="flex-1 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
                  >
                    {paying ? "Processing..." : "Confirm Payment"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSURANCE CLAIMS TAB
// ═══════════════════════════════════════════════════════════════════════════════

function InsuranceClaimsTab() {
  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedClaim, setSelectedClaim] = useState<InsuranceClaim | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = statusFilter ? `?status=${statusFilter}` : "";
      const r = await fetchAdminAPI<{ data: InsuranceClaim[] }>(
        `/billing/insurance/claims${params}`,
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setClaims(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load claims");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchClaims();
  }, [fetchClaims]);

  const updateClaimStatus = async (claimId: number, payload: UpdateClaimPayload) => {
    try {
      await putJSON(`/api/v1/billing/insurance/claim/${claimId}`, payload);
      setSelectedClaim(null);
      fetchClaims();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Update failed");
    }
  };

  const STATUS_OPTIONS = [
    "",
    "submitted",
    "under_review",
    "approved",
    "partially_approved",
    "rejected",
    "paid",
  ];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              statusFilter === s
                ? "bg-primary text-white"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {s ? s.replace("_", " ") : "All"}
          </button>
        ))}
        <button
          onClick={fetchClaims}
          className="ml-auto text-sm text-primary hover:underline"
        >
          ↻ Refresh
        </button>
      </div>

      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading claims...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {!loading && claims.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No insurance claims found
        </div>
      )}

      {claims.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Claim #</th>
                <th className="py-2 px-3">Provider</th>
                <th className="py-2 px-3">Policy</th>
                <th className="py-2 px-3">Claim Amount</th>
                <th className="py-2 px-3">Approved</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Submitted</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => (
                <tr key={claim.id} className="border-b border-border hover:bg-muted/40">
                  <td className="py-2 px-3 font-medium">{claim.claim_number}</td>
                  <td className="py-2 px-3">{claim.insurance_provider}</td>
                  <td className="py-2 px-3 font-mono text-xs">{claim.policy_number}</td>
                  <td className="py-2 px-3">{fmt(claim.claim_amount)}</td>
                  <td className="py-2 px-3">{fmt(claim.approved_amount)}</td>
                  <td className="py-2 px-3">
                    <StatusBadge status={claim.status} colorMap={CLAIM_STATUS_COLORS} />
                  </td>
                  <td className="py-2 px-3">{fmtDate(claim.submitted_at)}</td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() => setSelectedClaim(claim)}
                      className="text-xs text-primary hover:underline"
                    >
                      Update
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Update Claim Modal */}
      {selectedClaim && (
        <UpdateClaimModal
          claim={selectedClaim}
          onClose={() => setSelectedClaim(null)}
          onUpdate={updateClaimStatus}
        />
      )}
    </div>
  );
}

// ── Update Claim Modal ───────────────────────────────────────────────────────

function UpdateClaimModal({
  claim,
  onClose,
  onUpdate,
}: {
  claim: InsuranceClaim;
  onClose: () => void;
  onUpdate: (claimId: number, payload: UpdateClaimPayload) => void;
}) {
  const [form, setForm] = useState<UpdateClaimPayload>({
    status: claim.status as UpdateClaimPayload["status"],
    approved_amount: claim.approved_amount
      ? parseFloat(claim.approved_amount)
      : undefined,
    reason: claim.rejection_reason ?? "",
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    await onUpdate(claim.id, form);
    setSaving(false);
  };

  const STATUS_OPTIONS: UpdateClaimPayload["status"][] = [
    "submitted",
    "under_review",
    "approved",
    "partially_approved",
    "rejected",
    "paid",
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-bold">Update Claim</h3>
            <p className="text-sm text-gray-500">{claim.claim_number}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ✕
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-xs text-gray-500 mb-1">Insurance Provider</p>
            <p className="text-sm font-medium">{claim.insurance_provider}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Claim Amount</p>
            <p className="text-sm font-medium">{fmt(claim.claim_amount)}</p>
          </div>

          <div>
            <label className="text-xs text-gray-500 block mb-1">Status</label>
            <select
              value={form.status}
              onChange={(e) =>
                setForm({ ...form, status: e.target.value as UpdateClaimPayload["status"] })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>

          {(form.status === "approved" || form.status === "partially_approved") && (
            <div>
              <label className="text-xs text-gray-500 block mb-1">Approved Amount (₹)</label>
              <input
                type="number"
                min={0}
                value={form.approved_amount ?? ""}
                onChange={(e) =>
                  setForm({ ...form, approved_amount: parseFloat(e.target.value) || 0 })
                }
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          )}

          {form.status === "rejected" && (
            <div>
              <label className="text-xs text-gray-500 block mb-1">Rejection Reason</label>
              <textarea
                rows={3}
                value={form.reason ?? ""}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
                placeholder="State the reason for rejection..."
              />
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={onClose}
            className="flex-1 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Update Claim"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function BillingContent() {
  const [tab, setTab] = useState<"revenue" | "invoices" | "claims">("revenue");

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-6">Billing &amp; Invoicing</h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[
          { key: "revenue" as const, label: "📊 Revenue" },
          { key: "invoices" as const, label: "🧾 Invoices" },
          { key: "claims" as const, label: "🏥 Insurance Claims" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === key
                ? "bg-white text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "revenue" && <RevenueSummaryTab />}
      {tab === "invoices" && <InvoicesTab />}
      {tab === "claims" && <InsuranceClaimsTab />}
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading billing...</div>}>
      <BillingContent />
    </Suspense>
  );
}
