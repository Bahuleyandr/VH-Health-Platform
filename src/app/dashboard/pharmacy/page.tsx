// src/app/dashboard/pharmacy/page.tsx

import { getPharmacyAnalytics, getPharmacyOrders } from "@/lib/api";
import { PharmacyAnalytics, PharmacyOrder } from "@/lib/types";
import { PharmacyStats } from "./components/PharmacyStats";
import { OrdersTable } from "./components/OrdersTable";
import { Suspense } from "react";

export default async function PharmacyPage({ searchParams }: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const queryParams = new URLSearchParams();
  if (searchParams.page) queryParams.set('page', searchParams.page as string);

  // Fetch both analytics and orders data in parallel
  const [analyticsData, ordersData] = await Promise.all([
    getPharmacyAnalytics(),
    getPharmacyOrders(queryParams)
  ]);

  const analytics: PharmacyAnalytics = analyticsData.analytics;
  const orders: PharmacyOrder[] = ordersData.orders;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Pharmacy Management</h2>
      
      <Suspense fallback={<div>Loading analytics...</div>}>
        <PharmacyStats analytics={analytics} />
      </Suspense>

      <h3 className="text-xl font-semibold mt-8 mb-4">All Orders</h3>
      <Suspense fallback={<div>Loading orders...</div>}>
        <OrdersTable orders={orders} />
      </Suspense>
      
      {/* TODO: Add pagination controls if the API supports it */}
    </div>
  );
}