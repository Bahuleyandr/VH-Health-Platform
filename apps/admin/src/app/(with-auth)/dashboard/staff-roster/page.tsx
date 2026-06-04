// src/app/(with-auth)/dashboard/staff-roster/page.tsx
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import toast from "react-hot-toast";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Filter,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { ManagedTableToolbar } from "@/components/table";
import { Spinner } from "@/components/ui/spinner";
import {
  createStaffProfile,
  getRolePolicy,
  getStaffList,
  updateStaffProfile,
  type CreateStaffPayload,
  type RolePolicyResponse,
  type StaffListResponse,
  type StaffMember,
  type StaffShift,
} from "@/lib/api/staff";

type RoleOption = {
  value: string;
  label: string;
  group: string;
  permissions: string[];
};

const STAFF_ROLE_OPTIONS: RoleOption[] = [
  {
    value: "DOCTOR",
    label: "Doctor",
    group: "Clinical",
    permissions: ["Clinical records", "Orders", "Appointments"],
  },
  {
    value: "DUTY_DOCTOR",
    label: "Duty Doctor",
    group: "Clinical",
    permissions: ["Clinical records", "Emergency queue", "Orders"],
  },
  {
    value: "ANAESTHETIST",
    label: "Anaesthetist",
    group: "Clinical",
    permissions: ["OT records", "Anesthesia chart", "Clinical notes"],
  },
  {
    value: "NURSING_STAFF",
    label: "Nursing Staff",
    group: "Nursing",
    permissions: ["MAR", "Nursing assessments", "Ward tasks"],
  },
  {
    value: "NURSING_INCHARGE",
    label: "Nursing Incharge",
    group: "Nursing",
    permissions: ["Nursing roster", "Ward oversight", "Escalations"],
  },
  {
    value: "OP_STAFF_NURSE",
    label: "OP Staff Nurse",
    group: "Nursing",
    permissions: ["OPD queue", "Vitals", "Nursing notes"],
  },
  {
    value: "OP_INCHARGE",
    label: "OP Incharge",
    group: "Nursing",
    permissions: ["OPD roster", "Queue oversight", "Escalations"],
  },
  {
    value: "PHARMACY_STAFF",
    label: "Pharmacy Staff",
    group: "Support",
    permissions: ["Medication orders", "Inventory", "Dispensing"],
  },
  {
    value: "LAB_STAFF",
    label: "Lab Staff",
    group: "Support",
    permissions: ["Lab bookings", "Results", "Sample workflow"],
  },
  {
    value: "RADIOLOGY_STAFF",
    label: "Radiology Staff",
    group: "Support",
    permissions: ["Radiology worklist", "Reports", "Acquisition"],
  },
  {
    value: "HR_STAFF",
    label: "HR Staff",
    group: "Administration",
    permissions: ["Staff roster", "Leave approvals", "Onboarding"],
  },
  {
    value: "GENERAL_STAFF",
    label: "General Staff",
    group: "Operations",
    permissions: ["My work", "Attendance", "Leave"],
  },
  {
    value: "HOUSEKEEPING_STAFF",
    label: "Housekeeping Staff",
    group: "Operations",
    permissions: ["Housekeeping tasks", "Zone logs", "Requests"],
  },
  {
    value: "HOUSEKEEPING_INCHARGE",
    label: "Housekeeping Incharge",
    group: "Operations",
    permissions: ["Housekeeping roster", "Zone oversight", "Requests"],
  },
  {
    value: "RECEPTIONIST",
    label: "Receptionist",
    group: "Front Office",
    permissions: ["Appointments", "Walk-ins", "Patient search"],
  },
  {
    value: "RECEPTION_INCHARGE",
    label: "Reception Incharge",
    group: "Front Office",
    permissions: ["Front desk roster", "Appointments", "Escalations"],
  },
  {
    value: "DRIVER",
    label: "Driver",
    group: "Operations",
    permissions: ["Ambulance tasks", "Attendance", "Leave"],
  },
  {
    value: "SECURITY",
    label: "Security",
    group: "Operations",
    permissions: ["Security tasks", "Attendance", "Leave"],
  },
  {
    value: "MAINTENANCE",
    label: "Maintenance",
    group: "Operations",
    permissions: ["Maintenance tasks", "Attendance", "Leave"],
  },
  {
    value: "EMERGENCY_RESPONDER",
    label: "Emergency Responder",
    group: "Emergency",
    permissions: ["SOS queue", "Emergency response", "Attendance"],
  },
];

