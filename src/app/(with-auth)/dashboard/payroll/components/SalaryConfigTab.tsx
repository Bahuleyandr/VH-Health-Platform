"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  getStaffForPayroll,
  getStaffSalaryConfig,
  upsertSalaryConfig,
  type StaffForPayroll,
  type StaffSalaryConfig,
} from "@/lib/api/payroll";
import { unwrap } from "./helpers";

export function SalaryConfigTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedStaff, setSelectedStaff] = useState<StaffForPayroll | null>(null);
  const [formData, setFormData] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);

  const { data: staffRaw, isLoading: staffLoading } = useQuery({
    queryKey: ["payroll-staff", search],
    queryFn: () => getStaffForPayroll({ search: search || undefined }),
    enabled: search.length >= 2 || search === "",
  });
  const staffList = unwrap<StaffForPayroll[]>(staffRaw) ?? [];

  const { data: configRaw, isLoading: configLoading } = useQuery({
    queryKey: ["salary-config", selectedStaff?.uid],
    queryFn: () => getStaffSalaryConfig(selectedStaff!.uid),
    enabled: !!selectedStaff?.uid,
  });
  const config = unwrap<StaffSalaryConfig | null>(configRaw);

  // Prefill form when config loads
  React.useEffect(() => {
    if (config) {
      setFormData({
        basic_salary: config.basic_salary ?? "",
        hra_pct: config.hra_pct ?? "40",
        da_pct: config.da_pct ?? "10",
        special_allowance: config.special_allowance ?? "0",
        transport_allowance: config.transport_allowance ?? "0",
        medical_allowance: config.medical_allowance ?? "0",
        pf_employee_pct: config.pf_employee_pct ?? "12",
        esi_applicable: config.esi_applicable ?? false,
        professional_tax: config.professional_tax ?? "200",
        tds_monthly: config.tds_monthly ?? "0",
        designation: config.designation ?? "",
        department: config.department ?? "",
        employee_id: config.employee_id ?? "",
        date_of_joining: config.date_of_joining ? config.date_of_joining.split("T")[0] : "",
        pan_number: "",  // never prefill masked sensitive data
        pf_uan: config.pf_uan ?? "",
        bank_account: "",  // never prefill masked
        bank_name: config.bank_name ?? "",
        bank_ifsc: config.bank_ifsc ?? "",
      });
    } else if (selectedStaff && !configLoading) {
      setFormData({
        basic_salary: "",
        hra_pct: "40",
        da_pct: "10",
        special_allowance: "0",
        transport_allowance: "0",
        medical_allowance: "0",
        pf_employee_pct: "12",
        esi_applicable: false,
        professional_tax: "200",
        tds_monthly: "0",
        designation: "",
        department: "",
        employee_id: "",
        date_of_joining: "",
        pan_number: "",
        pf_uan: "",
        bank_account: "",
        bank_name: "",
        bank_ifsc: "",
      });
    }
  }, [config, configLoading, selectedStaff]);

  const handleSave = async () => {
    if (!selectedStaff) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(formData)) {
        if (v !== "" && v !== null) payload[k] = v;
      }
      await upsertSalaryConfig(selectedStaff.uid, payload);
      toast.success("Salary config saved");
      qc.invalidateQueries({ queryKey: ["salary-config", selectedStaff.uid] });
      qc.invalidateQueries({ queryKey: ["payroll-staff"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: string, type = "number", hint?: string) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}{hint ? <span className="text-gray-400 ml-1">({hint})</span> : null}
      </label>
      <input
        type={type}
        value={String(formData[key] ?? "")}
        onChange={(e) => setFormData((f) => ({ ...f, [key]: e.target.value }))}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        placeholder={type === "number" ? "0" : ""}
      />
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {/* Staff List */}
      <div className="md:col-span-1">
        <h3 className="font-semibold text-gray-700 mb-3">Select Staff</h3>
        <input
          type="text"
          placeholder="Search by name or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        {staffLoading ? (
          <div className="text-center py-4 text-gray-400 text-sm">Loading...</div>
        ) : (
          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {staffList.map((s) => (
              <button
                key={s.uid}
                onClick={() => setSelectedStaff(s)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  selectedStaff?.uid === s.uid
                    ? "bg-teal-50 border border-teal-300 text-teal-800"
                    : "hover:bg-gray-50 border border-transparent"
                }`}
              >
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-gray-500 flex items-center gap-2">
                  <span>{s.department ?? s.role}</span>
                  {s.has_salary_config ? (
                    <span className="text-green-600">✓ Configured</span>
                  ) : (
                    <span className="text-orange-500">⚠ No config</span>
                  )}
                </div>
              </button>
            ))}
            {!staffLoading && staffList.length === 0 && (
              <div className="text-sm text-gray-400 text-center py-4">
                {search ? "No staff found" : "Start typing to search"}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Salary Config Form */}
      <div className="md:col-span-2">
        {!selectedStaff ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-center py-16">
            <div>
              <div className="text-4xl mb-3">💼</div>
              <div>Select a staff member to configure their salary</div>
            </div>
          </div>
        ) : configLoading ? (
          <div className="flex items-center justify-center h-40 text-gray-400">Loading config...</div>
        ) : (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-lg">
                {selectedStaff.name[0]}
              </div>
              <div>
                <div className="font-bold">{selectedStaff.name}</div>
                <div className="text-xs text-gray-500">{selectedStaff.department} · {selectedStaff.role}</div>
              </div>
            </div>

            <div className="space-y-4">
              {/* Salary Components */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2 border-b pb-1">💰 Salary Components (Monthly ₹)</h4>
                <div className="grid grid-cols-2 gap-3">
                  {field("Basic Salary *", "basic_salary")}
                  {field("HRA %", "hra_pct", "number", "% of basic")}
                  {field("DA %", "da_pct", "number", "% of basic")}
                  {field("Special Allowance", "special_allowance")}
                  {field("Transport Allowance", "transport_allowance")}
                  {field("Medical Allowance", "medical_allowance")}
                </div>
              </div>

              {/* Deductions */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2 border-b pb-1">📉 Deductions</h4>
                <div className="grid grid-cols-2 gap-3">
                  {field("PF Employee %", "pf_employee_pct", "number", "% of basic")}
                  {field("Professional Tax ₹", "professional_tax")}
                  {field("TDS Monthly ₹", "tds_monthly")}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">ESI Applicable</label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.esi_applicable === true || formData.esi_applicable === "true"}
                        onChange={(e) => setFormData((f) => ({ ...f, esi_applicable: e.target.checked }))}
                        className="w-4 h-4 text-teal-600"
                      />
                      <span className="text-sm text-gray-600">Yes (gross &lt; ₹21,000)</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Employment Details */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2 border-b pb-1">👤 Employment Details</h4>
                <div className="grid grid-cols-2 gap-3">
                  {field("Designation", "designation", "text")}
                  {field("Department", "department", "text")}
                  {field("Employee ID", "employee_id", "text")}
                  {field("Date of Joining", "date_of_joining", "date")}
                  {field("PF UAN", "pf_uan", "text")}
                  {field("PAN Number", "pan_number", "text", "full value required")}
                </div>
              </div>

              {/* Bank Details */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2 border-b pb-1">🏦 Bank Details</h4>
                {config?.bank_account && (
                  <div className="text-xs text-gray-500 bg-yellow-50 border border-yellow-200 rounded-lg p-2 mb-2">
                    Existing bank account: {config.bank_account} — enter new value only if changing
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {field("Account Number", "bank_account", "text", "leave blank to keep existing")}
                  {field("Bank Name", "bank_name", "text")}
                  {field("IFSC Code", "bank_ifsc", "text")}
                </div>
              </div>

              <button
                onClick={handleSave}
                disabled={saving || !formData.basic_salary}
                className="w-full bg-teal-700 text-white py-2.5 rounded-lg font-semibold hover:bg-teal-800 disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save Salary Configuration"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
