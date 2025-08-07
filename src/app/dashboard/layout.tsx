'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { getAuthToken } from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';
import { CommandPalette } from '@/components/CommandPalette';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AuthDebugger } from '@/components/auth/AuthDebugger';
import toast from 'react-hot-toast';

const navigation = [
  { name: 'Dashboard', href: '/dashboard' },
  { name: 'Users', href: '/dashboard/users' },
  { name: 'Doctors', href: '/dashboard/doctors' },
  { name: 'Departments', href: '/dashboard/departments' },
  { name: 'Appointments', href: '/dashboard/appointments' },
  { name: 'Pharmacy', href: '/dashboard/pharmacy' },
  { name: 'Reporting', href: '/dashboard/reporting' },
  { name: 'Notifications', href: '/dashboard/notifications' },
  { name: 'Admin Management', href: '/dashboard/admin-management' },
  { name: 'System Logs', href: '/dashboard/system-logs' },
  { name: 'Settings', href: '/dashboard/settings' },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  useEffect(() => {
    const checkAuth = () => {
      const token = getAuthToken();
      
      if (!token) {
        toast.error('Please login to continue');
        router.push('/login');
        return;
      }
      
      setIsAuthenticated(true);
      setIsLoading(false);
    };

    checkAuth();
  }, [router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <ProtectedRoute requiredRole="ADMIN">
      <div className="min-h-screen bg-gray-100">
        {/* Mobile sidebar backdrop */}
        {isSidebarOpen && (
          <div
            className="fixed inset-0 bg-gray-600 bg-opacity-75 z-20 lg:hidden"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <div className={`fixed inset-y-0 left-0 z-30 w-64 bg-gray-900 transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}>
          <div className="flex items-center justify-center h-16 bg-gray-800">
            <h1 className="text-white text-xl font-bold">VH Admin Portal</h1>
          </div>
          <nav className="mt-5">
            {navigation.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`block px-6 py-3 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-gray-800 text-white border-l-4 border-blue-500'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  {item.name}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Main content */}
        <div className="lg:pl-64">
          {/* Top bar */}
          <div className="sticky top-0 z-10 bg-white shadow">
            <div className="px-4 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between h-16">
                <button
                  className="lg:hidden"
                  onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                >
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
                
                <Breadcrumbs />
                
                <div className="flex items-center space-x-4">
                  <CommandPalette />
                  <ThemeToggle />
                  <button
                    onClick={() => {
                      localStorage.removeItem('adminToken');
                      router.push('/login');
                    }}
                    className="text-sm text-gray-700 hover:text-gray-900"
                  >
                    Logout
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Page content */}
          <main className="flex-1">
            {children}
          </main>
        </div>
        
        <AuthDebugger />
      </div>
    </ProtectedRoute>
  );
}