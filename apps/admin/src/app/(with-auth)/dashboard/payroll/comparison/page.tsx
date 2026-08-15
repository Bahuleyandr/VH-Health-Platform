"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPayrollComparison, PayrollComparisonData } from "@/lib/api/payroll";
import { toast } from "react-hot-toast";

type StaffEntry = PayrollComparisonData["staff"][number];
type PayslipEntry = StaffEntry["payslips"][number];

function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) {
    return (x as { data: T }).data;
  }
  return x as T;
}

function fmtCurrency(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "₹0";
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isNaN(n)
    ? "₹0"
    : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PayrollComparisonPage() {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const [fromMonth, setFromMonth] = useState(Math.max(1, currentMonth - 5));
  const [fromYear, setFromYear] = useState(
    currentMonth > 5 ? currentYear : currentYear - 1,
  );
  const [toMonth, setToMonth] = useState(currentMonth);
  const [toYear, setToYear] = useState(currentYear);
  const [staffFilter, setStaffFilter] = useState<string>("");
  const [viewMode, setViewMode] = useState<"all" | "individual">("all");

  const {
    data: comparisonRaw,
    isLoading,
    error,
  } = useQuery({
    queryKey: [
      "payroll-comparison",
      fromMonth,
      fromYear,
      toMonth,
      toYear,
      staffFilter,
    ],
    queryFn: () =>
      getPayrollComparison(
        fromMonth,
        fromYear,
        toMonth,
        toYear,
        staffFilter || undefined,
      ),
  });

  const comparison = unwrap<PayrollComparisonData>(comparisonRaw);

  const staffList = useMemo((): StaffEntry[] => {
    return (
      comparison?.staff
        ?.sort((a: StaffEntry, b: StaffEntry) => a.name.localeCompare(b.name))
        .filter(
          (s: StaffEntry) =>
            !staffFilter ||
            s.name.toLowerCase().includes(staffFilter.toLowerCase()),
        ) || []
    );
  }, [comparison, staffFilter]);

  if (error) {
    toast.error("Failed to load payroll comparison");
  }

  // Month name helper
  const monthName = (m: number) =>
    [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ][m - 1];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 text-gray-900">
        Payroll Comparison
      </h1>

      {/* Filters */}
      <div className="bg-card rounded-lg border border-gray-200 p-4 mb-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-6 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              From Month
            </label>
            <select
              value={fromMonth}
              onChange={(e) => setFromMonth(parseInt(e.target.value))}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Year
            </label>
            <select
              value={fromYear}
              onChange={(e) => setFromYear(parseInt(e.target.value))}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              {[currentYear - 2, currentYear - 1, currentYear].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              To Month
            </label>
            <select
              value={toMonth}
              onChange={(e) => setToMonth(parseInt(e.target.value))}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Year
            </label>
            <select
              value={toYear}
              onChange={(e) => setToYear(parseInt(e.target.value))}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              {[currentYear - 2, currentYear - 1, currentYear].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          <div className="col-span-2 sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              View Mode
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setViewMode("all")}
                className={`flex-1 px-3 py-2 text-sm rounded ${
                  viewMode === "all"
                    ? "bg-teal-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                All Staff
              </button>
              <button
                onClick={() => setViewMode("individual")}
                className={`flex-1 px-3 py-2 text-sm rounded ${
                  viewMode === "individual"
                    ? "bg-teal-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                Individual
              </button>
            </div>
          </div>
        </div>

        {viewMode === "individual" && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Filter by Staff
            </label>
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              <option value="">-- Select Staff --</option>
              {staffList.map((s: StaffEntry) => (
                <option key={s.staff_uid} value={s.staff_uid}>
                  {s.name} ({s.employee_id})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Summary Stats */}
      {comparison && (
        <div className="grid grid-cols-2 gap-4 mb-6 sm:grid-cols-4">
          <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
            <p className="text-sm text-gray-600">Total Staff</p>
            <p className="text-2xl font-bold text-blue-600">
              {comparison.total_staff}
            </p>
          </div>
          <div className="bg-green-50 rounded-lg p-4 border border-green-200">
            <p className="text-sm text-gray-600">Total Payslips</p>
            <p className="text-2xl font-bold text-green-600">
              {comparison.total_payslips}
            </p>
          </div>
          <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
            <p className="text-sm text-gray-600">Months</p>
            <p className="text-2xl font-bold text-purple-600">
              {comparison.month_range.length}
            </p>
          </div>
          <div className="bg-orange-50 rounded-lg p-4 border border-orange-200">
            <p className="text-sm text-gray-600">Date Range</p>
            <p className="text-xs font-semibold text-orange-600 mt-2">
              {monthName(fromMonth)} {fromYear} → {monthName(toMonth)} {toYear}
            </p>
          </div>
        </div>
      )}

      {/* Comparison Table */}
      {isLoading ? (
        <div className="text-center py-12">
          <p className="text-gray-500">Loading payroll data...</p>
        </div>
      ) : staffList.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">
            No payslips found for the selected period and filters.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          {viewMode === "all" ? (
            <ComparisonTableAll
              staffList={staffList}
              monthRange={comparison?.month_range || []}
              monthName={monthName}
            />
          ) : (
            <ComparisonTableIndividual
              staff={staffList[0]}
              monthRange={comparison?.month_range || []}
              monthName={monthName}
            />
          )}
        </div>
      )}
    </div>
  );
}

// All staff table
function ComparisonTableAll({
  staffList,
  monthRange,
  monthName,
}: {
  staffList: StaffEntry[];
  monthRange: Array<{ month: number; year: number }>;
  monthName: (m: number) => string;
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b-2 border-gray-300 bg-gray-50">
          <th className="text-left px-4 py-3 font-semibold text-gray-700 sticky left-0 bg-gray-50 z-10 w-40">
            Staff Name
          </th>
          {monthRange.map((m) => (
            <th
              key={`${m.year}-${m.month}`}
              className="text-right px-3 py-3 font-semibold text-gray-700 whitespace-nowrap"
            >
              <div>{monthName(m.month)}</div>
              <div className="text-xs text-gray-500">{m.year}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {staffList.map((staff) => (
          <tr
            key={staff.staff_uid}
            className="border-b border-gray-200 hover:bg-gray-50"
          >
            <td className="px-4 py-3 font-medium text-gray-900 sticky left-0 bg-card z-10">
              <div>{staff.name}</div>
              <div className="text-xs text-gray-500">{staff.employee_id}</div>
            </td>
            {monthRange.map((m) => {
              const payslip = staff.payslips.find(
                (p: PayslipEntry) => p.month === m.month && p.year === m.year,
              );
              return (
                <td
                  key={`${staff.staff_uid}-${m.year}-${m.month}`}
                  className="text-right px-3 py-3 whitespace-nowrap"
                >
                  {payslip ? (
                    <div className="text-sm">
                      <div className="font-semibold text-teal-700">
                        {fmtCurrency(payslip.net_salary)}
                      </div>
                      <div className="text-xs text-gray-500">
                        Gross: {fmtCurrency(payslip.gross_salary)}
                      </div>
                    </div>
                  ) : (
                    <span className="text-gray-400 text-xs">—</span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Individual staff detailed table
function ComparisonTableIndividual({
  staff,
  monthRange,
  monthName,
}: {
  staff: StaffEntry;
  monthRange: Array<{ month: number; year: number }>;
  monthName: (m: number) => string;
}) {
  const components = [
    { label: "Basic", key: "basic_earned", color: "text-gray-900" },
    { label: "HRA", key: "hra_earned", color: "text-gray-700" },
    { label: "DA", key: "da_earned", color: "text-gray-700" },
    { label: "Allowances", key: "special_allowance", color: "text-gray-700" },
    { label: "Overtime", key: "overtime_pay", color: "text-blue-600" },
    { label: "Bonus", key: "bonus", color: "text-green-600" },
    { label: "Arrears", key: "arrears", color: "text-orange-600" },
    {
      label: "Gross",
      key: "gross_salary",
      color: "font-semibold text-gray-900",
    },
    { label: "PF", key: "pf", color: "text-red-700" },
    { label: "ESI", key: "esi", color: "text-red-700" },
    { label: "Prof Tax", key: "professional_tax", color: "text-red-700" },
    { label: "TDS", key: "tds", color: "text-red-700" },
    {
      label: "Total Deductions",
      key: "total_deductions",
      color: "font-semibold text-red-900",
    },
    {
      label: "Net Pay",
      key: "net_salary",
      color: "font-bold text-teal-700 text-lg",
    },
  ];

  return (
    <div className="bg-card rounded-lg border border-gray-200 overflow-hidden">
      <div className="p-4 bg-gray-50 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">{staff.name}</h2>
        <p className="text-sm text-gray-600">
          {staff.employee_id} • {staff.designation} • {staff.department}
        </p>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-50">
            <th className="text-left px-4 py-3 font-semibold text-gray-700 w-32">
              Component
            </th>
            {monthRange.map((m) => (
              <th
                key={`${m.year}-${m.month}`}
                className="text-right px-4 py-3 font-semibold text-gray-700 whitespace-nowrap min-w-[130px]"
              >
                <div>{monthName(m.month)}</div>
                <div className="text-xs text-gray-500">{m.year}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {components.map((comp) => (
            <tr
              key={comp.key}
              className="border-b border-gray-200 hover:bg-gray-50"
            >
              <td
                className={`px-4 py-3 font-medium text-gray-700 ${comp.key === "gross_salary" || comp.key === "net_salary" ? "bg-gray-50 font-semibold" : ""}`}
              >
                {comp.label}
              </td>
              {monthRange.map((m) => {
                const payslip = staff.payslips.find(
                  (p: PayslipEntry) => p.month === m.month && p.year === m.year,
                );
                const value = payslip
                  ? payslip[comp.key as keyof typeof payslip]
                  : null;
                return (
                  <td
                    key={`${comp.key}-${m.year}-${m.month}`}
                    className={`text-right px-4 py-3 whitespace-nowrap ${comp.color} ${comp.key === "gross_salary" || comp.key === "net_salary" ? "bg-gray-50" : ""}`}
                  >
                    {value !== null && value !== undefined
                      ? fmtCurrency(value as number)
                      : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Attendance summary */}
      <div className="p-4 bg-blue-50 border-t border-blue-200 text-sm">
        <h3 className="font-semibold text-gray-800 mb-2">Attendance Summary</h3>
        <table className="w-full text-xs">
          <tbody>
            {monthRange.map((m) => {
              const payslip = staff.payslips.find(
                (p: PayslipEntry) => p.month === m.month && p.year === m.year,
              );
              return (
                <tr
                  key={`att-${m.year}-${m.month}`}
                  className="border-t border-blue-100"
                >
                  <td className="py-1 font-medium text-gray-700">
                    {monthName(m.month)} {m.year}
                  </td>
                  <td className="py-1 text-gray-600">
                    P: {payslip?.days_present || "—"} | A:{" "}
                    {payslip?.days_absent || "—"} | L:{" "}
                    {payslip?.lop_days || "—"} | OT:{" "}
                    {payslip?.overtime_hours || "—"}h
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