const SHIFT_OPTIONS: Array<{ value: StaffShift; label: string }> = [
  { value: "FULL_DAY", label: "Full Day" },
  { value: "MORNING", label: "Morning" },
  { value: "AFTERNOON", label: "Afternoon" },
  { value: "NIGHT", label: "Night" },
  { value: "ON_CALL", label: "On Call" },
];

const DEFAULT_DEPARTMENT_OPTIONS = [
  "Admissions",
  "Billing",
  "Emergency",
  "General",
  "Housekeeping",
  "ICU",
  "Insurance",
  "Laboratory",
  "Maintenance",
  "Nursing",
  "OPD",
  "Pharmacy",
  "Radiology",
  "Reception",
  "Security",
];

const DEFAULT_FORM: CreateStaffPayload = {
  name: "",
  phone: "",
  email: "",
  role: "NURSING_STAFF",
  temporary_password: "",
  position: "Staff Nurse",
  department: "Nursing",
  shift: "FULL_DAY",
};

function hasStaffProfile(staff: StaffMember) {
  return Boolean(staff.employee_id || staff.department || staff.position);
}

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

function formatShift(shift: string | null | undefined) {
  if (!shift) return "Unassigned";
  return shift
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function staffKey(staff: StaffMember) {
  return staff.employee_id ?? staff.uid ?? String(staff.id);
}

function selectValue(value: string | null | undefined) {
  return value && value.trim() ? value : "";
}

function uniqueSortedDepartments(values: Array<string | null | undefined>) {
  const seen = new Map<string, string>();
  for (const value of values) {
    const department = String(value ?? "").trim();
    if (!department) continue;
    const key = department.toLowerCase();
    if (!seen.has(key)) seen.set(key, department);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function groupCount<T extends string>(
  rows: StaffMember[],
  getKey: (row: StaffMember) => T | "",
) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = getKey(row) || "Unassigned";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function roleOptionsFromPolicy(
  policy: RolePolicyResponse | null,
): RoleOption[] {
  if (!policy?.roles?.length) return [];
  const options = policy.roles
    .filter((role) => role.assignable_staff === true)
    .filter((role) => role.human !== false && role.machine !== true)
    .map((role) => ({
      value: role.role_code,
      label: role.display_title ?? formatRole(role.role_code),
      group: role.group ? formatRole(role.group) : (role.department ?? "Staff"),
      permissions: role.access?.route_capability_groups?.length
        ? role.access.route_capability_groups.map((capability) =>
            formatRole(capability),
          )
        : [
            role.phi?.access_level
              ? formatRole(role.phi.access_level)
              : "Role policy",
          ],
    }))
    .sort(
      (a, b) =>
        a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
    );
  return options;
}

function shortHash(value: string | null) {
  if (!value) return null;
  return value.length <= 12 ? value : value.slice(0, 12);
}

export default function StaffRosterPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [shiftFilter, setShiftFilter] = useState("");
  const [showOnboardModal, setShowOnboardModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateStaffPayload>(DEFAULT_FORM);
  const [roleOptions, setRoleOptions] =
    useState<RoleOption[]>(STAFF_ROLE_OPTIONS);
  const [policyVersion, setPolicyVersion] = useState<string | null>(null);
  const [policyHash, setPolicyHash] = useState<string | null>(null);
  const [departmentMenuOpen, setDepartmentMenuOpen] = useState(false);
  const [departmentMenuShowsAll, setDepartmentMenuShowsAll] = useState(false);
  const [shiftStaff, setShiftStaff] = useState<StaffMember | null>(null);
  const [shiftValue, setShiftValue] = useState<StaffShift>("FULL_DAY");
  const [savingShift, setSavingShift] = useState(false);
  const departmentPickerRef = useRef<HTMLDivElement | null>(null);

  const fetchData = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      try {
        if (quiet) setRefreshing(true);
        else setLoading(true);
        setError(null);
        const [response, policy] = await Promise.all([
          getStaffList<StaffListResponse>({ limit: 200, active: true }),
          getRolePolicy<RolePolicyResponse>().catch(() => null),
        ]);
        const rows = response.staff ?? [];
        const profiled = rows.filter(hasStaffProfile);
        setStaff(profiled.length > 0 ? profiled : rows);
        if (policy) {
          const policyOptions = roleOptionsFromPolicy(policy);
          if (policyOptions.length > 0) setRoleOptions(policyOptions);
          setPolicyVersion(policy.policy_version);
          setPolicyHash(policy.policy_hash);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load staff roster",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!showOnboardModal) {
      setDepartmentMenuOpen(false);
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      const picker = departmentPickerRef.current;
      if (!picker || !event.target || picker.contains(event.target as Node))
        return;
      setDepartmentMenuOpen(false);
      setDepartmentMenuShowsAll(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [showOnboardModal]);

  const departments = useMemo(
    () =>
      Array.from(
        new Set(staff.map((row) => row.department).filter(Boolean) as string[]),
      ).sort(),
    [staff],
  );

  const onboardingDepartmentOptions = useMemo(
    () =>
      uniqueSortedDepartments([
        ...DEFAULT_DEPARTMENT_OPTIONS,
        ...departments,
        form.department,
      ]),
    [departments, form.department],
  );

  const departmentSuggestions = useMemo(() => {
    const query = form.department.trim().toLowerCase();
    if (departmentMenuShowsAll || !query) return onboardingDepartmentOptions;
    return onboardingDepartmentOptions.filter((department) =>
      department.toLowerCase().includes(query),
    );
  }, [departmentMenuShowsAll, form.department, onboardingDepartmentOptions]);

  const roles = useMemo(
    () =>
      Array.from(
        new Set(staff.map((row) => row.role).filter(Boolean) as string[]),
      ).sort(),
    [staff],
  );

  const visibleStaff = useMemo(() => {
    const term = search.trim().toLowerCase();
    return staff.filter((row) => {
      const matchesSearch =
        !term ||
        [
          row.employee_id,
          row.name,
          row.role,
          row.department,
          row.position,
          row.phone,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term));
      const matchesDepartment =
        !departmentFilter || row.department === departmentFilter;
      const matchesRole = !roleFilter || row.role === roleFilter;
      const matchesShift = !shiftFilter || row.shift === shiftFilter;
      return matchesSearch && matchesDepartment && matchesRole && matchesShift;
    });
  }, [departmentFilter, roleFilter, search, shiftFilter, staff]);

  const departmentSummary = useMemo(
    () => groupCount(visibleStaff, (row) => selectValue(row.department)),
    [visibleStaff],
  );

  const shiftSummary = useMemo(
    () => groupCount(visibleStaff, (row) => selectValue(row.shift)),
    [visibleStaff],
  );

  const selectedRole =
    roleOptions.find((role) => role.value === form.role) ??
    roleOptions[0] ??
    STAFF_ROLE_OPTIONS[0];
  const unassignedShiftCount = staff.filter((row) => !row.shift).length;
  const activeCount = staff.filter((row) => row.is_active !== false).length;

  function updateForm<K extends keyof CreateStaffPayload>(
    key: K,
    value: CreateStaffPayload[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleCreateStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setCreating(true);
      const payload: CreateStaffPayload = {
        ...form,
        employee_id: form.employee_id?.trim() || undefined,
        email: form.email?.trim() || undefined,
        phone: form.phone.replace(/[\s-]/g, ""),
        name: form.name.trim(),
        department: form.department.trim(),
        position: form.position.trim(),
        temporary_password: form.temporary_password.trim(),
      };
      await createStaffProfile(payload);
      toast.success("Staff profile created");
      setShowOnboardModal(false);
      setForm(DEFAULT_FORM);
      await fetchData({ quiet: true });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create staff profile",
      );
    } finally {
      setCreating(false);
    }
  }

  function openShiftModal(row: StaffMember) {
    setShiftStaff(row);
    setShiftValue((row.shift as StaffShift | null) || "FULL_DAY");
  }

  async function handleShiftUpdate() {
    if (!shiftStaff) return;
    const identifier =
      shiftStaff.employee_id ?? shiftStaff.uid ?? shiftStaff.id;
    try {
      setSavingShift(true);
      await updateStaffProfile(identifier, { shift: shiftValue });
      toast.success("Shift updated");
      setShiftStaff(null);
      await fetchData({ quiet: true });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update shift",
      );
    } finally {
      setSavingShift(false);
    }
  }

  const clearFilters = () => {
    setSearch("");
    setDepartmentFilter("");
    setRoleFilter("");
    setShiftFilter("");
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 text-destructive">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} />
          <div>
            <h1 className="font-semibold">Staff roster unavailable</h1>
            <p className="mt-1 text-sm">{error}</p>
            <button
              onClick={() => void fetchData()}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-destructive px-3 py-2 text-sm font-medium text-white"
            >
              <RefreshCw size={15} />
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Staff Roster</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Workforce governance
          </p>
          {(policyVersion || policyHash) && (
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              {policyVersion ?? "Role policy"}{" "}
              {shortHash(policyHash) ? `- policy ${shortHash(policyHash)}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void fetchData({ quiet: true })}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
          <button
            onClick={() => setShowOnboardModal(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            <UserPlus size={16} />
            Onboard Staff
          </button>
        </div>
      </div>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Rostered Staff", value: staff.length, icon: Users },
          { label: "Active Staff", value: activeCount, icon: CheckCircle2 },
          { label: "Departments", value: departments.length, icon: Filter },
          {
            label: "Unassigned Shift",
            value: unassignedShiftCount,
            icon: CalendarDays,
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
              <p className="mt-2 text-2xl font-semibold">{stat.value}</p>
            </div>
          );
        })}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">Department Rosters</h2>
          </div>
          <div className="grid grid-cols-1 gap-0 sm:grid-cols-2">
            {departmentSummary.slice(0, 8).map((dept) => (
              <div
                key={dept.name}
                className="flex items-center justify-between border-b border-border px-4 py-3 text-sm sm:odd:border-r"
              >
                <span className="font-medium">{dept.name}</span>
                <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  {dept.count} staff
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">Shift Mix</h2>
          </div>
          <div className="divide-y divide-border">
            {shiftSummary.map((shift) => (
              <div
                key={shift.name}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <span>{formatShift(shift.name)}</span>
                <span className="font-medium">{shift.count}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ManagedTableToolbar
        search={search}
        onSearchChange={setSearch}
        placeholder="Search staff, employee ID, role, department"
        countLabel={`${visibleStaff.length} of ${staff.length} staff`}
        savedViewScope="staff-roster"
        savedViewState={{ search, departmentFilter, roleFilter, shiftFilter }}
        onApplySavedView={(view) => {
          setSearch(String(view.search ?? ""));
          setDepartmentFilter(String(view.departmentFilter ?? ""));
          setRoleFilter(String(view.roleFilter ?? ""));
          setShiftFilter(String(view.shiftFilter ?? ""));
        }}
      >
        <select
          value={departmentFilter}
          onChange={(event) => setDepartmentFilter(event.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          aria-label="Department filter"
        >
          <option value="">All departments</option>
          {departments.map((department) => (
            <option key={department} value={department}>
              {department}
            </option>
          ))}
        </select>
        <select
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          aria-label="Role filter"
        >
          <option value="">All roles</option>
          {roles.map((role) => (
            <option key={role} value={role}>
              {formatRole(role)}
            </option>
          ))}
        </select>
        <select
          value={shiftFilter}
          onChange={(event) => setShiftFilter(event.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          aria-label="Shift filter"
        >
          <option value="">All shifts</option>
          {SHIFT_OPTIONS.map((shift) => (
            <option key={shift.value} value={shift.value}>
              {shift.label}
            </option>
          ))}
        </select>
        <button
          onClick={clearFilters}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm hover:bg-muted"
        >
          <X size={14} />
          Clear
        </button>
      </ManagedTableToolbar>

      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 font-medium">Staff</th>
                <th className="px-4 py-3 font-medium">Department</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Shift</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleStaff.length === 0 ? (
                <tr>
                  <td
                    className="px-4 py-8 text-center text-muted-foreground"
                    colSpan={7}
                  >
                    No staff match the current filters
                  </td>
                </tr>
              ) : (
                visibleStaff.map((row) => (
                  <tr key={staffKey(row)} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">
                      {row.employee_id || "-"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.phone || row.email || "-"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {row.department || "Unassigned"}
                    </td>
                    <td className="px-4 py-3">{formatRole(row.role)}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                        {formatShift(row.shift)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs ${
                          row.is_active === false
                            ? "bg-rose-500/10 text-rose-300"
                            : "bg-emerald-500/10 text-emerald-300"
                        }`}
                      >
                        {row.is_active === false ? "Inactive" : "Active"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openShiftModal(row)}
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                      >
                        <CalendarDays size={14} />
                        Set Shift
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showOnboardModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4 py-6">
          <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold">Onboard Staff</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  New staff profile
                </p>
              </div>
              <button
                onClick={() => setShowOnboardModal(false)}
                className="grid h-8 w-8 place-items-center rounded-md hover:bg-muted"
                aria-label="Close onboarding modal"
              >
                <X size={17} />
              </button>
            </div>

            <form onSubmit={handleCreateStaff} className="space-y-5 p-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Full Name</span>
                  <input
                    required
                    value={form.name}
                    onChange={(event) => updateForm("name", event.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Phone</span>
                  <input
                    required
                    value={form.phone}
                    onChange={(event) =>
                      updateForm("phone", event.target.value)
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                    placeholder="9876543210"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Email</span>
                  <input
                    type="email"
                    value={form.email ?? ""}
                    onChange={(event) =>
                      updateForm("email", event.target.value)
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Employee ID</span>
                  <input
                    value={form.employee_id ?? ""}
                    onChange={(event) =>
                      updateForm("employee_id", event.target.value)
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                    placeholder="Auto-generated when blank"
                  />
                </label>
                <div className="space-y-1 text-sm" ref={departmentPickerRef}>
                  <span className="font-medium">Department</span>
                  <div className="relative">
                    <input
                      id="onboard-department"
                      required
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls="onboard-department-listbox"
                      aria-expanded={departmentMenuOpen}
                      value={form.department}
                      onChange={(event) => {
                        updateForm("department", event.target.value);
                        setDepartmentMenuOpen(true);
                        setDepartmentMenuShowsAll(false);
                      }}
                      onFocus={() => {
                        setDepartmentMenuOpen(true);
                        setDepartmentMenuShowsAll(false);
                      }}
                      className="w-full rounded-md border border-input bg-background py-2 pl-3 pr-10"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDepartmentMenuOpen((open) => !open);
                        setDepartmentMenuShowsAll(true);
                      }}
                      className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
                      aria-label="Show department options"
                    >
                      <ChevronDown size={16} />
                    </button>
                    {departmentMenuOpen && (
                      <div
                        id="onboard-department-listbox"
                        role="listbox"
                        className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-card py-1 shadow-lg"
                      >
                        {departmentSuggestions.length > 0 ? (
                          departmentSuggestions.map((department) => (
                            <button
                              key={department}
                              type="button"
                              role="option"
                              aria-selected={form.department === department}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                updateForm("department", department);
                                setDepartmentMenuOpen(false);
                                setDepartmentMenuShowsAll(false);
                              }}
                              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                            >
                              <span>{department}</span>
                              {form.department === department && (
                                <CheckCircle2
                                  size={15}
                                  className="text-primary"
                                />
                              )}
                            </button>
                          ))
                        ) : (
                          <div className="px-3 py-2 text-sm text-muted-foreground">
                            No matching department
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Position</span>
                  <input
                    required
                    value={form.position}
                    onChange={(event) =>
                      updateForm("position", event.target.value)
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Role</span>
                  <select
                    required
                    value={form.role}
                    onChange={(event) => updateForm("role", event.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                  >
                    {roleOptions.map((role) => (
                      <option key={role.value} value={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Shift</span>
                  <select
                    value={form.shift}
                    onChange={(event) =>
                      updateForm("shift", event.target.value as StaffShift)
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                  >
                    {SHIFT_OPTIONS.map((shift) => (
                      <option key={shift.value} value={shift.value}>
                        {shift.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm md:col-span-2">
                  <span className="font-medium">Temporary Password</span>
                  <input
                    required
                    type="password"
                    value={form.temporary_password}
                    onChange={(event) =>
                      updateForm("temporary_password", event.target.value)
                    }
                    minLength={6}
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                  />
                </label>
              </div>

              <div className="rounded-lg border border-border bg-background p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck size={16} className="text-indigo-300" />
                  Role Permissions
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedRole.group} - {selectedRole.label}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedRole.permissions.map((permission) => (
                    <span
                      key={permission}
                      className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-200"
                    >
                      {permission}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => setShowOnboardModal(false)}
                  className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
                >
                  <UserPlus size={16} />
                  {creating ? "Creating..." : "Create Staff"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {shiftStaff && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Set Shift</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {shiftStaff.name} -{" "}
                  {shiftStaff.employee_id || "No employee ID"}
                </p>
              </div>
              <button
                onClick={() => setShiftStaff(null)}
                className="grid h-8 w-8 place-items-center rounded-md hover:bg-muted"
                aria-label="Close shift modal"
              >
                <X size={17} />
              </button>
            </div>
            <label className="mt-4 block space-y-1 text-sm">
              <span className="font-medium">Shift</span>
              <select
                value={shiftValue}
                onChange={(event) =>
                  setShiftValue(event.target.value as StaffShift)
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                {SHIFT_OPTIONS.map((shift) => (
                  <option key={shift.value} value={shift.value}>
                    {shift.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShiftStaff(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleShiftUpdate()}
                disabled={savingShift}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
              >
                <CalendarDays size={16} />
                {savingShift ? "Saving..." : "Save Shift"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
