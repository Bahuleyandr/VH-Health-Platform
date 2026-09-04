"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAdminAPI, postJSON } from "@/lib/api";
import {
  FACILITY_SCOPE_NOTICE,
  useFacilityAuthority,
} from "./useFacilityAuthority";
import {
  ClientTablePagination,
  ManagedTableToolbar,
  SortableTableHeader,
  compareTableValues,
  paginateRows,
  type SortDirection,
} from "@/components/table";
import type { PharmacyOrderLifecycle } from "./types";
import { ActionButton, StatusBadge } from "./shared";
import { OrderDetailModal } from "./OrderDetailModal";

function formatRelativeMins(mins: number): string {
  if (mins == null || Number.isNaN(mins)) return "—";
  const m = Math.round(mins);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

// Canonical UPPERCASE lifecycle (post-2026-04-14 backend rename).
const STATUS_FILTERS = [
  "",
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "DISPATCHED",
  "DELIVERED",
  "CANCELLED",
];
type OrderSortKey =
  | "order_number"
  | "patient_name"
  | "status"
  | "total_cost"
  | "mins_since_placed";
const ORDER_SORT_KEYS: OrderSortKey[] = [
  "order_number",
  "patient_name",
  "status",
  "total_cost",
  "mins_since_placed",
];
const PAGE_SIZE_OPTIONS = [10, 50, 100];

export function OrdersTab() {
  const [orders, setOrders] = useState<PharmacyOrderLifecycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<OrderSortKey>("mins_since_placed");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [selectedOrder, setSelectedOrder] =
    useState<PharmacyOrderLifecycle | null>(null);

  // OPEN-25, same repair as OverviewTab. /orders/queue is facility-scoped:
  // getOrderQueue makes the identical resolvePharmacyFacility call the SLA read
  // makes, so an administrator holding no facility grant got a red failure box
  // here too. Ask before requesting, using the shared probe so the two tabs
  // cannot gate on subtly different questions.
  const {
    authority,
    error: authorityError,
    loading: authorityLoading,
  } = useFacilityAuthority();
  const hasFacilityAuthority = authority?.has_authority === true;

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = statusFilter ? `?status=${statusFilter}` : "";
      const r = await fetchAdminAPI<{ data: PharmacyOrderLifecycle[] }>(
        `/pharmacy-orders/orders/queue${params}`,
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setOrders(Array.isArray(data) ? data : []);
    } catch (err) {
      setOrders([]);
      setError(
        err instanceof Error ? err.message : "Could not load pharmacy orders",
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    // Wait for the probe, then only request what this viewer can be granted.
    // `authority === null` means UNRESOLVED, not "no authority" — firing on it
    // would reintroduce the very call this gate exists to avoid.
    if (authorityLoading) return;
    if (!hasFacilityAuthority) {
      setOrders([]);
      setLoading(false);
      return;
    }
    fetchOrders();
  }, [authorityLoading, hasFacilityAuthority, fetchOrders]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, pageSize]);

  const visibleOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = term
      ? orders.filter((order) =>
          [
            order.order_number,
            order.patient_name,
            order.phone,
            order.delivery_type,
            order.status,
            order.delivery_person,
          ]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(term)),
        )
      : orders;

    return [...filtered].sort((a, b) => {
      const direction = sortDirection === "asc" ? 1 : -1;
      return compareTableValues(a[sortKey], b[sortKey]) * direction;
    });
  }, [orders, search, sortDirection, sortKey]);

  const pagedOrders = paginateRows(visibleOrders, page, pageSize);

  const handleSort = (key: OrderSortKey) => {
    setSortDirection((current) =>
      sortKey === key && current === "asc" ? "desc" : "asc",
    );
    setSortKey(key);
  };

  const doAction = async (
    orderId: number,
    action: string,
    body: Record<string, unknown> = {},
  ) => {
    setActionLoading(orderId);
    try {
      await postJSON(
        `/api/v1/pharmacy-orders/orders/${orderId}/${action}`,
        body,
      );
      fetchOrders();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const isPending = (s: string) => s === "PENDING" || s === "PLACED"; // legacy alias

  return (
    <div className="space-y-4">
      <ManagedTableToolbar
        search={search}
        onSearchChange={setSearch}
        placeholder="Search order, patient, phone, status"
        countLabel={`${visibleOrders.length} of ${orders.length} orders`}
        savedViewScope="pharmacy-orders"
        savedViewState={{
          search,
          statusFilter,
          sortKey,
          sortDirection,
          pageSize,
        }}
        onApplySavedView={(view) => {
          setSearch(String(view.search ?? ""));
          setStatusFilter(String(view.statusFilter ?? ""));
          if (ORDER_SORT_KEYS.includes(view.sortKey as OrderSortKey)) {
            setSortKey(view.sortKey as OrderSortKey);
          }
          setSortDirection(view.sortDirection === "desc" ? "desc" : "asc");
          const nextPageSize = Number(view.pageSize);
          if (PAGE_SIZE_OPTIONS.includes(nextPageSize))
            setPageSize(nextPageSize);
          setPage(1);
        }}
      >
        <button
          onClick={fetchOrders}
          className="rounded-md border border-input px-3 py-2 text-sm text-primary hover:bg-muted"
        >
          Refresh
        </button>
      </ManagedTableToolbar>

      <div className="flex gap-2 flex-wrap">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatusFilter(s);
              setPage(1);
            }}
            className={`px-3 py-1 rounded-full text-sm ${
              statusFilter === s
                ? "bg-primary text-white"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {s || "All"}
          </button>
        ))}
      </div>

      {authorityLoading ? (
        <div className="text-center py-8">Loading orders...</div>
      ) : authorityError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {authorityError}
        </div>
      ) : !hasFacilityAuthority ? (
        // Scope notice, not an error: this viewer is legitimate, the data is
        // not theirs to see. Deliberately styled and worded as information.
        <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          {FACILITY_SCOPE_NOTICE}
        </div>
      ) : loading ? (
        <div className="text-center py-8">Loading orders...</div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          No orders found
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-[980px] w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <SortableTableHeader
                    label="Order #"
                    sortKey="order_number"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <SortableTableHeader
                    label="Patient"
                    sortKey="patient_name"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <th className="py-2 px-3">Phone</th>
                  <th className="py-2 px-3">Type</th>
                  <SortableTableHeader
                    label="Total"
                    sortKey="total_cost"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <SortableTableHeader
                    label="Status"
                    sortKey="status"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <th className="py-2 px-3">ETA</th>
                  <SortableTableHeader
                    label="Time"
                    sortKey="mins_since_placed"
                    activeSort={sortKey}
                    direction={sortDirection}
                    onSort={handleSort}
                    className="px-3 py-2"
                  />
                  <th className="py-2 px-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedOrders.rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      No orders match the current filters
                    </td>
                  </tr>
                ) : (
                  pagedOrders.rows.map((o) => (
                    <tr
                      key={o.id}
                      className={`border-b border-border hover:bg-muted/50 ${
                        o.sla_breached ? "bg-red-50" : ""
                      }`}
                    >
                      <td className="py-2 px-3 font-medium">
                        <button
                          onClick={() => setSelectedOrder(o)}
                          className="text-primary hover:underline"
                        >
                          {o.order_number || `#${o.id}`}
                        </button>
                      </td>
                      <td className="py-2 px-3">
                        {o.patient_name || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        {o.phone || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 capitalize">
                        {o.delivery_type}
                      </td>
                      <td className="py-2 px-3">
                        {o.total_cost ? `₹${o.total_cost}` : "—"}
                      </td>
                      <td className="py-2 px-3">
                        <StatusBadge status={o.status} />
                      </td>
                      <td className="py-2 px-3 text-xs">
                        {o.status === "DISPATCHED" &&
                        o.estimated_delivery_mins ? (
                          <span className="flex items-center gap-1">
                            {o.delivery_tracking_active && (
                              <span title="Live tracking">📍</span>
                            )}
                            ~{o.estimated_delivery_mins}m
                            {o.delivery_distance_km ? (
                              <span className="text-muted-foreground ml-1">
                                ({o.delivery_distance_km}km)
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 px-3 text-muted-foreground">
                        {formatRelativeMins(o.mins_since_placed)}
                        {o.sla_breached && (
                          <span className="ml-1 text-red-600 text-xs">
                            ⚠ SLA
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex gap-1 flex-wrap">
                          {isPending(o.status) && (
                            <ActionButton
                              label="Confirm"
                              color="blue"
                              loading={actionLoading === o.id}
                              onClick={() => {
                                const cost = prompt("Total cost (₹):");
                                if (cost !== null) {
                                  doAction(o.id, "confirm", {
                                    total_cost: Number(cost) || 0,
                                    items_list: [],
                                  });
                                }
                              }}
                            />
                          )}
                          {o.status === "CONFIRMED" && (
                            <ActionButton
                              label="Prepare"
                              color="amber"
                              loading={actionLoading === o.id}
                              onClick={() => doAction(o.id, "preparing")}
                            />
                          )}
                          {(o.status === "PREPARING" ||
                            o.status === "CONFIRMED") && (
                            <ActionButton
                              label="Dispatch"
                              color="teal"
                              loading={actionLoading === o.id}
                              onClick={() => {
                                const person = prompt("Delivery person name:");
                                const phone = prompt("Delivery person phone:");
                                if (person !== null) {
                                  doAction(o.id, "dispatch", {
                                    delivery_person: person,
                                    delivery_person_phone: phone || "",
                                  });
                                }
                              }}
                            />
                          )}
                          {o.status === "DISPATCHED" && (
                            <ActionButton
                              label="Delivered"
                              color="green"
                              loading={actionLoading === o.id}
                              onClick={() => doAction(o.id, "delivered")}
                            />
                          )}
                          {!["DELIVERED", "CANCELLED"].includes(o.status) && (
                            <ActionButton
                              label="Cancel"
                              color="red"
                              loading={actionLoading === o.id}
                              onClick={() => {
                                const reason = prompt("Cancellation reason:");
                                if (reason !== null) {
                                  doAction(o.id, "cancel", {
                                    cancellation_reason: reason,
                                  });
                                }
                              }}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <ClientTablePagination
            page={pagedOrders.page}
            pageSize={pageSize}
            total={visibleOrders.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            itemLabel="orders"
          />
        </>
      )}

      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  );
}
