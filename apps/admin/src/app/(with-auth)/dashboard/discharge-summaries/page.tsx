// src/app/(with-auth)/dashboard/discharge-summaries/page.tsx
//
// Discharge summary builder — Sprint 11. Lists pending summaries
// (draft + ready_for_signoff), opens a section editor that lets the
// user edit each section in place, mark ready, and sign off.

"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface PendingSummary {
  id: number;
  patient_uid: string;
  patient_name_snapshot: string | null;
  primary_diagnosis: string | null;
  admitted_at: string | null;
  discharged_at: string | null;
  status: "draft" | "ready_for_signoff" | "signed" | "delivered";
  created_at: string;
  updated_at: string;
}

interface SummarySection {
  id: number;
  section_key: string;
  section_title: string;
  display_order: number;
  body: string | null;
  edited_at: string | null;
}

interface SummaryDetail {
  id: number;
  patient_uid: string;
  patient_name_snapshot: string | null;
  primary_diagnosis: string | null;
  status: "draft" | "ready_for_signoff" | "signed" | "delivered";
  signed_by_name: string | null;
  signed_by_reg: string | null;
  signed_at: string | null;
  delivery_method: string | null;
  delivered_at: string | null;
  sections: SummarySection[];
}

const STATUS_COLOURS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  ready_for_signoff: "bg-amber-100 text-amber-800",
  signed: "bg-emerald-100 text-emerald-800",
  delivered: "bg-emerald-200 text-emerald-900",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

