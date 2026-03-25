// src/app/(with-auth)/dashboard/pharmacy/components/OrderDetailsModal.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { CloseIcon } from "@/components/icons";

// Define proper types for order details
interface OrderItem {
  medicine_name: string;
  quantity: number;
  price: number;
  total: number;
}

type OrderStatus = "pending" | "processing" | "completed" | "cancelled";

interface OrderDetails {
  order_date: string;
  status: OrderStatus;
  total_amount: number;
  patient_name: string;
  patient_email?: string;
  patient_phone?: string;
  doctor_name: string;
  doctor_department?: string;
  items: OrderItem[];
}

interface OrderDetailsModalProps {
  orderId: number;
  isOpen: boolean;
  onClose: () => void;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isOrderItem(x: unknown): x is OrderItem {
  if (!isObj(x)) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.medicine_name === "string" &&
    typeof o.quantity === "number" &&
    typeof o.price === "number" &&
    typeof o.total === "number"
  );
}

function isOrderDetails(x: unknown): x is OrderDetails {
  if (!isObj(x)) return false;
  const o = x as Record<string, unknown>;
  const status = o.status;
  return (
    typeof o.order_date === "string" &&
    (status === "pending" ||
      status === "processing" ||
      status === "completed" ||
      status === "cancelled") &&
    typeof o.total_amount === "number" &&
    typeof o.patient_name === "string" &&
    typeof o.doctor_name === "string" &&
    Array.isArray(o.items) &&
    (o.items as unknown[]).every(isOrderItem)
  );
}

function normalizeOrder(resp: unknown): OrderDetails | null {
  if (isObj(resp)) {
    const r = resp as Record<string, unknown>;
    const maybeEnvelope = r.order as unknown;
    if (isOrderDetails(maybeEnvelope)) return maybeEnvelope;
    if (isOrderDetails(resp)) return resp as OrderDetails;
  }
  return null;
}

export function OrderDetailsModal({
  orderId,
  isOpen,
  onClose,
}: OrderDetailsModalProps) {
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOrderDetails = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Type as unknown and normalize
      const resp = await fetchAdminAPI<unknown>(`/pharmacy/orders/${orderId}`);
      const normalized = normalizeOrder(resp);

      if (!normalized) throw new Error("Malformed order response");
      setOrderDetails(normalized);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch order details",
      );
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    if (isOpen && orderId) {
      void fetchOrderDetails();
    }
  }, [isOpen, orderId, fetchOrderDetails]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-foreground bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-foreground">
            Order Details #{orderId}
          </h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-muted-foreground"
          >
            <CloseIcon className="w-6 h-6" />
          </button>
        </div>

        {loading && (
          <div className="flex justify-center items-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        )}

        {error && (
          <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {orderDetails && !loading && (
          <div className="space-y-4">
            {/* Order Information */}
            <div className="border-b pb-4">
              <h4 className="font-semibold text-foreground mb-2">
                Order Information
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Order Date:</span>
                  <span className="ml-2 font-medium">
                    {new Date(orderDetails.order_date).toLocaleDateString(
                      "en-GB",
                      {
                        day: "2-digit",
                        month: "long",
                        year: "numeric",
                      },
                    )}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>
                  <span
                    className={`ml-2 inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      orderDetails.status === "completed"
                        ? "bg-success/10 text-success"
                        : orderDetails.status === "pending"
                          ? "bg-warning/10 text-warning"
                          : orderDetails.status === "processing"
                            ? "bg-primary/10 text-primary"
                            : "bg-destructive/10 text-destructive"
                    }`}
                  >
                    {orderDetails.status}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Total Amount:</span>
                  <span className="ml-2 font-semibold">
                    ₹{orderDetails.total_amount?.toLocaleString("en-IN")}
                  </span>
                </div>
              </div>
            </div>

            {/* Patient Information */}
            <div className="border-b pb-4">
              <h4 className="font-semibold text-foreground mb-2">
                Patient Information
              </h4>
              <div className="text-sm">
                <p>
                  <span className="text-muted-foreground">Name:</span>{" "}
                  <span className="font-medium">
                    {orderDetails.patient_name}
                  </span>
                </p>
                {orderDetails.patient_email && (
                  <p>
                    <span className="text-muted-foreground">Email:</span>{" "}
                    <span className="font-medium">
                      {orderDetails.patient_email}
                    </span>
                  </p>
                )}
                {orderDetails.patient_phone && (
                  <p>
                    <span className="text-muted-foreground">Phone:</span>{" "}
                    <span className="font-medium">
                      {orderDetails.patient_phone}
                    </span>
                  </p>
                )}
              </div>
            </div>

            {/* Doctor Information */}
            <div className="border-b pb-4">
              <h4 className="font-semibold text-foreground mb-2">
                Prescribing Doctor
              </h4>
              <div className="text-sm">
                <p>
                  <span className="text-muted-foreground">Name:</span>{" "}
                  <span className="font-medium">
                    Dr. {orderDetails.doctor_name}
                  </span>
                </p>
                {orderDetails.doctor_department && (
                  <p>
                    <span className="text-muted-foreground">Department:</span>{" "}
                    <span className="font-medium">
                      {orderDetails.doctor_department}
                    </span>
                  </p>
                )}
              </div>
            </div>

            {/* Order Items */}
            {orderDetails.items && orderDetails.items.length > 0 && (
              <div>
                <h4 className="font-semibold text-foreground mb-2">
                  Order Items
                </h4>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-border">
                    <thead className="bg-muted">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">
                          Medicine
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">
                          Quantity
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">
                          Price
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-border">
                      {orderDetails.items.map(
                        (item: OrderItem, index: number) => (
                          <tr key={index}>
                            <td className="px-4 py-2 text-sm">
                              {item.medicine_name}
                            </td>
                            <td className="px-4 py-2 text-sm">
                              {item.quantity}
                            </td>
                            <td className="px-4 py-2 text-sm">₹{item.price}</td>
                            <td className="px-4 py-2 text-sm font-medium">
                              ₹{item.total}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-muted text-foreground rounded-md hover:bg-muted transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
