"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "react-hot-toast";
import {
  getBookingQueue,
  getBookingSLA,
  confirmBooking,
  dispatchCollectorBooking,
  markBookingCollected,
  startBookingProcessing,
  uploadBookingResult,
  type InvestigationBooking,
  type BookingSLADashboard,
} from "@/lib/api/investigations";
import { Chip, SlaCard, statusColor } from "./helpers";

export function LabBookingsTab() {
  const [sla, setSla] = useState<BookingSLADashboard | null>(null);
  const [bookings, setBookings] = useState<InvestigationBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      if (typeFilter) params.collection_type = typeFilter;
      const [slaData, queueData] = await Promise.all([
        getBookingSLA().catch(() => null),
        getBookingQueue(params),
      ]);
      setSla(slaData);
      setBookings(Array.isArray(queueData) ? queueData : []);
    } catch {
      toast.error("Failed to load lab bookings");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleConfirm = async (id: number) => {
    const notes = prompt("Confirmation notes (optional):");
    if (notes === null) return;
    setActionLoading(id);
    try {
      await confirmBooking(id, { confirmation_notes: notes || undefined });
      toast.success("Booking confirmed");
      await fetchData();
    } catch {
      toast.error("Failed to confirm");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDispatch = async (id: number) => {
    const phone = prompt("Collector phone (optional):");
    if (phone === null) return;
    setActionLoading(id);
    try {
      await dispatchCollectorBooking(id, { collector_phone: phone || undefined });
      toast.success("Collector dispatched");
      await fetchData();
    } catch {
      toast.error("Failed to dispatch");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCollected = async (id: number) => {
    setActionLoading(id);
    try {
      await markBookingCollected(id);
      toast.success("Samples collected");
      await fetchData();
    } catch {
      toast.error("Failed to update");
    } finally {
      setActionLoading(null);
    }
  };

  const handleProcessing = async (id: number) => {
    setActionLoading(id);
    try {
      await startBookingProcessing(id);
      toast.success("Processing started");
      await fetchData();
    } catch {
      toast.error("Failed to update");
    } finally {
      setActionLoading(null);
    }
  };

  const handleUploadResult = async (id: number) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.jpg,.png,.doc,.docx";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const notes = prompt("Result notes (optional):") ?? undefined;
      setActionLoading(id);
      try {
        await uploadBookingResult(id, file, notes);
        toast.success("Result uploaded");
        await fetchData();
      } catch {
        toast.error("Upload failed");
      } finally {
        setActionLoading(null);
      }
    };
    input.click();
  };

  const renderActions = (b: InvestigationBooking) => {
    const isLoading = actionLoading === b.id;
    if (isLoading) return <span className="text-xs text-muted-foreground">Processing...</span>;

    switch (b.status) {
      case "BOOKED":
        return (
          <button onClick={() => handleConfirm(b.id)} className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">
            Confirm
          </button>
        );
      case "CONFIRMED":
        return (
          <button onClick={() => handleDispatch(b.id)} className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700">
            Dispatch
          </button>
        );
      case "DISPATCHED":
        return (
          <button onClick={() => handleCollected(b.id)} className="px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700">
            Mark Collected
          </button>
        );
      case "COLLECTED":
        return (
          <button onClick={() => handleProcessing(b.id)} className="px-2 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700">
            Start Processing
          </button>
        );
      case "PROCESSING":
        return (
          <button onClick={() => handleUploadResult(b.id)} className="px-2 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700">
            Upload Result
          </button>
        );
      case "RESULT_READY":
        return b.result_file_url ? (
          <a href={b.result_file_url} target="_blank" rel="noopener noreferrer" className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">
            View Result
          </a>
        ) : <span className="text-xs text-muted-foreground">Done</span>;
      default:
        return null;
    }
  };

  const statuses = ["BOOKED", "CONFIRMED", "DISPATCHED", "COLLECTED", "PROCESSING", "RESULT_READY"];

  if (loading) return <p className="text-center py-8 text-muted-foreground">Loading...</p>;

  return (
    <div className="space-y-6">
      {/* SLA Overview */}
      {sla && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">SLA Overview</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <SlaCard label="Total Bookings" value={sla.summary.total} />
            <SlaCard label="Pending Confirm" value={sla.summary.booked} color={Number(sla.summary.booked) > 0 ? "text-orange-600" : undefined} />
            <SlaCard label="In Progress" value={String(Number(sla.summary.confirmed || 0) + Number(sla.summary.dispatched || 0) + Number(sla.summary.collected || 0) + Number(sla.summary.processing || 0))} />
            <SlaCard label="Results Ready" value={sla.summary.result_ready} color="text-green-600" />
            <SlaCard label="SLA Breaches" value={String(sla.sla_breaches)} color={sla.sla_breaches > 0 ? "text-red-600" : undefined} />
            <SlaCard label="Revenue" value={`₹${Number(sla.summary.total_revenue || 0).toLocaleString()}`} />
          </div>
          {/* Average Times */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SlaCard label="Avg Confirm" value={sla.avg_times.avg_confirm_mins ? `${Number(sla.avg_times.avg_confirm_mins).toFixed(0)} min` : "—"} />
            <SlaCard label="Avg Dispatch" value={sla.avg_times.avg_dispatch_mins ? `${Number(sla.avg_times.avg_dispatch_mins).toFixed(0)} min` : "—"} />
            <SlaCard label="Avg Collect" value={sla.avg_times.avg_collect_mins ? `${Number(sla.avg_times.avg_collect_mins).toFixed(0)} min` : "—"} />
            <SlaCard label="Avg Result" value={sla.avg_times.avg_result_hours ? `${Number(sla.avg_times.avg_result_hours).toFixed(1)} hrs` : "—"} />
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="">All Statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="">All Types</option>
          <option value="home">Home Collection</option>
          <option value="walk_in">Walk-in</option>
        </select>
        <button
          onClick={() => void fetchData()}
          className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:opacity-90"
        >
          Refresh
        </button>
      </div>

      {/* Active Bookings Table */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2">Booking #</th>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Tests</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">ETA</th>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Cost</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {bookings.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">No bookings found</td></tr>
            ) : (
              bookings.map((b) => {
                const isBreach = b.sla_breached;
                const testDisplay = b.test_names?.join(", ") || b.custom_test_names || (b.slip_photo_key ? "📋 Slip" : "—");
                const mins = b.mins_since_booked ?? 0;
                const timeStr = mins > 60 ? `${(mins / 60).toFixed(1)}h` : `${Math.round(mins)}m`;
                return (
                  <tr key={b.id} className={`border-b ${isBreach ? "bg-red-50" : "hover:bg-muted/30"}`}>
                    <td className="px-3 py-2 font-mono text-xs">{b.booking_number}</td>
                    <td className="px-3 py-2">{b.patient_name ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{b.patient_phone ?? "—"}</td>
                    <td className="px-3 py-2 text-xs max-w-[200px] truncate" title={testDisplay}>{testDisplay}</td>
                    <td className="px-3 py-2">
                      <Chip
                        label={b.collection_type === "home" ? "🏠 Home" : "🏥 Walk-in"}
                        className={b.collection_type === "home" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Chip
                        label={b.status.replace("_", " ")}
                        className={statusColor(b.status)}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {b.status === "DISPATCHED" && b.estimated_collection_mins ? (
                        <span className="flex items-center gap-1">
                          {b.collection_tracking_active && <span title="Live tracking">📍</span>}
                          ~{b.estimated_collection_mins}m
                          {b.collection_distance_km ? <span className="text-muted-foreground ml-1">({b.collection_distance_km}km)</span> : null}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {timeStr}
                      {isBreach && <span className="ml-1 text-red-600" title="SLA Breached">⚠️</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      ₹{b.final_cost ?? b.estimated_cost ?? "—"}
                    </td>
                    <td className="px-3 py-2">{renderActions(b)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
