// src/app/dashboard/pharmacy/components/PharmacyStats.tsx
import { PharmacyAnalytics } from "@/lib/types";

function StatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <h3 className="text-gray-500 text-sm font-medium">{title}</h3>
      <p className="text-3xl font-bold">{value}</p>
    </div>
  );
}

export function PharmacyStats({ analytics }: { analytics: PharmacyAnalytics }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <StatCard title="Total Revenue (₹)" value={analytics.total_revenue.toLocaleString('en-IN')} />
      <StatCard title="Total Orders" value={analytics.total_orders} />
      <StatCard title="Pending Orders" value={analytics.pending_orders} />
    </div>
  );
}