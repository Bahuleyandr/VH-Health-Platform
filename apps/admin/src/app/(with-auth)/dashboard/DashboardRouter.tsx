// src/app/(with-auth)/dashboard/DashboardRouter.tsx
// Role-aware dashboard home.
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarCheck,
  ClipboardList,
  FileText,
  IdCard,
  Inbox,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  Upload,
  UserRoundCheck,
  Users,
} from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import {
  getHRDashboard,
  getStaffList,
  type HRDashboardResponse,
  type StaffListResponse,
  type StaffMember,
} from "@/lib/api/staff";

const AdminDashboard = dynamic(() => import("./Dashboard"), { ssr: false });

type IconType = ComponentType<{ className?: string; size?: number }>;

type HomeCard = {
  label: string;
  href: string;
  icon: IconType;
  desc: string;
  primary?: boolean;
};

const staffCards: HomeCard[] = [
  {
    label: "Today's Appointments",
    href: "/dashboard/my-appointments",
    icon: CalendarCheck,
    desc: "Patient queue",
  },
  {
    label: "Attendance",
    href: "/dashboard/my-attendance",
    icon: Activity,
    desc: "Monthly register",
  },
  {
    label: "Leave",
    href: "/dashboard/my-leave",
    icon: Inbox,
    desc: "Balance and requests",
  },
  {
    label: "Payslips",
    href: "/dashboard/my-payslips",
    icon: FileText,
    desc: "Earnings records",
  },
  {
    label: "Replacements",
    href: "/dashboard/my-replacements",
    icon: RefreshCw,
    desc: "Shift coverage",
  },
  {
    label: "Upload Documents",
    href: "/dashboard/upload-prescription",
    icon: Upload,
    desc: "Prescriptions and reports",
  },
];

const doctorCards: HomeCard[] = [
  {
    label: "Today's Patient Queue",
    href: "/dashboard/my-appointments",
    icon: Stethoscope,
    desc: "Scheduled appointments",
  },
  {
    label: "Pending Confirmations",
    href: "/dashboard/my-appointments?tab=pending",
    icon: AlertTriangle,
    desc: "Awaiting confirmation",
  },
  {
    label: "Upload Prescription",
    href: "/dashboard/upload-prescription",
    icon: ClipboardList,
    desc: "Post-consultation docs",
  },
  {
    label: "My Attendance",
    href: "/dashboard/my-attendance",
    icon: Activity,
    desc: "Attendance calendar",
  },
  {
    label: "My Leave",
    href: "/dashboard/my-leave",
    icon: Inbox,
    desc: "Leave balance",
  },
  {
    label: "My Payslips",
    href: "/dashboard/my-payslips",
    icon: FileText,
    desc: "Earnings overview",
  },
];

const hrCards: HomeCard[] = [
  {
    label: "Staff Roster",
    href: "/dashboard/staff-roster",
    icon: Users,
    desc: "Directory, onboarding, shifts",
    primary: true,
  },
  {
    label: "Leave Approvals",
    href: "/dashboard/leave-approvals",
    icon: CalendarCheck,
    desc: "Pending leave requests",
  },
  {
    label: "Attendance Audit",
    href: "/dashboard/attendance-audit",
    icon: BarChart3,
    desc: "Anomalies and reports",
  },
  {
    label: "Open Incidents",
    href: "/dashboard/incidents",
    icon: AlertTriangle,
    desc: "Incident reports",
  },
  {
    label: "Grievances",
    href: "/dashboard/grievances",
    icon: Inbox,
    desc: "Confidential cases",
  },
  {
    label: "Report Audit",
    href: "/dashboard/reporting",
    icon: ShieldCheck,
    desc: "Compliance reports",
  },
];

function formatRole(role: string | null | undefined) {
  const acronyms = new Set(["HR", "OP", "CNO"]);
  return String(role ?? "Staff")
    .split("_")
    .map((part) => {
      const upper = part.toUpperCase();
      if (acronyms.has(upper)) return upper;
      return part.toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    })
    .join(" ");
}

function hasStaffProfile(staff: StaffMember) {
  return Boolean(staff.employee_id || staff.department || staff.position);
}

