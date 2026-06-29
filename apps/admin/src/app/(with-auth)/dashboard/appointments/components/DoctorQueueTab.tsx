"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAvailableSlots,
  getTodayQueueAdmin,
  type AppointmentWorkflow,
  type SlotInfo,
} from "@/lib/api/appointments";
import { StatusBadge } from "./helpers";

function SlotAvailabilityPanel({ doctorId, date }: { doctorId: string; date: string }) {
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  useEffect(() => {
    if (!doctorId || !date) return;
    setLoading(true);
    setUnavailableReason(null);
    getAvailableSlots(doctorId, date)
      .then(res => {
        if (res.available === false) {
          setUnavailableReason(res.reason ?? "Unavailable");
          setSlots([]);
        } else {
          setSlots(res.slots ?? []);
        }
      })
      .catch(() => setSlots([]))
      .finally(() => setLoading(false));
  }, [doctorId, date]);

  if (loading) return <Skeleton className="h-16 w-full" />;
  if (unavailableReason) return (
    <div className="bg-yellow-50 border border-yellow-200 rounded px-4 py-3 text-sm text-yellow-800">
      ⚠️ {unavailableReason}
    </div>
  );
  if (!slots.length) return null;

  return (
    <div className="border rounded-lg p-4">
      <div className="text-sm font-medium mb-3 text-gray-700">
        Available Slots ({slots.filter(s => s.available).length}/{slots.length})
      </div>
      <div className="flex flex-wrap gap-2">
        {slots.map(s => (
          <span key={s.time}
            className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
              s.available
                ? "bg-teal-50 border-teal-300 text-teal-700"
                : "bg-gray-100 border-gray-200 text-gray-400 line-through"
            }`}>
            {s.time}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DoctorQueueTab() {
  const [doctorId, setDoctorId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [submittedDoctorId, setSubmittedDoctorId] = useState("");

  // isLoading (not isFetching) so a realtime ["queue"] invalidation refetches in
  // the background without blanking the loaded table to a skeleton — matches AllAppointmentsTab.
  const { data: queue = [], isLoading: loading } = useQuery({
    queryKey: ["queue", submittedDoctorId, date],
    queryFn: async () => {
      const res = await getTodayQueueAdmin<unknown>({ doctor_id: submittedDoctorId, ...(date ? { date } : {}) });
      const rows = Array.isArray(res) ? res
        : Array.isArray((res as Record<string, unknown>)?.data) ? (res as Record<string, unknown>).data : [];
      return rows as AppointmentWorkflow[];
    },
    enabled: !!submittedDoctorId,
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-sm font-medium block mb-1">Doctor ID</label>
          <input type="number" value={doctorId} onChange={e => setDoctorId(e.target.value)}
            className="border rounded px-3 py-2 text-sm w-36" placeholder="User ID" />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border rounded px-3 py-2 text-sm" />
        </div>
        <button
          onClick={() => {
            if (!doctorId) { toast.error("Enter a doctor ID"); return; }
            setSubmittedDoctorId(doctorId);
          }}
          className="bg-teal-600 text-white px-4 py-2 text-sm rounded hover:bg-teal-700">
          Load Queue
        </button>
      </div>

      {/* Slot availability panel */}
      {doctorId && date && <SlotAvailabilityPanel doctorId={doctorId} date={date} />}

      {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : queue.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {submittedDoctorId ? "No appointments found for this doctor/date" : "Enter a doctor ID to load their queue"}
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-teal-50 px-4 py-2 text-sm font-semibold text-teal-800">
            Dr. Queue — {date} ({queue.length} appointments)
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left">Token</th>
                <th className="px-4 py-2 text-left">Patient</th>
                <th className="px-4 py-2 text-left">Blood Group</th>
                <th className="px-4 py-2 text-left">Time</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Reason</th>
                <th className="px-4 py-2 text-left">Reminders</th>
              </tr>
            </thead>
            <tbody>
              {[...queue]
                .sort(
                  (a, b) =>
                    (Number(a.token_number) || 999) -
                    (Number(b.token_number) || 999),
                )
                .map((appt) => {
                  const a = appt as AppointmentWorkflow & { patient_name?: string; blood_group?: string; reminder_24h_sent?: boolean; reminder_1h_sent?: boolean };
                  return (
                    <tr key={a.id} className="border-b hover:bg-muted/20">
                      <td className="px-4 py-2 font-bold text-teal-700">
                        {a.token_number ? `#${a.token_number}` : "—"}
                      </td>
                      <td className="px-4 py-2 font-medium">{a.patient_name ?? `Patient #${a.patient_id}`}</td>
                      <td className="px-4 py-2">
                        {a.blood_group
                          ? <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{a.blood_group}</span>
                          : "—"}
                      </td>
                      <td className="px-4 py-2">{a.appointment_time ?? "—"}</td>
                      <td className="px-4 py-2"><StatusBadge status={a.status?.toUpperCase()} /></td>
                      <td className="px-4 py-2 max-w-xs truncate text-gray-600">{a.reason ?? "—"}</td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${a.reminder_24h_sent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>24h</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${a.reminder_1h_sent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>1h</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* Re-trigger walk-in from this tab if needed */}
      <p className="text-xs text-gray-500">
        Use the Walk-in button in the Overview tab or All Appointments tab to add new walk-ins.
      </p>
    </div>
  );
}
