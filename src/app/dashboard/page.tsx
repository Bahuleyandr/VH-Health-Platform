// src/app/dashboard/page.tsx
'use client';

import { useDashboardData } from '@/hooks/hooks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function DashboardPage() {
  const { data, isLoading, error } = useDashboardData();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error loading dashboard data
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Dashboard</h1>
      
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Total Patients</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{data.totalPatients}</p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>Total Appointments</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{data.totalAppointments}</p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>Active Departments</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{data.activeDepartments}</p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>Total Staff</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{data.totalStaff}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}