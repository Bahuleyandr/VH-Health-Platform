// src/app/dashboard/components/DashboardCharts.tsx
'use client';

import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell
} from 'recharts';

// Define the shape of the analytics data we expect
interface AnalyticsData {
  daily_registrations: Array<{ date: string; registrations: number }>;
  appointment_trends: Array<{ date:string; total_appointments: number; completed: number; cancelled: number }>;
  department_utilization: Array<{ department: string; appointment_count: number }>;
}

// Helper to format date to DD-MM
const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}-${month}`;
};

// 1. Registrations Line Chart
function RegistrationsChart({ data }: { data: AnalyticsData['daily_registrations'] }) {
  const chartData = data.map(d => ({ ...d, date: formatDate(d.date) })).reverse();
  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <h3 className="font-semibold mb-4">New User Registrations (Last 30 Days)</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="registrations" stroke="#8884d8" name="New Users" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// 2. Appointments Bar Chart
function AppointmentsChart({ data }: { data: AnalyticsData['appointment_trends'] }) {
    const chartData = data.map(d => ({ ...d, date: formatDate(d.date) })).reverse();
  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <h3 className="font-semibold mb-4">Appointment Trends (Last 30 Days)</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="completed" fill="#82ca9d" name="Completed" />
          <Bar dataKey="cancelled" fill="#ff6b6b" name="Cancelled" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// 3. Departments Pie Chart
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#ff6b6b'];
function DepartmentsChart({ data }: { data: AnalyticsData['department_utilization'] }) {
  return (
    <div className="bg-white p-4 rounded-lg shadow">
        <h3 className="font-semibold mb-4">Department Utilization</h3>
        <ResponsiveContainer width="100%" height={300}>
            <PieChart>
                <Pie
                    data={data}
                    dataKey="appointment_count"
                    nameKey="department"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    fill="#8884d8"
                    label
                >
                    {data.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                </Pie>
                <Tooltip />
                <Legend />
            </PieChart>
        </ResponsiveContainer>
    </div>
  );
}


// Main component that wraps all charts
export function DashboardCharts({ analytics }: { analytics: AnalyticsData }) {
  return (
    <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
      <RegistrationsChart data={analytics.daily_registrations} />
      <AppointmentsChart data={analytics.appointment_trends} />
      <div className="lg:col-span-2">
        <DepartmentsChart data={analytics.department_utilization} />
      </div>
    </div>
  );
}