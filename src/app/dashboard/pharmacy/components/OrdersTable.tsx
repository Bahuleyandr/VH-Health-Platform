// src/app/dashboard/pharmacy/components/OrdersTable.tsx
import { PharmacyOrder } from "@/lib/types";

export function OrdersTable({ orders }: { orders: PharmacyOrder[] }) {
  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order Details</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Patient & Doctor</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {orders.map((order) => (
            <tr key={order.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                <div>Order #{order.id}</div>
                <div className="text-xs text-gray-500">{new Date(order.order_date).toLocaleDateString('en-GB')}</div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm">
                <div>{order.patient_name}</div>
                <div className="text-xs text-gray-500">Prescribed by Dr. {order.doctor_name}</div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">{order.status}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold">₹{order.total_amount.toLocaleString('en-IN')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}