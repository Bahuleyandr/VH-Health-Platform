// src/app/dashboard/layout.tsx

import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from 'next/headers';

// Server Action to handle logout
async function logout() {
  'use server';
  cookies().delete('auth_token');
  redirect('/login');
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-64 bg-gray-800 text-white p-4">
        <h1 className="text-2xl font-bold mb-6">VH Health Admin</h1>
        <nav className="flex flex-col space-y-2">
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/dashboard/users">User Management</Link>
          <Link href="/dashboard/appointments">Appointments</Link>
          <Link href="/dashboard/pharmacy">Pharmacy</Link> 
          <Link href="/dashboard/doctors">Doctor Management</Link>
          <Link href="/dashboard/departments">Departments</Link>
          <Link href="/dashboard/notifications">Notifications</Link>
          <Link href="/dashboard/settings">Settings</Link>
          <Link href="/dashboard/admin-management">Admin Management</Link>
          <Link href="/dashboard/system-logs">System Logs</Link> 
          <Link href="/dashboard/reporting">Reporting</Link>
        </nav>
        <form action={logout} className="mt-auto pt-4">
          <button type="submit" className="w-full text-left">Logout</button>
        </form>
      </aside>
      <main className="flex-1 p-6 bg-gray-100">
        <header className="mb-6">
          {/* You can add header content here, like user profile */}
        </header>
        {children}
      </main>
    </div>
  );
}