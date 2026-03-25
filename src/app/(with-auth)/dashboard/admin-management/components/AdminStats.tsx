// src/app/(with-auth)/dashboard/admin-management/components/AdminStats.tsx
"use client";

import { useMemo } from "react";
import type { AdminUser } from "@/lib/types";
import { UsersIcon, CheckCircle, XCircle, ShieldIcon, ClockIcon } from "lucide-react";

interface AdminStatsProps {
  admins: AdminUser[];
}

export function AdminStats({ admins }: AdminStatsProps) {
  const { total, active, inactive, superAdmins, recentlyActive } =
    useMemo(() => {
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

        if (a.role === "SUPER_ADMIN") superAdmins += 1;

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
      <div className="bg-white p-6 rounded-lg shadow-sm border border-border">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Total Admins</p>
            <p className="text-2xl font-bold text-foreground mt-2">{total}</p>
          </div>
          <div className="text-muted-foreground" aria-hidden>
            <UsersIcon className="w-8 h-8" />
          </div>
        </div>
      </div>

      {/* Active */}
      <div className="bg-success/10 p-6 rounded-lg shadow-sm border border-success/30">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-success">Active</p>
            <p className="text-2xl font-bold text-success mt-2">{active}</p>
          </div>
          <div className="text-success/60" aria-hidden>
            <CheckCircle className="w-8 h-8" />
          </div>
        </div>
      </div>

      {/* Inactive */}
      <div className="bg-destructive/10 p-6 rounded-lg shadow-sm border border-destructive/30">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-destructive">Inactive</p>
            <p className="text-2xl font-bold text-destructive mt-2">{inactive}</p>
          </div>
          <div className="text-destructive/60" aria-hidden>
            <XCircle className="w-8 h-8" />
          </div>
        </div>
      </div>

      {/* Super Admins */}
      <div className="bg-primary/10 p-6 rounded-lg shadow-sm border border-primary/20">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-primary">Super Admins</p>
            <p className="text-2xl font-bold text-primary mt-2">
              {superAdmins}
            </p>
          </div>
          <div className="text-primary/60" aria-hidden>
            <ShieldIcon className="w-8 h-8" />
          </div>
        </div>
      </div>

      {/* Active (7d) */}
      <div className="bg-purple-50 p-6 rounded-lg shadow-sm border border-purple-200">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-purple-600">Active (7d)</p>
            <p className="text-2xl font-bold text-purple-900 mt-2">
              {recentlyActive}
            </p>
          </div>
          <div className="text-purple-400" aria-hidden>
            <ClockIcon className="w-8 h-8" />
          </div>
        </div>
      </div>
    </div>
  );
}
