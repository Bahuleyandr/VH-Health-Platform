// src/app/(with-auth)/dashboard/pharmacy/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON } from "@/lib/api";
// import { useSearchParams, useRouter } from "next/navigation";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface PharmacyOrderLifecycle {
  id: number;
  order_number: string;
  patient_id: number;
  patient_name: string;
  phone: string;
  order_note: string | null;
  prescription_photo_key: string | null;
  prescription_photo_url: string | null;
  delivery_type: "delivery" | "pickup";
  delivery_address: string | null;
  delivery_phone: string | null;
  status: string;
  total_cost: number | null;
  items_list: Array<{ name: string; qty: number; price: number }> | null;
  confirmed_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  delivery_person: string | null;
  delivery_person_phone: string | null;
  sla_breached: boolean;
  mins_since_placed: number;
  created_at: string;
  estimated_delivery_mins: number | null;
  delivery_distance_km: number | null;
  delivery_tracking_active: boolean;
}

interface SLAData {
  summary: {
    total: string;
    placed: string;
    confirmed: string;
    preparing: string;
    dispatched: string;
    delivered: string;
    cancelled: string;
    total_revenue: string;
  };
  avg_times: {
    avg_confirm_mins: string | null;
    avg_dispatch_mins: string | null;
    avg_delivery_mins: string | null;
  };
  sla_breaches: number;
  date_range: { from: string; to: string };
}

