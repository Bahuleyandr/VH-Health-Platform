"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI, postJSON } from "@/lib/api";
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
const STATUS_FILTERS = ["", "PENDING", "CONFIRMED", "PREPARING", "READY", "DISPATCHED", "DELIVERED", "CANCELLED"];

export function OrdersTab() {
  const [orders, setOrders] = useState<PharmacyOrderLifecycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<PharmacyOrderLifecycle | null>(null);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const params = statusFilter ? `?status=${statusFilter}` : "";
      const r = await fetchAdminAPI<{ data: PharmacyOrderLifecycle[] }>(
        `/pharmacy-orders/orders/queue${params}`,
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setOrders(Array.isArray(data) ? data : []);
    } catch {
      /* empty */
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const doAction = async (orderId: number, action: string, body: Record<string, unknown> = {}) => {
    setActionLoading(orderId);
    try {
      await postJSON(`/api/v1/pharmacy-orders/orders/${orderId}/${action}`, body);
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
      <div className="flex gap-2 flex-wrap">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded-full text-sm ${
              statusFilter === s
                ? "bg-primary text-white"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {s || "All"}
          </button>
        ))}
        <button onClick={fetchOrders} className="ml-auto text-sm text-primary hover:underline">
          ↻ Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-center py-8">Loading orders...</div>
      ) : orders.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">No orders found</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 px-3">Order #</th>
                <th className="py-2 px-3">Patient</th>
                <th className="py-2 px-3">Phone</th>
                <th className="py-2 px-3">Type</th>
                <th className="py-2 px-3">Total</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">ETA</th>
                <th className="py-2 px-3">Time</th>
                <th className="py-2 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className={`border-b border-border hover:bg-muted/50 ${
                    o.sla_breached ? "bg-red-50" : ""
                  }`}
                >
                  <td className="py-2 px-3 font-medium">
                    <button onClick={() => setSelectedOrder(o)} className="text-primary hover:underline">
                      {o.order_number || `#${o.id}`}
                    </button>
                  </td>
                  <td className="py-2 px-3">{o.patient_name || <span className="text-muted-foreground">—</span>}</td>
                  <td className="py-2 px-3">{o.phone || <span className="text-muted-foreground">—</span>}</td>
                  <td className="py-2 px-3 capitalize">{o.delivery_type}</td>
                  <td className="py-2 px-3">{o.total_cost ? `₹${o.total_cost}` : "—"}</td>
                  <td className="py-2 px-3">
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {o.status === "DISPATCHED" && o.estimated_delivery_mins ? (
                      <span className="flex items-center gap-1">
                        {o.delivery_tracking_active && <span title="Live tracking">📍</span>}
                        ~{o.estimated_delivery_mins}m
                        {o.delivery_distance_km ? <span className="text-muted-foreground ml-1">({o.delivery_distance_km}km)</span> : null}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="py-2 px-3 text-muted-foreground">
                    {formatRelativeMins(o.mins_since_placed)}
                    {o.sla_breached && (
                      <span className="ml-1 text-red-600 text-xs">⚠ SLA</span>
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
                      {(o.status === "PREPARING" || o.status === "CONFIRMED") && (
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
                              doAction(o.id, "cancel", { cancellation_reason: reason });
                            }
                          }}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedOrder && (
        <OrderDetailModal order={selectedOrder} onClose={() => setSelectedOrder(null)} />
      )}
    </div>
  );
}
