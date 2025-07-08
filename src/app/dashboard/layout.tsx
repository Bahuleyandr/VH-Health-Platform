'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { getAuthToken } from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';
import { CommandPalette } from '@/components/CommandPalette';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Breadcrumbs } from '@/components/Breadcrumbs';
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
      } else {
        setIsAuthenticated(true);
      }
      
      setIsLoading(false);
    };

    checkAuth();
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    fetch('/api/logout', { method: 'POST' });
    toast.success('Logged out successfully');
    router.push('/login');
  };

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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <CommandPalette />
      
      {/* Mobile sidebar backdrop */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-gray-600 bg-opacity-75 z-40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-gray-800 shadow-lg transform ${
        isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
      } transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0`}>
        <div className="flex h-full flex-col">
          {/* Logo */}
          <div className="flex h-16 items-center justify-between px-4 border-b dark:border-gray-700">
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">VH Health Admin</h1>
            <button
              onClick={() => setIsSidebarOpen(false)}
              className="lg:hidden text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 space-y-1 px-2 py-4 overflow-y-auto">
            {navigation.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`group flex items-center px-2 py-2 text-sm font-medium rounded-md transition-colors ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                  }`}
                  onClick={() => setIsSidebarOpen(false)}
                >
                  {item.name}
                </Link>
              );
            })}
          </nav>

          {/* Logout button */}
          <div className="border-t dark:border-gray-700 p-4">
            <button
              onClick={handleLogout}
              className="w-full flex items-center justify-center px-4 py-2 text-sm font-medium text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-md hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
            >
              <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Logout
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Top bar */}
        <div className="sticky top-0 z-40 flex h-16 items-center gap-x-4 border-b bg-white dark:bg-gray-800 dark:border-gray-700 px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="lg:hidden text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          
          <div className="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
            <div className="flex items-center flex-1">
              <h2 className="text-lg font-medium text-gray-900 dark:text-white">
                {navigation.find(item => item.href === pathname)?.name || 'Dashboard'}
              </h2>
            </div>
            
            <div className="flex items-center gap-x-4">
              <ThemeToggle />
              <kbd className="hidden lg:block px-2 py-1 text-xs font-semibold text-gray-500 bg-gray-100 dark:bg-gray-700 dark:text-gray-400 rounded">
                ⌘K
              </kbd>
            </div>
          </div>
        </div>

        {/* Page content */}
        <main className="py-6">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <Breadcrumbs />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}