interface CatalogItem {
  id: number;
  name: string;
  generic_name: string | null;
  category: string;
  manufacturer: string | null;
  unit_price: number | null;
  pack_size: string | null;
  requires_prescription: boolean;
  in_stock: boolean;
  stock_quantity: number;
  reorder_level: number;
  is_active: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB COMPONENTS
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

const STATUS_COLORS: Record<string, string> = {
  PLACED: "bg-orange-100 text-orange-700",
  CONFIRMED: "bg-blue-100 text-blue-700",
  PREPARING: "bg-amber-100 text-amber-700",
  DISPATCHED: "bg-teal-100 text-teal-700",
  DELIVERED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

// ── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab() {
  const [sla, setSla] = useState<SLAData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAdminAPI<{ data: SLAData }>("/pharmacy-orders/orders/sla")
      .then((r) => {
        const data = (r as Record<string, unknown>).data ?? r;
        setSla(data as SLAData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-center">Loading SLA data...</div>;
  if (!sla) return <div className="p-8 text-center text-muted-foreground">No data</div>;

  const s = sla.summary;
  const avg = sla.avg_times;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard label="Total" value={s.total} />
        <StatCard label="Placed" value={s.placed} color="text-orange-600" />
        <StatCard label="Confirmed" value={s.confirmed} color="text-blue-600" />
        <StatCard label="Preparing" value={s.preparing} color="text-amber-600" />
        <StatCard label="Dispatched" value={s.dispatched} color="text-teal-600" />
        <StatCard label="Delivered" value={s.delivered} color="text-green-600" />
        <StatCard label="Cancelled" value={s.cancelled} color="text-red-600" />
        <StatCard
          label="Revenue"
          value={`₹${Number(s.total_revenue || 0).toLocaleString()}`}
          color="text-green-700"
          bg="bg-green-50"
        />
      </div>

      {/* Average Times */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Avg. Confirm Time</p>
          <p className="text-xl font-semibold">
            {avg.avg_confirm_mins ? `${Number(avg.avg_confirm_mins).toFixed(1)} min` : "—"}
          </p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Avg. Dispatch Time</p>
          <p className="text-xl font-semibold">
            {avg.avg_dispatch_mins ? `${Number(avg.avg_dispatch_mins).toFixed(1)} min` : "—"}
          </p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Avg. Delivery Time</p>
          <p className="text-xl font-semibold">
            {avg.avg_delivery_mins ? `${Number(avg.avg_delivery_mins).toFixed(1)} min` : "—"}
          </p>
        </div>
      </div>

      {/* SLA Breaches */}
      {sla.sla_breaches > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700 font-semibold">
            ⚠ {sla.sla_breaches} SLA breach{sla.sla_breaches !== 1 ? "es" : ""} (orders not
            confirmed within 15 min)
          </p>
        </div>
      )}
    </div>
  );
}

// ── Orders Tab ──────────────────────────────────────────────────────────────

function OrdersTab() {
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

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex gap-2 flex-wrap">
        {["", "PLACED", "CONFIRMED", "PREPARING", "DISPATCHED", "DELIVERED", "CANCELLED"].map(
          (s) => (
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
          ),
        )}
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
                      {o.order_number}
                    </button>
                  </td>
                  <td className="py-2 px-3">{o.patient_name}</td>
                  <td className="py-2 px-3">{o.phone}</td>
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
                    {Math.round(o.mins_since_placed)}m
                    {o.sla_breached && (
                      <span className="ml-1 text-red-600 text-xs">⚠ SLA</span>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex gap-1 flex-wrap">
                      {o.status === "PLACED" && (
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

      {/* Order detail modal */}
      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  );
}

function ActionButton({
  label,
  color,
  onClick,
  loading,
}: {
  label: string;
  color: string;
  onClick: () => void;
  loading: boolean;
}) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-100 text-blue-700 hover:bg-blue-200",
    amber: "bg-amber-100 text-amber-700 hover:bg-amber-200",
    teal: "bg-teal-100 text-teal-700 hover:bg-teal-200",
    green: "bg-green-100 text-green-700 hover:bg-green-200",
    red: "bg-red-100 text-red-700 hover:bg-red-200",
  };

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`px-2 py-1 rounded text-xs font-medium ${colorMap[color] || "bg-gray-100"} ${
        loading ? "opacity-50 cursor-wait" : ""
      }`}
    >
      {loading ? "..." : label}
    </button>
  );
}

function OrderDetailModal({
  order,
  onClose,
}: {
  order: PharmacyOrderLifecycle;
  onClose: () => void;
}) {
  const items = Array.isArray(order.items_list) ? order.items_list : [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-bold">{order.order_number}</h3>
            <p className="text-sm text-gray-500">
              {new Date(order.created_at).toLocaleString()}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">
            ✕
          </button>
        </div>

        <StatusBadge status={order.status} />

        <div className="mt-4 space-y-3">
          <div>
            <span className="text-sm text-gray-500">Patient:</span>{" "}
            <span className="font-medium">{order.patient_name}</span>
          </div>
          <div>
            <span className="text-sm text-gray-500">Phone:</span> {order.phone}
          </div>
          <div>
            <span className="text-sm text-gray-500">Delivery:</span>{" "}
            <span className="capitalize">{order.delivery_type}</span>
          </div>
          {order.delivery_address && (
            <div>
              <span className="text-sm text-gray-500">Address:</span> {order.delivery_address}
            </div>
          )}
          {order.order_note && (
            <div>
              <span className="text-sm text-gray-500">Note:</span> {order.order_note}
            </div>
          )}
        </div>

        {/* Prescription photo */}
        {order.prescription_photo_url && (
          <div className="mt-4">
            <p className="text-sm text-gray-500 mb-2">Prescription:</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={order.prescription_photo_url}
              alt="Prescription"
              className="w-full max-h-48 object-cover rounded-lg border"
            />
          </div>
        )}

        {/* Items */}
        {items.length > 0 && (
          <div className="mt-4">
            <p className="text-sm text-gray-500 mb-2">Items:</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-1">Item</th>
                  <th className="text-right py-1">Qty</th>
                  <th className="text-right py-1">Price</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={i} className="border-b">
                    <td className="py-1">{item.name}</td>
                    <td className="text-right py-1">{item.qty}</td>
                    <td className="text-right py-1">₹{item.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {order.total_cost && (
          <div className="mt-3 text-right font-bold">Total: ₹{order.total_cost}</div>
        )}

        {/* Delivery person + tracking */}
        {order.delivery_person && (
          <div className="mt-3 p-3 bg-teal-50 rounded-lg">
            <p className="text-sm text-teal-700">
              🚗 {order.delivery_person}
              {order.delivery_person_phone && ` • ${order.delivery_person_phone}`}
            </p>
            {order.status === "DISPATCHED" && order.estimated_delivery_mins && (
              <p className="text-sm text-teal-600 mt-1">
                {order.delivery_tracking_active && "📍 Live • "}
                ETA: ~{order.estimated_delivery_mins} min
                {order.delivery_distance_km ? ` • ${order.delivery_distance_km} km away` : ""}
              </p>
            )}
          </div>
        )}

        {order.cancellation_reason && (
          <div className="mt-3 p-3 bg-red-50 rounded-lg">
            <p className="text-sm text-red-700">
              Cancelled: {order.cancellation_reason}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Catalog Tab ─────────────────────────────────────────────────────────────

function CatalogTab() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<CatalogItem | null>(null);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchAdminAPI<{ data: CatalogItem[] }>("/pharmacy-orders/catalog");
      const data = (r as Record<string, unknown>).data ?? r;
      setCatalog(Array.isArray(data) ? data : []);
    } catch {
      /* empty */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  const handleSave = async (item: Record<string, unknown>) => {
    try {
      await postJSON("/api/v1/pharmacy-orders/catalog", item);
      setShowForm(false);
      setEditItem(null);
      fetchCatalog();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Save failed");
    }
  };

  // Group by category
  const grouped = catalog.reduce(
    (acc, item) => {
      const cat = item.category || "other";
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(item);
      return acc;
    },
    {} as Record<string, CatalogItem[]>,
  );

  if (loading) return <div className="text-center py-8">Loading catalog...</div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Medicine Catalog ({catalog.length})</h3>
        <button
          onClick={() => {
            setEditItem(null);
            setShowForm(true);
          }}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90"
        >
          + Add Medicine
        </button>
      </div>

      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} className="border border-border rounded-lg overflow-hidden">
          <div className="bg-muted px-4 py-2 font-medium capitalize">{category}</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Name</th>
                <th className="py-2 px-3">Generic Name</th>
                <th className="py-2 px-3">Price</th>
                <th className="py-2 px-3">Pack Size</th>
                <th className="py-2 px-3">Rx</th>
                <th className="py-2 px-3">Stock</th>
                <th className="py-2 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-border hover:bg-muted/30">
                  <td className="py-2 px-3 font-medium">{item.name}</td>
                  <td className="py-2 px-3 text-muted-foreground">{item.generic_name || "—"}</td>
                  <td className="py-2 px-3">{item.unit_price ? `₹${item.unit_price}` : "—"}</td>
                  <td className="py-2 px-3">{item.pack_size || "—"}</td>
                  <td className="py-2 px-3">
                    {item.requires_prescription ? (
                      <span className="text-red-600 text-xs font-medium">Rx</span>
                    ) : (
                      <span className="text-green-600 text-xs">OTC</span>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={
                        item.stock_quantity <= item.reorder_level
                          ? "text-red-600 font-medium"
                          : ""
                      }
                    >
                      {item.stock_quantity}
                    </span>
                    {item.stock_quantity <= item.reorder_level && (
                      <span className="text-red-500 text-xs ml-1">⚠ Low</span>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() => {
                        setEditItem(item);
                        setShowForm(true);
                      }}
                      className="text-primary text-xs hover:underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* Add/Edit Modal */}
      {showForm && (
        <CatalogForm
          item={editItem}
          onSave={handleSave}
          onCancel={() => {
            setShowForm(false);
            setEditItem(null);
          }}
        />
      )}
    </div>
  );
}

function CatalogForm({
  item,
  onSave,
  onCancel,
}: {
  item: CatalogItem | null;
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    id: item?.id || undefined,
    name: item?.name || "",
    generic_name: item?.generic_name || "",
    category: item?.category || "other",
    manufacturer: item?.manufacturer || "",
    unit_price: item?.unit_price?.toString() || "",
    pack_size: item?.pack_size || "",
    requires_prescription: item?.requires_prescription ?? true,
    in_stock: item?.in_stock ?? true,
    stock_quantity: item?.stock_quantity?.toString() || "0",
    reorder_level: item?.reorder_level?.toString() || "10",
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6 max-h-[80vh] overflow-y-auto">
        <h3 className="text-lg font-bold mb-4">{item ? "Edit Medicine" : "Add Medicine"}</h3>

        <div className="space-y-3">
          <input
            placeholder="Medicine Name *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
          <input
            placeholder="Generic Name"
            value={form.generic_name}
            onChange={(e) => setForm({ ...form, generic_name: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          >
            {[
              "analgesics",
              "antibiotics",
              "antacids",
              "vitamins",
              "cardiac",
              "diabetes",
              "hormones",
              "antihistamines",
              "respiratory",
              "general",
              "other",
            ].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            placeholder="Manufacturer"
            value={form.manufacturer}
            onChange={(e) => setForm({ ...form, manufacturer: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Unit Price"
              type="number"
              value={form.unit_price}
              onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Pack Size"
              value={form.pack_size}
              onChange={(e) => setForm({ ...form, pack_size: e.target.value })}
              className="border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Stock Qty"
              type="number"
              value={form.stock_quantity}
              onChange={(e) => setForm({ ...form, stock_quantity: e.target.value })}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Reorder Level"
              type="number"
              value={form.reorder_level}
              onChange={(e) => setForm({ ...form, reorder_level: e.target.value })}
              className="border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.requires_prescription}
                onChange={(e) =>
                  setForm({ ...form, requires_prescription: e.target.checked })
                }
              />
              Prescription Required
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.in_stock}
                onChange={(e) => setForm({ ...form, in_stock: e.target.checked })}
              />
              In Stock
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 border rounded-lg text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              onSave({
                ...form,
                unit_price: form.unit_price ? Number(form.unit_price) : null,
                stock_quantity: Number(form.stock_quantity) || 0,
                reorder_level: Number(form.reorder_level) || 10,
              })
            }
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90"
          >
            {item ? "Update" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function PharmacyContent() {
  const [tab, setTab] = useState<"overview" | "orders" | "catalog">("overview");

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-6">Pharmacy Management</h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[
          { key: "overview" as const, label: "📊 Overview" },
          { key: "orders" as const, label: "📦 Orders" },
          { key: "catalog" as const, label: "💊 Catalog" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === key ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "orders" && <OrdersTab />}
      {tab === "catalog" && <CatalogTab />}
    </div>
  );
}

export default function PharmacyPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading pharmacy...</div>}>
      <PharmacyContent />
    </Suspense>
  );
}