function HomeCardGrid({ cards }: { cards: HomeCard[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Link
            key={card.href}
            href={card.href}
            className={`block rounded-lg border p-5 transition-colors ${
              card.primary
                ? "border-indigo-500/60 bg-indigo-500/10 hover:border-indigo-400"
                : "border-border bg-card hover:border-indigo-500/50"
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-background text-indigo-300">
                <Icon size={18} />
              </span>
              <div>
                <p className="font-semibold text-white">{card.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {card.desc}
                </p>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function StaffHome() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">My Dashboard</h1>
      <HomeCardGrid cards={staffCards} />
    </div>
  );
}

function DoctorHome() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Doctor Dashboard</h1>
      <HomeCardGrid cards={doctorCards} />
    </div>
  );
}

function HRHome() {
  const [dashboard, setDashboard] = useState<HRDashboardResponse | null>(null);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function loadHRHome() {
      try {
        const [dashboardData, staffData] = await Promise.all([
          getHRDashboard().catch(() => null),
          getStaffList<StaffListResponse>({ limit: 200, active: true }).catch(
            () => null,
          ),
        ]);
        if (!alive) return;
        setDashboard(dashboardData);
        setStaffList((staffData?.staff ?? []).filter(hasStaffProfile));
      } finally {
        if (alive) setLoading(false);
      }
    }
    void loadHRHome();
    return () => {
      alive = false;
    };
  }, []);

  const overview = dashboard?.overview;
  const departments = dashboard?.departmentBreakdown ?? [];
  const seededStaff = useMemo(
    () => staffList.filter((staff) => staff.employee_id).slice(0, 8),
    [staffList],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">HR Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Workforce governance
          </p>
        </div>
        <Link
          href="/dashboard/staff-roster"
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          <Users size={16} />
          Staff Roster
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Active Staff",
            value: overview?.active_staff ?? staffList.length,
            icon: UserRoundCheck,
          },
          { label: "Departments", value: departments.length, icon: IdCard },
          {
            label: "Checked In",
            value: overview?.currently_checked_in ?? 0,
            icon: Activity,
          },
          {
            label: "Pending Leave",
            value: dashboard?.leaves?.pending ?? 0,
            icon: CalendarCheck,
          },
        ].map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                <Icon className="text-indigo-300" size={17} />
              </div>
              <p className="mt-2 text-2xl font-semibold text-white">
                {loading ? "--" : stat.value}
              </p>
            </div>
          );
        })}
      </div>

      <HomeCardGrid cards={hrCards} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold text-white">Seeded Staff</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Employee</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Department</th>
                </tr>
              </thead>
              <tbody>
                {seededStaff.length === 0 ? (
                  <tr>
                    <td
                      className="px-4 py-6 text-center text-muted-foreground"
                      colSpan={4}
                    >
                      No staff profiles found
                    </td>
                  </tr>
                ) : (
                  seededStaff.map((staff) => (
                    <tr
                      key={staff.employee_id ?? staff.uid ?? staff.id}
                      className="border-t border-border"
                    >
                      <td className="px-4 py-3 font-medium text-white">
                        {staff.employee_id}
                      </td>
                      <td className="px-4 py-3">{staff.name}</td>
                      <td className="px-4 py-3">{formatRole(staff.role)}</td>
                      <td className="px-4 py-3">{staff.department || "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold text-white">
              Department Coverage
            </h2>
          </div>
          <div className="divide-y divide-border">
            {(departments.length ? departments.slice(0, 6) : []).map((dept) => (
              <div
                key={dept.department}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div>
                  <p className="font-medium text-white">{dept.department}</p>
                  <p className="text-xs text-muted-foreground">
                    {dept.present_today} present today
                  </p>
                </div>
                <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  {dept.active_staff} active
                </span>
              </div>
            ))}
            {!departments.length && (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                No department coverage loaded
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function DashboardRouter() {
  const { isAdmin, isHR, isDoctor, isStaff, loading } = usePermissions();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        Loading dashboard...
      </div>
    );
  }

  if (isAdmin) return <AdminDashboard />;
  if (isDoctor) return <DoctorHome />;
  if (isHR) return <HRHome />;
  if (isStaff) return <StaffHome />;

  return (
    <div className="mx-auto max-w-xl rounded-lg border border-amber-500/40 bg-amber-500/10 p-6 text-center">
      <AlertTriangle className="mx-auto text-amber-300" size={28} />
      <h1 className="mt-3 text-lg font-semibold text-white">
        Dashboard access unavailable
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your account role is not recognized by this portal. No administrative
        dashboard has been granted. Contact an administrator to correct the
        role.
      </p>
    </div>
  );
}
