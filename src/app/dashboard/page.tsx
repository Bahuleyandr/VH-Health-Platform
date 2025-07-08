// /src/app/dashboard/page.tsx
'use client';

import { useDashboardData } from '@/hooks/use-dashboard';
import Link from "next/link";
import {
  Activity,
  Users,
  Calendar,
  Stethoscope,
  AlertCircle,
  Loader2,
  RefreshCw
} from 'lucide-react';

export default function DashboardPage() {
  const { data, isLoading, error, refetch, isRefetching } = useDashboardData();

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <span className="ml-2">Loading dashboard...</span>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 m-6">
        <div className="flex items-center">
          <AlertCircle className="h-6 w-6 text-red-600 mr-2" />
          <h3 className="text-red-800 font-semibold">Failed to load dashboard</h3>
        </div>
        <p className="text-red-600 mt-2">{error instanceof Error ? error.message : 'Unknown error'}</p>
        <button
          onClick={() => refetch()}
          className="mt-4 bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700"
        >
          Try Again
        </button>
      </div>
    );
  }

  // Success state - your existing dashboard layout
  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <button
          onClick={() => refetch()}
          disabled={isRefetching}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Users</p>
              <p className="text-2xl font-bold">{data?.totalUsers || 0}</p>
            </div>
            <Users className="h-12 w-12 text-blue-500" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Users</p>
              <p className="text-2xl font-bold">{data?.activeUsers || 0}</p>
            </div>
            <Activity className="h-12 w-12 text-green-500" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Doctors</p>
              <p className="text-2xl font-bold">{data?.totalDoctors || 0}</p>
            </div>
            <Stethoscope className="h-12 w-12 text-purple-500" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Appointments</p>
              <p className="text-2xl font-bold">{data?.totalAppointments || 0}</p>
            </div>
            <Calendar className="h-12 w-12 text-orange-500" />
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-6 border-b">
          <h2 className="text-xl font-semibold">Recent Activity</h2>
        </div>
        <div className="p-6">
          {data?.recentActivity && data.recentActivity.length > 0 ? (
            <div className="space-y-4">
              {data.recentActivity.map((activity) => (
                <div key={activity.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div>
                    <p className="font-medium">{activity.action}</p>
                    <p className="text-sm text-gray-600">by {activity.user}</p>
                  </div>
                  <p className="text-sm text-gray-500">
                    {new Date(activity.timestamp).toLocaleString('en-GB')}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No recent activity</p>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/dashboard/appointments" className="bg-blue-50 p-4 rounded-lg hover:bg-blue-100 transition">
          <h3 className="font-semibold text-blue-900">View Appointments</h3>
          <p className="text-sm text-blue-700">Manage today's appointments</p>
        </Link>
        
        <Link href="/dashboard/users" className="bg-green-50 p-4 rounded-lg hover:bg-green-100 transition">
          <h3 className="font-semibold text-green-900">User Management</h3>
          <p className="text-sm text-green-700">Add or manage users</p>
        </Link>
        
        <Link href="/dashboard/doctors" className="bg-purple-50 p-4 rounded-lg hover:bg-purple-100 transition">
          <h3 className="font-semibold text-purple-900">Doctor Management</h3>
          <p className="text-sm text-purple-700">Manage doctor profiles</p>
        </Link>
      </div>

      {/* Auto-refresh indicator */}
      <div className="mt-4 text-center text-sm text-gray-500">
        Auto-refreshing every 30 seconds
        {isRefetching && <span className="ml-2">(Updating...)</span>}
      </div>
    </div>
  );
}