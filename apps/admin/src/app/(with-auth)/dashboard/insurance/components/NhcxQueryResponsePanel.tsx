"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { fmtDate } from "./types";

export type NhcxQueryTarget = {
  type: "claim" | "preauth";
  id: number;
  label: string;
};

type NhcxDocument = {
  id: number;
  doc_type: string;
  file_name: string;
  file_size_bytes: number | string | null;
  mime_type: string | null;
  uploaded_at: string | null;
};

type NhcxCorrespondence = {
  id: number;
  direction: "inbound" | "outbound";
  channel: string;
  subject: string | null;
  body: string | null;
  recorded_at: string | null;
};

type NhcxWorkbench = {
  targetType: "claim" | "preauth";
  documents: NhcxDocument[];
  correspondence: NhcxCorrespondence[];
};

function workbenchPath(target: NhcxQueryTarget): string {
  const key = target.type === "claim" ? "claim_id" : "preauth_id";
  return `/admin/nhcx/communication/workbench?${key}=${target.id}`;
}

function fileSizeLabel(value: number | string | null): string {
  const size = Number(value ?? 0);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

export function NhcxQueryResponsePanel({
  target,
  onClose,
  onSubmitted,
}: {
  target: NhcxQueryTarget | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const qc = useQueryClient();
  const [responseText, setResponseText] = useState("");
  const [selectedDocIds, setSelectedDocIds] = useState<number[]>([]);

  useEffect(() => {
    setResponseText("");
    setSelectedDocIds([]);
  }, [target?.type, target?.id]);

  const {
    data,
    error,
    isFetching,
  } = useQuery<NhcxWorkbench>({
    queryKey: ["insurance", "nhcx-communication-workbench", target],
    enabled: Boolean(target),
    queryFn: async () => fetchAdminAPI<NhcxWorkbench>(workbenchPath(target!)),
  });

  const inboundQueries = useMemo(
    () => (data?.correspondence || []).filter((row) => row.direction === "inbound" && row.channel === "nhcx"),
    [data?.correspondence],
  );
  const activeQuery = inboundQueries[0] || null;

  const submitMut = useMutation({
    mutationFn: async () => fetchAdminAPI(`/admin/nhcx/communication/${activeQuery!.id}/respond`, {
      method: "POST",
      body: {
        response_text: responseText,
        document_ids: selectedDocIds,
      },
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["insurance", "nhcx-communication-workbench"] });
      onSubmitted();
      setResponseText("");
      setSelectedDocIds([]);
    },
  });

  if (!target) return null;

  const errMsg = (error ?? submitMut.error) instanceof Error
    ? (error ?? submitMut.error)!.toString()
    : null;
  const canSubmit = Boolean(activeQuery && responseText.trim()) && !submitMut.isPending;

  function toggleDoc(id: number) {
    setSelectedDocIds((current) => (
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    ));
  }

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm">Respond to NHCX query</h3>
          <p className="text-xs text-muted-foreground font-mono">{target.label}</p>
        </div>
        <button
          onClick={onClose}
          className="px-2 py-1 rounded border text-xs hover:bg-muted"
          type="button"
        >
          Close
        </button>
      </div>

      {errMsg && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {isFetching ? (
        <LoadingSpinner />
      ) : !activeQuery ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          No inbound NHCX query is open for this target.
        </div>
      ) : (
        <>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex justify-between gap-3 text-xs text-muted-foreground">
              <span>{activeQuery.subject || "NHCX query"}</span>
              <span>{fmtDate(activeQuery.recorded_at)}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{activeQuery.body || "—"}</p>
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground block">Response</label>
            <textarea
              value={responseText}
              onChange={(event) => setResponseText(event.target.value)}
              className="min-h-28 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">Attachments</div>
            {(data?.documents || []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No claim documents attached.</div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {(data?.documents || []).map((doc) => (
                  <label
                    key={doc.id}
                    className="flex items-start gap-2 rounded-md border p-2 text-sm hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedDocIds.includes(doc.id)}
                      onChange={() => toggleDoc(doc.id)}
                    />
                    <span>
                      <span className="block font-medium">{doc.file_name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {doc.doc_type}
                        {doc.mime_type ? ` · ${doc.mime_type}` : ""}
                        {fileSizeLabel(doc.file_size_bytes) ? ` · ${fileSizeLabel(doc.file_size_bytes)}` : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button
              disabled={!canSubmit}
              onClick={() => submitMut.mutate()}
              className="px-3 py-2 rounded-md bg-blue-600 text-sm text-white disabled:opacity-40"
              type="button"
            >
              Submit response
            </button>
          </div>
        </>
      )}
    </div>
  );
}