export default function DischargeSummariesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);

  const { data: pending = [], error: listError, isLoading } =
    useQuery<PendingSummary[]>({
      queryKey: ["discharge", "pending"],
      queryFn: async () => {
        const r = await fetchAdminAPI<unknown>(
          "/discharge-summaries/pending?limit=100",
        );
        const data = unwrap<PendingSummary[]>(r);
        return Array.isArray(data) ? data : [];
      },
      refetchInterval: 60_000,
    });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Discharge Summaries</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Drafts awaiting completion + ready-for-sign-off queue. Auto-refreshes
          every 60s.
        </p>
      </div>

      {listError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {listError instanceof Error ? listError.message : "Failed to load"}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : pending.length === 0 ? (
        <EmptyState
          title="Inbox zero"
          description="No discharge summaries pending."
        />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Diagnosis</th>
                <th className="px-3 py-2">Admitted</th>
                <th className="px-3 py-2">Discharged</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Updated</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((s) => (
                <tr key={s.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2 text-xs">
                    {s.patient_name_snapshot ?? s.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {s.primary_diagnosis ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtTs(s.admitted_at)}</td>
                  <td className="px-3 py-2 text-xs">{fmtTs(s.discharged_at)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[s.status] ?? ""
                      }`}
                    >
                      {s.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtTs(s.updated_at)}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setOpen(s.id)}
                      className="px-2 py-1 rounded border text-xs hover:bg-muted"
                    >
                      Open →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open !== null && (
        <SummaryEditor
          id={open}
          onClose={() => {
            setOpen(null);
            qc.invalidateQueries({ queryKey: ["discharge", "pending"] });
          }}
        />
      )}
    </div>
  );
}

function SummaryEditor({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [signedByName, setSignedByName] = useState("");
  const [signedByReg, setSignedByReg] = useState("");

  const { data: detail, isLoading } = useQuery<SummaryDetail>({
    queryKey: ["discharge", "detail", id],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(`/discharge-summaries/${id}`);
      return unwrap<SummaryDetail>(r);
    },
  });

  const editMut = useMutation({
    mutationFn: async (vars: { key: string; body: string }) =>
      fetchAdminAPI(`/discharge-summaries/${id}/sections/${vars.key}`, {
        method: "PATCH",
        body: JSON.stringify({ body: vars.body }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discharge", "detail", id] }),
  });

  const readyMut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI(`/discharge-summaries/${id}/ready`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discharge", "detail", id] }),
  });

  const signMut = useMutation({
    mutationFn: async () => {
      if (!signedByName) throw new Error("Doctor name is required to sign");
      return fetchAdminAPI(`/discharge-summaries/${id}/sign`, {
        method: "POST",
        body: JSON.stringify({
          signed_by_name: signedByName,
          signed_by_reg: signedByReg || undefined,
        }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discharge", "detail", id] }),
  });

  const deliverMut = useMutation({
    mutationFn: async (method: string) =>
      fetchAdminAPI(`/discharge-summaries/${id}/deliver`, {
        method: "POST",
        body: JSON.stringify({ delivery_method: method }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discharge", "detail", id] }),
  });

  const errMsg = (
    editMut.error ?? readyMut.error ?? signMut.error ?? deliverMut.error
  )?.toString();

  function saveSection(key: string) {
    const body = drafts[key];
    if (body === undefined) return;
    editMut.mutate({ key, body });
  }

  if (isLoading || !detail) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
        <LoadingSpinner />
      </div>
    );
  }

  const editable = detail.status === "draft" || detail.status === "ready_for_signoff";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-4xl mb-8">
        <div className="p-4 border-b flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {detail.patient_name_snapshot ?? detail.patient_uid.slice(0, 8)}
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              {detail.primary_diagnosis ?? "—"}
            </p>
            <span
              className={`inline-block px-2 py-0.5 rounded text-xs font-medium mt-2 ${
                STATUS_COLOURS[detail.status] ?? ""
              }`}
            >
              {detail.status.replace(/_/g, " ")}
            </span>
            {detail.signed_by_name && (
              <p className="text-xs text-muted-foreground mt-1">
                Signed by {detail.signed_by_name}
                {detail.signed_by_reg ? ` (${detail.signed_by_reg})` : ""} on{" "}
                {fmtTs(detail.signed_at)}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {detail.sections.map((s) => {
            const draft = drafts[s.section_key];
            const value = draft ?? s.body ?? "";
            const dirty = draft !== undefined && draft !== (s.body ?? "");
            return (
              <div key={s.id} className="border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-sm">{s.section_title}</h3>
                  {editable && dirty && (
                    <button
                      onClick={() => saveSection(s.section_key)}
                      disabled={editMut.isPending}
                      className="px-2 py-1 rounded bg-blue-600 text-white text-xs disabled:opacity-40"
                    >
                      {editMut.isPending ? "Saving…" : "Save"}
                    </button>
                  )}
                </div>
                <textarea
                  value={value}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [s.section_key]: e.target.value })
                  }
                  disabled={!editable}
                  rows={Math.max(3, value.split("\n").length + 1)}
                  className="w-full border rounded px-2 py-1 text-sm font-mono"
                />
                {s.edited_at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    last edited {fmtTs(s.edited_at)}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {errMsg && (
          <div className="mx-4 mb-3 p-2 rounded border border-destructive/30 bg-destructive/5 text-xs text-destructive">
            {errMsg}
          </div>
        )}

        <div className="p-4 border-t space-y-3">
          {detail.status === "draft" && (
            <button
              onClick={() => readyMut.mutate()}
              disabled={readyMut.isPending}
              className="w-full px-3 py-2 rounded-md border text-sm hover:bg-muted disabled:opacity-40"
            >
              {readyMut.isPending ? "Marking…" : "Mark ready for sign-off"}
            </button>
          )}

          {(detail.status === "draft" || detail.status === "ready_for_signoff") && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  Doctor name
                </label>
                <input
                  value={signedByName}
                  onChange={(e) => setSignedByName(e.target.value)}
                  placeholder="Dr. ..."
                  className="w-full border rounded px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  Council reg #
                </label>
                <input
                  value={signedByReg}
                  onChange={(e) => setSignedByReg(e.target.value)}
                  placeholder="MCI/SMC"
                  className="w-full border rounded px-2 py-1.5 text-sm"
                />
              </div>
              <button
                onClick={() => signMut.mutate()}
                disabled={signMut.isPending || !signedByName}
                className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
              >
                {signMut.isPending ? "Signing…" : "Sign discharge summary"}
              </button>
            </div>
          )}

          {detail.status === "signed" && (
            <div className="flex gap-2 flex-wrap">
              {(["printed", "email", "whatsapp", "abdm"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => deliverMut.mutate(m)}
                  disabled={deliverMut.isPending}
                  className="px-3 py-2 rounded-md border text-sm hover:bg-muted disabled:opacity-40"
                >
                  Mark delivered: {m}
                </button>
              ))}
            </div>
          )}

          {detail.status === "delivered" && (
            <p className="text-sm text-emerald-700">
              Delivered to patient via {detail.delivery_method} on{" "}
              {fmtTs(detail.delivered_at)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
