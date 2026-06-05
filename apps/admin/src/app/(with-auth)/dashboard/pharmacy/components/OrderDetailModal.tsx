"use client";

import Image from "next/image";
import type { PharmacyOrderLifecycle } from "./types";
import { StatusBadge } from "./shared";

export function OrderDetailModal({
  order,
  onClose,
}: {
  order: PharmacyOrderLifecycle;
  onClose: () => void;
}) {
  const items = Array.isArray(order.items_list) ? order.items_list : [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-bold">{order.order_number}</h3>
            <p className="text-sm text-gray-500">
              {new Date(order.created_at).toLocaleString()}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
          >
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
              <span className="text-sm text-gray-500">Address:</span>{" "}
              {order.delivery_address}
            </div>
          )}
          {order.order_note && (
            <div>
              <span className="text-sm text-gray-500">Note:</span>{" "}
              {order.order_note}
            </div>
          )}
        </div>

        {order.prescription_photo_url && (
          <div className="mt-4">
            <p className="text-sm text-gray-500 mb-2">Prescription:</p>
            <div className="relative w-full h-48">
              <Image
                src={order.prescription_photo_url}
                alt="Prescription"
                fill
                sizes="(max-width: 768px) 100vw, 50vw"
                className="rounded-lg border object-cover"
                unoptimized
              />
            </div>
          </div>
        )}

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
          <div className="mt-3 text-right font-bold">
            Total: ₹{order.total_cost}
          </div>
        )}

        {order.delivery_person && (
          <div className="mt-3 p-3 bg-teal-50 rounded-lg">
            <p className="text-sm text-teal-700">
              🚗 {order.delivery_person}
              {order.delivery_person_phone &&
                ` • ${order.delivery_person_phone}`}
            </p>
            {order.status === "DISPATCHED" && order.estimated_delivery_mins && (
              <p className="text-sm text-teal-600 mt-1">
                {order.delivery_tracking_active && "📍 Live • "}
                ETA: ~{order.estimated_delivery_mins} min
                {order.delivery_distance_km
                  ? ` • ${order.delivery_distance_km} km away`
                  : ""}
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
