// src/app/dashboard/pharmacy/components/OrderDetailsModal.tsx
'use client';

// Removed unused import: PharmacyOrder
import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";

// Define proper types for order details
interface OrderItem {
  medicine_name: string;
  quantity: number;
  price: number;
  total: number;
}

interface OrderDetails {
  order_date: string;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
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

export function OrderDetailsModal({ orderId, isOpen, onClose }: OrderDetailsModalProps) {
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOrderDetails = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetchAdminAPI(`/pharmacy/orders/${orderId}`);
      setOrderDetails(response.order || response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch order details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && orderId) {
      fetchOrderDetails();
    }
  }, [isOpen, orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-gray-900">Order Details #{orderId}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading && (
          <div className="flex justify-center items-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        )}

        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {orderDetails && !loading && (
          <div className="space-y-4">
            {/* Order Information */}
            <div className="border-b pb-4">
              <h4 className="font-semibold text-gray-700 mb-2">Order Information</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-gray-600">Order Date:</span>
                  <span className="ml-2 font-medium">
                    {new Date(orderDetails.order_date).toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'long',
                      year: 'numeric'
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Status:</span>
                  <span className={`ml-2 inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                    orderDetails.status === 'completed' ? 'bg-green-100 text-green-800' :
                    orderDetails.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                    orderDetails.status === 'processing' ? 'bg-blue-100 text-blue-800' :
                    'bg-red-100 text-red-800'
                  }`}>
                    {orderDetails.status}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Total Amount:</span>
                  <span className="ml-2 font-semibold">₹{orderDetails.total_amount?.toLocaleString('en-IN')}</span>
                </div>
              </div>
            </div>

            {/* Patient Information */}
            <div className="border-b pb-4">
              <h4 className="font-semibold text-gray-700 mb-2">Patient Information</h4>
              <div className="text-sm">
                <p><span className="text-gray-600">Name:</span> <span className="font-medium">{orderDetails.patient_name}</span></p>
                {orderDetails.patient_email && (
                  <p><span className="text-gray-600">Email:</span> <span className="font-medium">{orderDetails.patient_email}</span></p>
                )}
                {orderDetails.patient_phone && (
                  <p><span className="text-gray-600">Phone:</span> <span className="font-medium">{orderDetails.patient_phone}</span></p>
                )}
              </div>
            </div>

            {/* Doctor Information */}
            <div className="border-b pb-4">
              <h4 className="font-semibold text-gray-700 mb-2">Prescribing Doctor</h4>
              <div className="text-sm">
                <p><span className="text-gray-600">Name:</span> <span className="font-medium">Dr. {orderDetails.doctor_name}</span></p>
                {orderDetails.doctor_department && (
                  <p><span className="text-gray-600">Department:</span> <span className="font-medium">{orderDetails.doctor_department}</span></p>
                )}
              </div>
            </div>

            {/* Order Items */}
            {orderDetails.items && orderDetails.items.length > 0 && (
              <div>
                <h4 className="font-semibold text-gray-700 mb-2">Order Items</h4>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Medicine</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Quantity</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {orderDetails.items.map((item: OrderItem, index: number) => (
                        <tr key={index}>
                          <td className="px-4 py-2 text-sm">{item.medicine_name}</td>
                          <td className="px-4 py-2 text-sm">{item.quantity}</td>
                          <td className="px-4 py-2 text-sm">₹{item.price}</td>
                          <td className="px-4 py-2 text-sm font-medium">₹{item.total}</td>
                        </tr>
                      ))}
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
            className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}