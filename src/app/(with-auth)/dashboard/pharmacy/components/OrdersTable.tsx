// src/app/(with-auth)/dashboard/pharmacy/components/OrdersTable.tsx
"use client";

import type { PharmacyOrder } from "@/lib/types";
import { useState, useEffect } from "react";
import { fetchAdminAPI } from "@/lib/api";
import toast from "react-hot-toast";
import { OrderDetailsModal } from "./OrderDetailsModal";

type OrderStatus = PharmacyOrder["status"]; // "COMPLETED" | "CANCELLED" | "PENDING"

export function OrdersTable({
  orders: initialOrders,
  onOrderUpdated,
}: {
  orders: PharmacyOrder[];
  onOrderUpdated?: () => void;
}) {
  const [orders, setOrders] = useState<PharmacyOrder[]>(initialOrders);
  const [updatingOrderId, setUpdatingOrderId] = useState<number | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    setOrders(initialOrders);
  }, [initialOrders]);

  const getStatusColor = (status: OrderStatus) => {
    switch (status) {
      case "PENDING":
        return "bg-warning/10 text-warning";
      case "COMPLETED":
        return "bg-success/10 text-success";
      case "CANCELLED":
        return "bg-destructive/10 text-destructive";
      default:
        return "bg-muted text-foreground";
    }
  };

  const handleStatusUpdate = async (
    orderId: number,
    newStatus: OrderStatus,
  ) => {
    setUpdatingOrderId(orderId);
    try {
      await fetchAdminAPI(`/pharmacy/orders/${orderId}`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus }),
      });

      // Update local state with the correctly typed status
      setOrders((prev) =>
        prev.map((order) =>
          order.id === orderId ? { ...order, status: newStatus } : order,
        ),
      );

      onOrderUpdated?.();
    } catch {
      toast.error("Failed to update order status. Please try again.");
    } finally {
      setUpdatingOrderId(null);
    }
  };

  const handleViewOrder = (orderId: number) => {
    setSelectedOrderId(orderId);
    setIsModalOpen(true);
  };

  return (
    <>
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Order ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Patient
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Doctor
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-border">
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-muted">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-foreground">
                    #{order.id}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                    {new Date(order.order_date).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-foreground">
                      {order.patient_name}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-foreground">
                      Dr. {order.doctor_name}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(
                        order.status,
                      )}`}
                    >
                      {order.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-foreground">
                    ₹{order.total_amount.toLocaleString("en-IN")}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleViewOrder(order.id)}
                        className="text-primary hover:text-primary transition-colors"
                        title="View Details"
                      >
                        View
                      </button>

                      {order.status === "PENDING" && (
                        <select
                          value={order.status}
                          onChange={(e) =>
                            handleStatusUpdate(
                              order.id,
                              e.target.value as OrderStatus,
                            )
                          }
                          disabled={updatingOrderId === order.id}
                          className={`text-sm border border-input rounded px-2 py-1 ${
                            updatingOrderId === order.id
                              ? "opacity-50 cursor-not-allowed"
                              : ""
                          }`}
                        >
                          <option value="PENDING">Pending</option>
                          <option value="COMPLETED">Completed</option>
                          <option value="CANCELLED">Cancelled</option>
                        </select>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Order Details Modal */}
      {selectedOrderId && (
        <OrderDetailsModal
          orderId={selectedOrderId}
          isOpen={isModalOpen}
          onClose={() => {
            setIsModalOpen(false);
            setSelectedOrderId(null);
          }}
        />
      )}
    </>
  );
}
