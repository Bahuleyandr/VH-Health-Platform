// src/app/dashboard/page.tsx

import { fetchAdminAPI } from "@/lib/api";

// A simple component to display a stat card
function StatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <h3 className="text-gray-500 text-sm font-medium">{title}</h3>
      <p className="text-3xl font-bold">{value}</p>
    </div>
  );
}

export default async function DashboardPage() {
  try {
    const data = await fetchAdminAPI('/admin/dashboard');
    const { users, appointments, departments: _departments, revenue_30d } = data.dashboard;

    return (
      <div>
        <h2 className="text-2xl font-bold mb-4">Dashboard Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard title="Total Users" value={users.total_users} />
          <StatCard title="Total Doctors" value={users.doctors} />
          <StatCard title="Scheduled Appointments" value={appointments.scheduled} />
          <StatCard title="30-Day Revenue (₹)" value={parseInt(revenue_30d.consultation_revenue, 10).toLocaleString('en-IN')} />
        </div>
        {/* You can add more components here to display other dashboard data */}
      </div>
    );
  } catch (error) {
    let errorMessage = "An unknown error occurred.";
    if (error instanceof Error) {
        errorMessage = error.message;
    }
    return (
        <div className="text-red-500">
            <h2 className="text-xl font-bold">Failed to load dashboard data</h2>
            <p>{errorMessage}</p>
        </div>
    );
  }
}