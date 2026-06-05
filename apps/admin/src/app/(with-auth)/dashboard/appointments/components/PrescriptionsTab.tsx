"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fmtDate,
  fmtDateTime,
  isObj,
  StatusBadge,
  type EPrescription,
} from "./helpers";

export function PrescriptionsTab() {
  const [prescriptions, setPrescriptions] = useState<EPrescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<EPrescription | null>(null);
  const [filterDoctor] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const fetchPrescriptions = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filterDoctor) params.doctor_id = filterDoctor;
      if (filterFrom) params.from_date = filterFrom;
      if (filterTo) params.to_date = filterTo;
      const qs = new URLSearchParams(params).toString();
      const res = await fetchAdminAPI(
        `/prescriptions/all${qs ? `?${qs}` : ""}`,
      );
      const raw = Array.isArray(res)
        ? res
        : isObj(res)
          ? ((res as Record<string, unknown>).prescriptions ??
            (res as Record<string, unknown>).data ??
            res)
          : [];
      const data = Array.isArray(raw) ? (raw as EPrescription[]) : [];
      setPrescriptions(data);
    } catch {
      toast.error("Failed to load prescriptions");
    } finally {
      setLoading(false);
    }
  }, [filterDoctor, filterFrom, filterTo]);

  useEffect(() => {
    fetchPrescriptions();
  }, [fetchPrescriptions]);

  const freqLabel: Record<string, string> = {
    OD: "Once daily",
    BD: "Twice daily",
    TDS: "Thrice daily",
    QID: "Four times",
    SOS: "As needed",
    HS: "At bedtime",
    STAT: "Immediately",
  };

  if (selected) {
    const rx = selected;
    return (
      <div>
        <button
          onClick={() => setSelected(null)}
          className="text-sm text-teal-600 mb-4 hover:underline"
        >
          ← Back to list
        </button>
        <div className="bg-card rounded-lg border p-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="text-xl font-bold">{rx.prescription_number}</h3>
              <p className="text-sm text-gray-500">
                Patient: {rx.patient_name} • {rx.patient_phone}
              </p>
              <p className="text-sm text-gray-500">
                Dr. {rx.doctor_name} • {rx.doctor_specialization}
              </p>
              <p className="text-sm text-gray-400">
                {fmtDateTime(rx.created_at)}
              </p>
            </div>
            <div className="flex gap-2">
              <StatusBadge status={rx.status} />
              {rx.pharmacy_opted && (
                <span className="px-2 py-1 rounded-full text-xs bg-green-100 text-green-700">
                  Pharmacy: {rx.pharmacy_opt_type}
                </span>
              )}
            </div>
          </div>

          {rx.diagnosis && (
            <div className="mb-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">
                Diagnosis
              </h4>
              <p className="text-sm">{rx.diagnosis}</p>
            </div>
          )}

          {rx.vitals && Object.keys(rx.vitals).length > 0 && (
            <div className="mb-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">
                Vitals
              </h4>
              <div className="flex flex-wrap gap-3 text-sm">
                {rx.vitals.bp_systolic && rx.vitals.bp_diastolic && (
                  <span>
                    BP: {rx.vitals.bp_systolic}/{rx.vitals.bp_diastolic}
                  </span>
                )}
                {rx.vitals.pulse && <span>Pulse: {rx.vitals.pulse}</span>}
                {rx.vitals.temperature && (
                  <span>Temp: {rx.vitals.temperature}°F</span>
                )}
                {rx.vitals.spo2 && <span>SpO2: {rx.vitals.spo2}%</span>}
                {rx.vitals.weight && <span>Weight: {rx.vitals.weight}kg</span>}
                {rx.vitals.blood_sugar && (
                  <span>Sugar: {rx.vitals.blood_sugar}</span>
                )}
              </div>
            </div>
          )}

          <div className="mb-4">
            <h4 className="font-semibold text-sm text-gray-700 mb-2">
              Medications ({rx.medications.length})
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2 border-b">#</th>
                    <th className="text-left p-2 border-b">Medicine</th>
                    <th className="text-left p-2 border-b">Dosage</th>
                    <th className="text-left p-2 border-b">Frequency</th>
                    <th className="text-left p-2 border-b">Duration</th>
                    <th className="text-left p-2 border-b">Route</th>
                    <th className="text-left p-2 border-b">Instructions</th>
                  </tr>
                </thead>
                <tbody>
                  {rx.medications.map((m, i) => (
                    <tr
                      key={i}
                      className={i % 2 === 0 ? "bg-card" : "bg-gray-50"}
                    >
                      <td className="p-2 border-b">{i + 1}</td>
                      <td className="p-2 border-b font-medium">
                        {m.name}
                        {m.generic_name ? ` (${m.generic_name})` : ""}
                      </td>
                      <td className="p-2 border-b">{m.dosage || "-"}</td>
                      <td className="p-2 border-b">
                        {freqLabel[m.frequency] || m.frequency || "-"}
                      </td>
                      <td className="p-2 border-b">{m.duration || "-"}</td>
                      <td className="p-2 border-b">{m.route || "Oral"}</td>
                      <td className="p-2 border-b">{m.instructions || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {rx.follow_up_date && (
            <div className="mb-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">
                Follow-up
              </h4>
              <p className="text-sm">
                {fmtDate(rx.follow_up_date)}
                {rx.follow_up_notes ? ` — ${rx.follow_up_notes}` : ""}
              </p>
            </div>
          )}

          {rx.clinical_notes && (
            <div className="mb-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">
                Clinical Notes
              </h4>
              <p className="text-sm">{rx.clinical_notes}</p>
            </div>
          )}

          {rx.pdf_url && (
            <a
              href={rx.pdf_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-teal-600 hover:underline"
            >
              📄 Download PDF
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="date"
          value={filterFrom}
          onChange={(e) => setFilterFrom(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm"
          placeholder="From"
        />
        <input
          type="date"
          value={filterTo}
          onChange={(e) => setFilterTo(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm"
          placeholder="To"
        />
        <button
          onClick={fetchPrescriptions}
          className="bg-teal-600 text-white px-4 py-1.5 rounded text-sm hover:bg-teal-700"
        >
          Filter
        </button>
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : prescriptions.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-2">📋</p>
          <p>No prescriptions found</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-3 border-b">RX #</th>
                <th className="text-left p-3 border-b">Patient</th>
                <th className="text-left p-3 border-b">Doctor</th>
                <th className="text-left p-3 border-b">Date</th>
                <th className="text-left p-3 border-b">Medicines</th>
                <th className="text-left p-3 border-b">Pharmacy</th>
                <th className="text-left p-3 border-b">Status</th>
              </tr>
            </thead>
            <tbody>
              {prescriptions.map((rx) => (
                <tr
                  key={rx.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => setSelected(rx)}
                >
                  <td className="p-3 border-b font-mono text-teal-600">
                    {rx.prescription_number}
                  </td>
                  <td className="p-3 border-b">{rx.patient_name}</td>
                  <td className="p-3 border-b">{rx.doctor_name}</td>
                  <td className="p-3 border-b">{fmtDate(rx.created_at)}</td>
                  <td className="p-3 border-b">{rx.medications.length}</td>
                  <td className="p-3 border-b">
                    {rx.pharmacy_opted ? (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">
                        {rx.pharmacy_opt_type || "ordered"}
                      </span>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                  <td className="p-3 border-b">
                    <StatusBadge status={rx.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
