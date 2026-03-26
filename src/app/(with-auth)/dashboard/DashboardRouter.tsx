// src/app/(with-auth)/dashboard/DashboardRouter.tsx
// Role-aware dashboard home — renders the right view based on logged-in user's role.
'use client';

import dynamic from 'next/dynamic';
import { usePermissions } from '@/hooks/usePermissions';

const CleanDashboard = dynamic(() => import('./CleanDashboard'), { ssr: false });

// Lightweight staff/doctor/hr home views
function StaffHome() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">My Dashboard</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: "Today's Appointments", href: '/dashboard/my-appointments', icon: '📅', desc: "View your patient queue" },
          { label: 'Attendance', href: '/dashboard/my-attendance', icon: '🕐', desc: "This month's calendar" },
          { label: 'Leave', href: '/dashboard/my-leave', icon: '🏖️', desc: "Balance & requests" },
          { label: 'Payslips', href: '/dashboard/my-payslips', icon: '💰', desc: "Download & view" },
          { label: 'Replacements', href: '/dashboard/my-replacements', icon: '🔄', desc: "Shift replacement requests" },
          { label: 'Upload Documents', href: '/dashboard/upload-prescription', icon: '📤', desc: "Prescriptions & reports" },
        ].map((card) => (
          <a
            key={card.href}
            href={card.href}
            className="rounded-xl border border-border bg-card p-5 hover:border-indigo-500/50 transition-colors block group"
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">{card.icon}</span>
              <div>
                <p className="font-semibold text-white group-hover:text-indigo-400 transition-colors">{card.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.desc}</p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function DoctorHome() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Doctor Dashboard</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: "Today's Patient Queue", href: '/dashboard/my-appointments', icon: '🏥', desc: "Scheduled appointments" },
          { label: 'Pending Confirmations', href: '/dashboard/my-appointments?tab=pending', icon: '⏳', desc: "Awaiting your confirmation" },
          { label: 'Upload Prescription', href: '/dashboard/upload-prescription', icon: '📝', desc: "Post-consultation docs" },
          { label: 'My Attendance', href: '/dashboard/my-attendance', icon: '🕐', desc: "Attendance calendar" },
          { label: 'My Leave', href: '/dashboard/my-leave', icon: '🏖️', desc: "Leave balance & requests" },
          { label: 'My Payslips', href: '/dashboard/my-payslips', icon: '💰', desc: "Earnings overview" },
        ].map((card) => (
          <a
            key={card.href}
            href={card.href}
            className="rounded-xl border border-border bg-card p-5 hover:border-indigo-500/50 transition-colors block group"
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">{card.icon}</span>
              <div>
                <p className="font-semibold text-white group-hover:text-indigo-400 transition-colors">{card.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.desc}</p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function HRHome() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">HR Dashboard</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: 'Leave Approvals', href: '/dashboard/leave-approvals', icon: '✅', desc: "Pending leave requests" },
          { label: 'Open Incidents', href: '/dashboard/incidents', icon: '⚠️', desc: "Incident reports" },
          { label: 'Grievances', href: '/dashboard/grievances', icon: '📩', desc: "Open grievances" },
          { label: 'Attendance Audit', href: '/dashboard/attendance-audit', icon: '📊', desc: "Anomalies & reports" },
          { label: 'Staff Roster', href: '/dashboard/staff-roster', icon: '👥', desc: "View staff" },
          { label: 'Report Audit', href: '/dashboard/reporting', icon: '📋', desc: "Compliance reports" },
        ].map((card) => (
          <a
            key={card.href}
            href={card.href}
            className="rounded-xl border border-border bg-card p-5 hover:border-indigo-500/50 transition-colors block group"
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">{card.icon}</span>
              <div>
                <p className="font-semibold text-white group-hover:text-indigo-400 transition-colors">{card.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.desc}</p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

export default function DashboardRouter() {
  const { isAdmin, isHR, isDoctor, isStaff, loading } = usePermissions();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        Loading dashboard…
      </div>
    );
  }

  if (isAdmin) return <CleanDashboard />;
  if (isDoctor) return <DoctorHome />;
  if (isHR) return <HRHome />;
  if (isStaff) return <StaffHome />;

  // Fallback for unknown roles
  return <CleanDashboard />;
}
