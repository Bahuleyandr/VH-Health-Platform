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
        return "bg-yellow-100 text-yellow-800";
      case "COMPLETED":
        return "bg-green-100 text-green-800";
      case "CANCELLED":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
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
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Order ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Patient
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Doctor
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    #{order.id}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(order.order_date).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">
                      {order.patient_name}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">
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
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
                    ₹{order.total_amount.toLocaleString("en-IN")}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleViewOrder(order.id)}
                        className="text-blue-600 hover:text-blue-900 transition-colors"
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
                          className={`text-sm border border-gray-300 rounded px-2 py-1 ${
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
