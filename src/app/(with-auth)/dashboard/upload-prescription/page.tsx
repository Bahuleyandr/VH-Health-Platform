// src/app/(with-auth)/dashboard/upload-prescription/page.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/api-config';

interface CompletedAppointment {
  id: number;
  patient_name: string;
  appointment_date: string;
  appointment_time: string;
}

interface PrescriptionUpload {
  id: number;
  appointment_id: number;
  patient_name: string;
  type: string;
  file_name: string;
  uploaded_at: string;
}

const DOC_TYPES = ['PRESCRIPTION', 'LAB_REPORT', 'RADIOLOGY', 'OTHER'];

export default function UploadPrescriptionPage() {
  const searchParams = useSearchParams();
  const preselectedId = searchParams.get('appointmentId');

  const [appointments, setAppointments] = useState<CompletedAppointment[]>([]);
  const [recentUploads, setRecentUploads] = useState<PrescriptionUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [selectedAppt, setSelectedAppt] = useState<string>(preselectedId ?? '');
  const [docType, setDocType] = useState('PRESCRIPTION');
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auth is carried via the httpOnly auth_token cookie handled by /api/proxy.
  const authHeaders: HeadersInit = {};

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [apptRes, uploadsRes] = await Promise.allSettled([
        fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.prescriptions.completedAppointments}`, { headers: authHeaders }),
        fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.prescriptions.myUploads}`, { headers: authHeaders }),
      ]);
      if (apptRes.status === 'fulfilled' && apptRes.value.ok) {
        const d = await apptRes.value.json() as { data?: CompletedAppointment[]; appointments?: CompletedAppointment[] } | CompletedAppointment[];
        const items = Array.isArray(d) ? d : ((d as { data?: CompletedAppointment[] }).data ?? (d as { appointments?: CompletedAppointment[] }).appointments ?? []);
        setAppointments(items);
      }
      if (uploadsRes.status === 'fulfilled' && uploadsRes.value.ok) {
        const d = await uploadsRes.value.json() as { data?: PrescriptionUpload[]; uploads?: PrescriptionUpload[] } | PrescriptionUpload[];
        const items = Array.isArray(d) ? d : ((d as { data?: PrescriptionUpload[] }).data ?? (d as { uploads?: PrescriptionUpload[] }).uploads ?? []);
        setRecentUploads(items);
      }
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleUpload = async () => {
    if (!file || !selectedAppt) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('appointment_id', selectedAppt);
      formData.append('type', docType);
      formData.append('notes', notes);

      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.prescriptions.upload}`, {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });
      if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
      setSuccessMsg('Document uploaded successfully.');
      setFile(null);
      setNotes('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await fetchData();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Upload Prescription / Document</h1>

      {successMsg && (
        <div className="rounded bg-green-500/10 border border-green-500/30 px-4 py-2 text-sm text-green-400 flex items-center justify-between">
          {successMsg}
          <button className="ml-4 text-xs opacity-60 hover:opacity-100" onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}
      {error && (
        <div className="rounded bg-red-500/10 border border-red-500/30 px-4 py-2 text-sm text-red-400">{error}</div>
      )}

      {/* Upload Form */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-white">Upload New Document</h2>

        <label className="block text-sm text-muted-foreground">
          Appointment
          <select
            value={selectedAppt}
            onChange={e => setSelectedAppt(e.target.value)}
            className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white"
          >
            <option value="">— Select a completed appointment —</option>
            {loading && <option disabled>Loading…</option>}
            {appointments.map(a => (
              <option key={a.id} value={String(a.id)}>
                {a.patient_name} · {a.appointment_date} {a.appointment_time}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm text-muted-foreground">
          Document Type
          <select
            value={docType}
            onChange={e => setDocType(e.target.value)}
            className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white"
          >
            {DOC_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </select>
        </label>

        <label className="block text-sm text-muted-foreground">
          File (PDF, JPG, PNG)
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-indigo-500"
          />
        </label>

        <label className="block text-sm text-muted-foreground">
          Notes (optional)
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white"
          />
        </label>

        <button
          onClick={() => void handleUpload()}
          disabled={uploading || !file || !selectedAppt}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : '↑ Upload Document'}
        </button>
      </div>

      {/* Recent Uploads */}
      <div className="space-y-3">
        <h2 className="font-semibold text-white">Recent Uploads</h2>
        {!loading && recentUploads.length === 0 && (
          <p className="text-muted-foreground text-sm">No uploads yet.</p>
        )}
        {recentUploads.map(upload => (
          <div key={upload.id} className="rounded-lg border border-border bg-card p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-white text-sm">{upload.file_name}</p>
              <p className="text-xs text-muted-foreground">
                {upload.type.replace('_', ' ')} · Patient: {upload.patient_name}
              </p>
              <p className="text-xs text-muted-foreground">{new Date(upload.uploaded_at).toLocaleString()}</p>
            </div>
            <span className="rounded-full bg-teal-500/20 text-teal-400 px-2.5 py-0.5 text-xs font-medium">
              {upload.type}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
