"use client";

import { useMemo, useState, useCallback } from "react";
import { fetchAdminAPI, postJSON } from "@/lib/api";
import {
  ClientTablePagination,
  ManagedTableToolbar,
  SortableTableHeader,
  compareTableValues,
  paginateRows,
  type SortDirection,
} from "@/components/table";
import type { Invoice, InvoiceDetail, RecordPaymentPayload } from "@/lib/api";
import { StatusBadge, INVOICE_STATUS_COLORS, fmt, fmtDate } from "./shared";

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICES TAB
// ═══════════════════════════════════════════════════════════════════════════════

type InvoiceSortKey =
  | "invoice_number"
  | "type"
  | "total_amount"
  | "payment_status"
  | "issued_at";
const INVOICE_SORT_KEYS: InvoiceSortKey[] = [
  "invoice_number",
  "type",
  "total_amount",
  "payment_status",
  "issued_at",
];
const PAGE_SIZE_OPTIONS = [10, 50, 100];

export function InvoicesTab() {
  const [patientUid, setPatientUid] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [tableSearch, setTableSearch] = useState("");
  const [sortKey, setSortKey] = useState<InvoiceSortKey>("issued_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceDetail | null>(
    null,
  );
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
      alert(
        err instanceof Error ? err.message : "Failed to load invoice detail",
      );
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSearch = () => {
    setPatientUid(searchInput);
    setPage(1);
    fetchInvoices(searchInput);
  };

  const visibleInvoices = useMemo(() => {
    const term = tableSearch.trim().toLowerCase();
    const filtered = term
      ? invoices.filter((invoice) =>
          [
            invoice.invoice_number,
            invoice.type,
            invoice.payment_status,
            invoice.total_amount,
            invoice.issued_at,
          ]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(term)),
        )
      : invoices;
    return [...filtered].sort((a, b) => {
      const direction = sortDirection === "asc" ? 1 : -1;
      return compareTableValues(a[sortKey], b[sortKey]) * direction;
    });
  }, [invoices, sortDirection, sortKey, tableSearch]);

  const pagedInvoices = paginateRows(visibleInvoices, page, pageSize);

  const handleSort = (key: typeof sortKey) => {
    setSortDirection((current) =>
      sortKey === key && current === "asc" ? "desc" : "asc",
    );
    setSortKey(key);
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

      {loading && (
        <div className="text-center py-8 text-muted-foreground">
          Loading invoices...
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {!loading && patientUid && invoices.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No invoices found for this patient
        </div>
      )}

      {invoices.length > 0 && (
        <>
          <ManagedTableToolbar
            search={tableSearch}
            onSearchChange={(value) => {
              setTableSearch(value);
              setPage(1);
            }}
            placeholder="Search invoice, type, status"
            countLabel={`${visibleInvoices.length} of ${invoices.length} invoices`}
            savedViewScope="billing-invoices"
            savedViewState={{
              patientUid,
              tableSearch,
              sortKey,
              sortDirection,
              pageSize,
            }}
            onApplySavedView={(view) => {
              const nextPatientUid = String(view.patientUid ?? "");
              setPatientUid(nextPatientUid);
              setSearchInput(nextPatientUid);
              setTableSearch(String(view.tableSearch ?? ""));
              if (INVOICE_SORT_KEYS.includes(view.sortKey as InvoiceSortKey)) {
                setSortKey(view.sortKey as InvoiceSortKey);
              }
              setSortDirection(view.sortDirection === "asc" ? "asc" : "desc");
              const nextPageSize = Number(view.pageSize);
              if (PAGE_SIZE_OPTIONS.includes(nextPageSize))
                setPageSize(nextPageSize);
              setPage(1);
              if (nextPatientUid) void fetchInvoices(nextPatientUid);
            }}
          />
          <div className="overflow-x-auto border border-border rounded-lg">
            <table className="min-w-[860px] w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left bg-muted/50">
                  <SortableTableHeader
                    label="Invoice #"
                    sortKey="invoice_number"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <SortableTableHeader
                    label="Type"
                    sortKey="type"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <SortableTableHeader
                    label="Total"
                    sortKey="total_amount"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <th className="py-2 px-3">Paid</th>
                  <SortableTableHeader
                    label="Status"
                    sortKey="payment_status"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <SortableTableHeader
                    label="Date"
                    sortKey="issued_at"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <th className="py-2 px-3">Due</th>
                  <th className="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {pagedInvoices.rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      No invoices match the current filters
                    </td>
                  </tr>
                ) : (
                  pagedInvoices.rows.map((inv) => (
                    <tr
                      key={inv.id}
                      className="border-b border-border hover:bg-muted/40"
                    >
                      <td className="py-2 px-3 font-medium text-primary">
                        {inv.invoice_number}
                      </td>
                      <td className="py-2 px-3 capitalize">
                        {inv.type.replace("_", " ")}
                      </td>
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
                  ))
                )}
              </tbody>
            </table>
          </div>
          <ClientTablePagination
            page={pagedInvoices.page}
            pageSize={pageSize}
            total={visibleInvoices.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            itemLabel="invoices"
          />
        </>
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
      await postJSON(
        `/api/v1/billing/invoice/${invoice.id}/payment`,
        paymentForm,
      );
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
      <div className="bg-card rounded-xl max-w-xl w-full max-h-[85vh] overflow-y-auto p-6">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-bold">{invoice.invoice_number}</h3>
            <p className="text-sm text-gray-500">
              {fmtDate(invoice.issued_at)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <StatusBadge
            status={invoice.payment_status}
            colorMap={INVOICE_STATUS_COLORS}
          />
          <span className="text-xs text-gray-500 capitalize">
            {invoice.type.replace("_", " ")}
          </span>
        </div>

        {/* Invoice Items */}
        {items.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-semibold text-gray-700 mb-2">
              Line Items
            </p>
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
                      <td className="py-2 px-3 text-right">
                        {fmt(item.unit_price)}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {fmt(item.amount)}
                      </td>
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
              <span className="text-green-600">
                -{fmt(invoice.discount_amount)}
              </span>
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
          {parseFloat(invoice.total_amount) - parseFloat(invoice.paid_amount) >
            0 && (
            <div className="flex justify-between text-orange-600 font-semibold">
              <span>Balance Due</span>
              <span>
                {fmt(
                  parseFloat(invoice.total_amount) -
                    parseFloat(invoice.paid_amount),
                )}
              </span>
            </div>
          )}
        </div>

        {/* Payment History */}
        {transactions.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-semibold text-gray-700 mb-2">
              Payment History
            </p>
            <div className="space-y-2">
              {transactions.map((txn) => (
                <div
                  key={txn.id}
                  className="flex justify-between items-center text-sm bg-green-50 rounded-lg px-3 py-2"
                >
                  <div>
                    <span className="font-medium uppercase">
                      {txn.payment_method}
                    </span>
                    {txn.transaction_ref && (
                      <span className="text-gray-500 ml-2 text-xs">
                        ref: {txn.transaction_ref}
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-green-700">
                      {fmt(txn.amount)}
                    </div>
                    <div className="text-xs text-gray-400">
                      {fmtDate(txn.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        {invoice.notes && (
          <div className="mb-4 text-sm text-gray-600 bg-yellow-50 rounded-lg p-3">
            <span className="font-medium">Notes: </span>
            {invoice.notes}
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
                <p className="text-sm font-semibold text-gray-700">
                  Record Payment
                </p>
                <input
                  type="number"
                  placeholder="Amount (₹)"
                  min={0}
                  value={paymentForm.amount || ""}
                  onChange={(e) =>
                    setPaymentForm({
                      ...paymentForm,
                      amount: parseFloat(e.target.value) || 0,
                    })
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
                    setPaymentForm({
                      ...paymentForm,
                      transaction_ref: e.target.value,
                    })
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
