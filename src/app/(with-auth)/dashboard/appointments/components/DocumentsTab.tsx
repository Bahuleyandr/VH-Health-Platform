"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAllAppointmentDocuments,
  type AppointmentDocument,
} from "@/lib/api/appointments";
import { fmtDate } from "./helpers";

export function DocumentsTab() {
  const [docs, setDocs] = useState<AppointmentDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (fromDate) params.from_date = fromDate;
      if (toDate) params.to_date = toDate;
      const res = await getAllAppointmentDocuments(params);
      setDocs(Array.isArray(res) ? res : []);
    } catch {
      toast.error("Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-center">
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        <button onClick={load} className="bg-primary text-white text-sm px-4 py-1.5 rounded">Filter</button>
      </div>

      {loading ? <Skeleton className="h-48 w-full" /> : docs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No documents found</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50"><th className="px-4 py-2 text-left">Patient</th><th className="px-4 py-2 text-left">Doctor</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">File</th><th className="px-4 py-2 text-left">Uploaded By</th><th className="px-4 py-2 text-left">Date</th><th className="px-4 py-2 text-left">Download</th></tr></thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className="border-b hover:bg-muted/20">
                  <td className="px-4 py-2">{doc.patient_name ?? `Patient #${doc.patient_id}`}</td>
                  <td className="px-4 py-2">{doc.doctor_name ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                      {doc.document_type?.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-2 max-w-xs truncate">{doc.file_name ?? "—"}</td>
                  <td className="px-4 py-2">{doc.uploaded_by_name ?? "—"} <span className="text-xs text-gray-400">({doc.upload_role})</span></td>
                  <td className="px-4 py-2">{fmtDate(doc.created_at)}</td>
                  <td className="px-4 py-2">
                    {doc.file_url ? (
                      <a href={doc.file_url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline">Download</a>
                    ) : "—"}
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
