// src/app/(with-auth)/dashboard/pharmacy/components/PharmacyStats.tsx
import { PharmacyAnalytics } from "@/lib/types";
import { DollarSign, ClipboardList, Clock, BarChart2 } from "lucide-react";

function StatCard({
  title,
  value,
  icon,
  bgColor = "bg-white",
}: {
  title: string;
  value: string | number;
  icon?: React.ReactNode;
  bgColor?: string;
}) {
  return (
    <div
      className={`${bgColor} p-6 rounded-lg shadow-sm border border-border`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="text-2xl font-bold text-foreground mt-2">{value}</p>
        </div>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </div>
    </div>
  );
}

export function PharmacyStats({ analytics }: { analytics: PharmacyAnalytics }) {
  // Calculate average order value - removed unused completedOrders
  const averageOrderValue =
    analytics.total_orders > 0
      ? (analytics.total_revenue / analytics.total_orders).toFixed(2)
      : "0";

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <StatCard
        title="Total Revenue"
        value={`₹${analytics.total_revenue.toLocaleString("en-IN")}`}
        bgColor="bg-success/10"
        icon={<DollarSign className="w-8 h-8" />}
      />

      <StatCard
        title="Total Orders"
        value={analytics.total_orders}
        icon={<ClipboardList className="w-8 h-8" />}
      />

      <StatCard
        title="Pending Orders"
        value={analytics.pending_orders}
        bgColor="bg-warning/10"
        icon={<Clock className="w-8 h-8" />}
      />

      <StatCard
        title="Avg Order Value"
        value={`₹${parseFloat(averageOrderValue).toLocaleString("en-IN")}`}
        icon={<BarChart2 className="w-8 h-8" />}
      />
    </div>
  );
}
