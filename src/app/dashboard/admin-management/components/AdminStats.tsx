// src/app/dashboard/admin-management/components/AdminStats.tsx
'use client';

import { useMemo } from 'react';
import type { AdminUser } from '@/lib/types';

interface AdminStatsProps {
  admins: AdminUser[];
}

export function AdminStats({ admins }: AdminStatsProps) {
  const { total, active, inactive, superAdmins, recentlyActive } = useMemo(() => {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    let total = 0;
    let active = 0;
    let inactive = 0;
    let superAdmins = 0;
    let recentlyActive = 0;

    for (const a of admins) {
      total += 1;
      if (a.is_active) active += 1;
      else inactive += 1;

      if (a.role === 'SUPER_ADMIN') superAdmins += 1;

      // Be defensive about timestamps
      if (a.last_login) {
        const t = Date.parse(a.last_login);
        if (!Number.isNaN(t) && now - t <= sevenDaysMs) recentlyActive += 1;
      }
    }
    return { total, active, inactive, superAdmins, recentlyActive };
  }, [admins]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      {/* Total */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-600">Total Admins</p>
            <p className="text-2xl font-bold text-gray-900 mt-2">{total}</p>
          </div>
          <div className="text-gray-400" aria-hidden>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Active */}
      <div className="bg-green-50 p-6 rounded-lg shadow-sm border border-green-200">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-green-600">Active</p>
            <p className="text-2xl font-bold text-green-900 mt-2">{active}</p>
          </div>
          <div className="text-green-400" aria-hidden>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Inactive */}
      <div className="bg-red-50 p-6 rounded-lg shadow-sm border border-red-200">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-red-600">Inactive</p>
            <p className="text-2xl font-bold text-red-900 mt-2">{inactive}</p>
          </div>
          <div className="text-red-400" aria-hidden>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Super Admins */}
      <div className="bg-blue-50 p-6 rounded-lg shadow-sm border border-blue-200">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-blue-600">Super Admins</p>
            <p className="text-2xl font-bold text-blue-900 mt-2">{superAdmins}</p>
          </div>
          <div className="text-blue-400" aria-hidden>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Active (7d) */}
      <div className="bg-purple-50 p-6 rounded-lg shadow-sm border border-purple-200">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-purple-600">Active (7d)</p>
            <p className="text-2xl font-bold text-purple-900 mt-2">{recentlyActive}</p>
          </div>
          <div className="text-purple-400" aria-hidden>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
