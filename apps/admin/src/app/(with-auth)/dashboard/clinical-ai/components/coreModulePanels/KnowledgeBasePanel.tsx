"use client";

/**
 * Phase A1 PR4 — KB admin panel.
 *
 * Three concerns wired together:
 *   1. KB CRUD (create, list, archive/unarchive, edit description).
 *   2. Selected-KB context: inline-text document ingestion (with the S1
 *      prompt-injection gate) + document list / reindex / delete +
 *      access-policy management.
 *   3. Retrieval tester: query, role, KB filter, top-K + min-score; shows
 *      ranked chunks and (when applicable) the cause of empty results
 *      (embed_unavailable / corpus_unavailable / no_access).
 *
 * File upload is intentionally deferred to a follow-up — the backend
 * accepts multipart but we keep the admin-side scope here to inline
 * text paste. Most hospitals start by pasting their SOP / antibiotic
 * policy text anyway; PDF ingest is a small follow-up PR.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, BookOpen, FileText, Plus, RotateCcw, Search, Shield, Trash2, Undo2, Upload } from "lucide-react";
import { toast } from "react-hot-toast";

import {
  archiveKnowledgeBase,
  createInlineKnowledgeDocument,
  createKnowledgeBase,
  deleteKnowledgeDocument,
  grantKnowledgeAccess,
  listKnowledgeAccessPolicies,
  listKnowledgeBases,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
  retrieveFromKnowledgeBases,
  revokeKnowledgeAccess,
  unarchiveKnowledgeBase,
  uploadKnowledgeBaseDocument,
  type KnowledgeBase,
  type KnowledgeBasePermission,
  type KnowledgeBaseStatus,
  type KnowledgeBaseType,
  type KnowledgeDocument,
  type KnowledgeDocumentIngestResult,
  type KnowledgeDocumentStatus,
} from "@/lib/api/clinicalAiAdmin";

// Mirror the backend's multer allow-list + 25 MB cap so client-side
// validation rejects bad uploads before the round-trip.
const KB_UPLOAD_ACCEPT =
  "application/pdf,image/jpeg,image/png,image/webp,image/tiff,image/bmp,text/plain,text/markdown,text/csv,application/json";
const KB_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const KB_TYPES: KnowledgeBaseType[] = [
  "general",
  "sop",
  "antibiotic_policy",
  "patient_education",
  "clinical_guideline",
  "formulary",
  "safety_alert",
  "training",
];

const PERMISSIONS: KnowledgeBasePermission[] = ["read", "write", "manage"];

const COMMON_ROLES = [
  "DOCTOR",
  "NURSING_STAFF",
  "PHARMACY_STAFF",
  "LAB_STAFF",
  "RADIOLOGY_STAFF",
  "ADMIN",
  "MEDICAL_RECORDS",
  "BILLING_STAFF",
];

function statusBadgeClass(status: KnowledgeBaseStatus | KnowledgeDocumentStatus | string) {
  switch (status) {
    case "active":
    case "indexed":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "archived":
      return "border-slate-200 bg-slate-100 text-slate-700";
    case "blocked":
    case "failed":
      return "border-red-200 bg-red-50 text-red-800";
    case "embedding":
    case "chunking":
    case "extracting":
      return "border-blue-200 bg-blue-50 text-blue-800";
    case "pending":
    default:
      return "border-amber-200 bg-amber-50 text-amber-800";
  }
}

function fmt(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export function KnowledgeBasePanel() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<KnowledgeBaseStatus | "all">("active");
  const [selectedKbId, setSelectedKbId] = useState<number | null>(null);

  const kbList = useQuery({
    queryKey: ["clinical-ai", "knowledge-bases", statusFilter],
    queryFn: () =>
      listKnowledgeBases(statusFilter === "all" ? {} : { status: statusFilter }),
  });

  const kbs: KnowledgeBase[] = useMemo(
    () => kbList.data?.knowledge_bases ?? [],
    [kbList.data?.knowledge_bases],
  );

  // Auto-pick first active KB when the list loads / changes.
  useEffect(() => {
    if (selectedKbId == null && kbs.length) {
      setSelectedKbId(kbs[0].id);
    } else if (selectedKbId != null && !kbs.some((kb) => kb.id === selectedKbId)) {
      setSelectedKbId(kbs[0]?.id ?? null);
    }
  }, [kbs, selectedKbId]);

  const selectedKb = kbs.find((kb) => kb.id === selectedKbId) ?? null;

  return (
    <section className="space-y-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Knowledge Bases</h2>
        </div>
        <div className="flex items-center gap-2">
          {(["active", "archived", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatusFilter(value)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                statusFilter === value
                  ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                  : "border-border bg-card hover:bg-accent"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </header>

      <CreateKbForm
        onCreated={(kb) => {
          queryClient.invalidateQueries({ queryKey: ["clinical-ai", "knowledge-bases"] });
          setSelectedKbId(kb.id);
        }}
      />

      <KbListTable
        loading={kbList.isLoading}
        kbs={kbs}
        selectedKbId={selectedKbId}
        onSelect={(id) => setSelectedKbId(id)}
        onArchive={async (kb) => {
          try {
            if (kb.status === "archived") {
              await unarchiveKnowledgeBase(kb.id);
              toast.success(`Restored "${kb.name}"`);
            } else {
              await archiveKnowledgeBase(kb.id);
              toast.success(`Archived "${kb.name}"`);
            }
            queryClient.invalidateQueries({ queryKey: ["clinical-ai", "knowledge-bases"] });
          } catch (err) {
            toast.error((err as Error).message || "Could not flip archive state");
          }
        }}
      />

      {selectedKb ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold">{selectedKb.name}</h3>
              <p className="text-xs text-muted-foreground">
                {selectedKb.kb_type} · {selectedKb.document_count ?? 0} document
                {(selectedKb.document_count ?? 0) === 1 ? "" : "s"}
                {selectedKb.chunk_count != null ? ` · ${selectedKb.chunk_count} chunks` : ""}
              </p>
            </div>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(selectedKb.status)}`}>
              {selectedKb.status}
            </span>
          </div>

          <KbDocumentSection knowledgeBaseId={selectedKb.id} />
          <KbAccessSection knowledgeBaseId={selectedKb.id} />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Create or select a knowledge base above to manage its documents and access.
        </div>
      )}

      <KbRetrievalTester kbs={kbs.filter((kb) => kb.status === "active")} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-sections
// ---------------------------------------------------------------------------

function CreateKbForm({ onCreated }: { onCreated: (kb: KnowledgeBase) => void }) {
  const [name, setName] = useState("");
  const [kbType, setKbType] = useState<KnowledgeBaseType>("general");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () =>
      createKnowledgeBase({
        name: name.trim(),
        description: description.trim() || null,
        kb_type: kbType,
      }),
    onSuccess: (kb) => {
      toast.success(`Knowledge base "${kb.name}" created`);
      setName("");
      setDescription("");
      setKbType("general");
      onCreated(kb);
    },
    onError: (err: Error) => toast.error(err.message || "Could not create knowledge base"),
  });

  const canSubmit = name.trim().length > 0 && !create.isPending;

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="grid gap-2 lg:grid-cols-12">
        <label className="space-y-1 text-sm lg:col-span-4">
          <span className="text-muted-foreground">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sepsis SOPs"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm lg:col-span-3">
          <span className="text-muted-foreground">Type</span>
          <select
            value={kbType}
            onChange={(e) => setKbType(e.target.value as KnowledgeBaseType)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            {KB_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm lg:col-span-5">
          <span className="text-muted-foreground">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Internal sepsis bundle reference"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <div className="lg:col-span-12 flex justify-end">
          <button
            onClick={() => create.mutate()}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {create.isPending ? "Creating..." : "Create knowledge base"}
          </button>
        </div>
      </div>
    </div>
  );
}

function KbListTable({
  loading,
  kbs,
  selectedKbId,
  onSelect,
  onArchive,
}: {
  loading: boolean;
  kbs: KnowledgeBase[];
  selectedKbId: number | null;
  onSelect: (id: number) => void;
  onArchive: (kb: KnowledgeBase) => void;
}) {
  if (loading) {
    return <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">Loading knowledge bases…</div>;
  }
  if (!kbs.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        No knowledge bases yet. Create one above.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Name</th>
            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Type</th>
            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-2 text-right font-medium text-muted-foreground">Documents</th>
            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Updated</th>
            <th className="px-4 py-2 text-right font-medium text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {kbs.map((kb) => (
            <tr
              key={kb.id}
              className={kb.id === selectedKbId ? "bg-emerald-50/50" : "hover:bg-muted/30"}
            >
              <td className="px-4 py-2">
                <button
                  type="button"
                  onClick={() => onSelect(kb.id)}
                  className="font-medium hover:underline"
                >
                  {kb.name}
                </button>
                {kb.description ? (
                  <p className="text-xs text-muted-foreground">{kb.description}</p>
                ) : null}
              </td>
              <td className="px-4 py-2 font-mono text-xs">{kb.kb_type}</td>
              <td className="px-4 py-2">
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(kb.status)}`}>
                  {kb.status}
                </span>
              </td>
              <td className="px-4 py-2 text-right">{kb.document_count ?? 0}</td>
              <td className="px-4 py-2 text-xs text-muted-foreground">{fmt(kb.updated_at)}</td>
              <td className="px-4 py-2 text-right">
                <button
                  type="button"
                  onClick={() => onArchive(kb)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent"
                >
                  {kb.status === "archived" ? (
                    <>
                      <Undo2 className="h-3.5 w-3.5" />
                      Restore
                    </>
                  ) : (
                    <>
                      <Archive className="h-3.5 w-3.5" />
                      Archive
                    </>
                  )}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KbDocumentSection({ knowledgeBaseId }: { knowledgeBaseId: number }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const docs = useQuery({
    queryKey: ["clinical-ai", "knowledge-bases", knowledgeBaseId, "documents"],
    queryFn: () => listKnowledgeDocuments(knowledgeBaseId, { limit: 100 }),
  });

  const documents: KnowledgeDocument[] = docs.data?.documents ?? [];

  const reportIngestResult = (result: KnowledgeDocumentIngestResult) => {
    const verdict = result.document.prompt_injection_verdict;
    if (result.document.processing_status === "blocked") {
      toast.error(`Blocked for prompt injection (${result.injection_safety_flag?.code ?? "unknown"})`);
    } else if (verdict === "flag") {
      toast(`Indexed with flag verdict (${result.embedded_count ?? 0}/${result.chunk_count ?? 0} chunks).`);
    } else if (result.reason === "no_text_extracted") {
      toast.error("No text extracted from file (OCR could not read it)");
    } else {
      toast.success(
        `Indexed ${result.embedded_count ?? 0} of ${result.chunk_count ?? 0} chunks`,
      );
    }
    queryClient.invalidateQueries({ queryKey: ["clinical-ai", "knowledge-bases", knowledgeBaseId, "documents"] });
    queryClient.invalidateQueries({ queryKey: ["clinical-ai", "knowledge-bases"] });
  };

  const ingest = useMutation({
    mutationFn: () =>
      createInlineKnowledgeDocument(knowledgeBaseId, {
        title: title.trim(),
        raw_text: rawText.trim(),
      }),
    onSuccess: (result) => {
      reportIngestResult(result);
      setTitle("");
      setRawText("");
    },
    onError: (err: Error) => toast.error(err.message || "Ingest failed"),
  });

  const upload = useMutation({
    mutationFn: () => {
      if (!uploadFile) throw new Error("Pick a file first");
      return uploadKnowledgeBaseDocument(knowledgeBaseId, uploadFile, {
        title: uploadTitle.trim() || null,
      });
    },
    onSuccess: (result) => {
      reportIngestResult(result);
      setUploadFile(null);
      setUploadTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err: Error) => toast.error(err.message || "Upload failed"),
  });

  const reindex = useMutation({
    mutationFn: (documentId: number) => reindexKnowledgeDocument(knowledgeBaseId, documentId),
    onSuccess: (result) => {
      toast.success(`Re-indexed: ${result.embedded_count ?? 0}/${result.chunk_count ?? 0} chunks`);
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "knowledge-bases", knowledgeBaseId, "documents"] });
    },
    onError: (err: Error) => toast.error(err.message || "Reindex failed"),
  });

  const remove = useMutation({
    mutationFn: (documentId: number) => deleteKnowledgeDocument(knowledgeBaseId, documentId),
    onSuccess: () => {
      toast.success("Document deleted");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "knowledge-bases", knowledgeBaseId, "documents"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "knowledge-bases"] });
    },
    onError: (err: Error) => toast.error(err.message || "Delete failed"),
  });

  const canIngest = title.trim().length > 0 && rawText.trim().length >= 20 && !ingest.isPending;
  const canUpload = uploadFile != null && !upload.isPending;
  const fileSizeWarning = uploadFile && uploadFile.size > KB_UPLOAD_MAX_BYTES
    ? `File is ${(uploadFile.size / (1024 * 1024)).toFixed(1)} MB; backend rejects anything over 25 MB.`
    : null;

  return (
    <div className="space-y-3">
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <FileText className="h-4 w-4 text-muted-foreground" />
        Documents
      </h4>

      <div className="grid gap-2 lg:grid-cols-12">
        <label className="space-y-1 text-sm lg:col-span-4">
          <span className="text-muted-foreground">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Sepsis 1-hour bundle reference"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm lg:col-span-12">
          <span className="text-muted-foreground">Inline text (paste SOP / policy)</span>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            placeholder="Paste full text here. Runs through the S1 prompt-injection gate before chunking."
          />
        </label>
        <div className="lg:col-span-12 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Goes through the same S1 prompt-injection gate as document intelligence.
          </p>
          <button
            onClick={() => ingest.mutate()}
            disabled={!canIngest}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {ingest.isPending ? "Ingesting..." : "Ingest text"}
          </button>
        </div>
      </div>

      <div className="rounded-md border border-dashed border-border bg-muted/30 p-3">
        <p className="mb-2 text-xs font-semibold text-muted-foreground">
          Or upload a file (PDF / image / text — 25 MB max)
        </p>
        <div className="grid gap-2 lg:grid-cols-12">
          <label className="space-y-1 text-sm lg:col-span-4">
            <span className="text-muted-foreground">Title (optional)</span>
            <input
              value={uploadTitle}
              onChange={(e) => setUploadTitle(e.target.value)}
              placeholder="Defaults to filename"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-6">
            <span className="text-muted-foreground">File</span>
            <input
              ref={fileInputRef}
              type="file"
              accept={KB_UPLOAD_ACCEPT}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                if (file && file.size > KB_UPLOAD_MAX_BYTES) {
                  toast.error(`File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB > 25 MB cap`);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                  setUploadFile(null);
                  return;
                }
                setUploadFile(file);
              }}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-emerald-100 file:px-3 file:py-1 file:text-xs file:font-medium file:text-emerald-800 hover:file:bg-emerald-200"
            />
          </label>
          <div className="lg:col-span-2 flex items-end">
            <button
              type="button"
              onClick={() => upload.mutate()}
              disabled={!canUpload || Boolean(fileSizeWarning)}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              {upload.isPending ? "Uploading..." : "Upload"}
            </button>
          </div>
          {fileSizeWarning ? (
            <p className="lg:col-span-12 text-xs text-red-700">{fileSizeWarning}</p>
          ) : null}
          {uploadFile && !fileSizeWarning ? (
            <p className="lg:col-span-12 text-xs text-muted-foreground">
              {uploadFile.name} · {(uploadFile.size / 1024).toFixed(1)} KB · {uploadFile.type || "unknown type"}
            </p>
          ) : null}
        </div>
      </div>

      {docs.isLoading ? (
        <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">Loading documents…</div>
      ) : documents.length ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Title</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Source</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Chunks</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Injection</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Created</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td className="px-3 py-2 font-medium">{doc.title}</td>
                  <td className="px-3 py-2 font-mono">{doc.source_type}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(doc.processing_status)}`}>
                      {doc.processing_status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{doc.chunk_count}</td>
                  <td className="px-3 py-2 font-mono">
                    {doc.prompt_injection_verdict ?? "-"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{fmt(doc.created_at)}</td>
                  <td className="px-3 py-2 space-x-1 text-right">
                    <button
                      type="button"
                      onClick={() => reindex.mutate(doc.id)}
                      disabled={reindex.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reindex
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete "${doc.title}"? This drops every chunk.`)) {
                          remove.mutate(doc.id);
                        }
                      }}
                      disabled={remove.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No documents yet. Paste content above to ingest.
        </div>
      )}
    </div>
  );
}

function KbAccessSection({ knowledgeBaseId }: { knowledgeBaseId: number }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<string>("DOCTOR");
  const [permission, setPermission] = useState<KnowledgeBasePermission>("read");

  const policies = useQuery({
    queryKey: ["clinical-ai", "knowledge-bases", knowledgeBaseId, "access-policies"],
    queryFn: () => listKnowledgeAccessPolicies(knowledgeBaseId),
  });

  const grant = useMutation({
    mutationFn: () =>
      grantKnowledgeAccess(knowledgeBaseId, {
        role: role.trim(),
        permission,
      }),
    onSuccess: (policy) => {
      toast.success(`Granted ${policy.permission} to ${policy.role}`);
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "knowledge-bases", knowledgeBaseId, "access-policies"],
      });
    },
    onError: (err: Error) => toast.error(err.message || "Could not grant access"),
  });

  const revoke = useMutation({
    mutationFn: ({ role: r, permission: p }: { role: string; permission: KnowledgeBasePermission }) =>
      revokeKnowledgeAccess(knowledgeBaseId, r, p),
    onSuccess: (policy) => {
      toast.success(`Revoked ${policy.permission} from ${policy.role}`);
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "knowledge-bases", knowledgeBaseId, "access-policies"],
      });
    },
    onError: (err: Error) => toast.error(err.message || "Could not revoke access"),
  });

  const rows = policies.data?.policies ?? [];

  return (
    <div className="space-y-3">
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <Shield className="h-4 w-4 text-muted-foreground" />
        Access policies
      </h4>
      <div className="grid gap-2 lg:grid-cols-12">
        <label className="space-y-1 text-sm lg:col-span-5">
          <span className="text-muted-foreground">Role</span>
          <input
            list={`kb-${knowledgeBaseId}-role-list`}
            value={role}
            onChange={(e) => setRole(e.target.value.toUpperCase())}
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono"
          />
          <datalist id={`kb-${knowledgeBaseId}-role-list`}>
            {COMMON_ROLES.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <label className="space-y-1 text-sm lg:col-span-3">
          <span className="text-muted-foreground">Permission</span>
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value as KnowledgeBasePermission)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            {PERMISSIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <div className="lg:col-span-4 flex items-end">
          <button
            type="button"
            onClick={() => grant.mutate()}
            disabled={grant.isPending || !role.trim()}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {grant.isPending ? "Granting..." : "Grant"}
          </button>
        </div>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Role</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Permission</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Granted</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-mono">{p.role}</td>
                  <td className="px-3 py-2">{p.permission}</td>
                  <td className="px-3 py-2 text-muted-foreground">{fmt(p.granted_at)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => revoke.mutate({ role: p.role, permission: p.permission })}
                      disabled={revoke.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No access grants yet. Add at least one role to allow retrieval.
        </div>
      )}
    </div>
  );
}

function KbRetrievalTester({ kbs }: { kbs: KnowledgeBase[] }) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("DOCTOR");
  const [kbId, setKbId] = useState<number | "">("");
  const [topK, setTopK] = useState("5");
  const [minScore, setMinScore] = useState("0.55");

  const test = useMutation({
    mutationFn: () =>
      retrieveFromKnowledgeBases({
        query: query.trim(),
        role: role.trim(),
        knowledge_base_id: kbId === "" ? null : kbId,
        top_k: Number.parseInt(topK, 10) || 5,
        min_score: Number.parseFloat(minScore) || 0.55,
      }),
    onError: (err: Error) => toast.error(err.message || "Retrieval failed"),
  });

  const result = test.data;
  const sourceLabel = useMemo(() => {
    if (!result) return null;
    if (result.source === "pgvector") return `${result.results.length} chunk${result.results.length === 1 ? "" : "s"} above threshold`;
    if (result.source === "embed_unavailable") return "Embedding endpoint unreachable (check Ollama)";
    if (result.source === "corpus_unavailable") return "knowledge_chunks table missing — apply migration 113";
    if (result.source === "no_access") return "No role supplied";
    if (result.source === "empty_query") return "Query was empty";
    if (result.source === "below_threshold") return "No chunks above min_score";
    if (result.source === "query_failed") return "Query failed; check server logs";
    return result.source;
  }, [result]);

  const canRun = query.trim().length > 0 && role.trim().length > 0 && !test.isPending;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Search className="h-4 w-4 text-muted-foreground" />
        Retrieval tester
      </h3>
      <div className="grid gap-2 lg:grid-cols-12">
        <label className="space-y-1 text-sm lg:col-span-12">
          <span className="text-muted-foreground">Query</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. sepsis 1-hour bundle"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm lg:col-span-3">
          <span className="text-muted-foreground">Role</span>
          <input
            list="kb-tester-role-list"
            value={role}
            onChange={(e) => setRole(e.target.value.toUpperCase())}
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono"
          />
          <datalist id="kb-tester-role-list">
            {COMMON_ROLES.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <label className="space-y-1 text-sm lg:col-span-3">
          <span className="text-muted-foreground">Knowledge base</span>
          <select
            value={kbId === "" ? "" : String(kbId)}
            onChange={(e) => setKbId(e.target.value === "" ? "" : Number(e.target.value))}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            <option value="">All accessible</option>
            {kbs.map((kb) => (
              <option key={kb.id} value={kb.id}>
                {kb.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm lg:col-span-2">
          <span className="text-muted-foreground">Top K</span>
          <input
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => setTopK(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm lg:col-span-2">
          <span className="text-muted-foreground">Min score</span>
          <input
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <div className="lg:col-span-12 flex justify-end">
          <button
            type="button"
            onClick={() => test.mutate()}
            disabled={!canRun}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <Search className="h-4 w-4" />
            {test.isPending ? "Retrieving..." : "Run retrieval"}
          </button>
        </div>
      </div>

      {result ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">{sourceLabel}</p>
          {result.results.length ? (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">KB</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Document</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Score</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Snippet</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.results.map((row) => (
                    <tr key={row.chunk_id}>
                      <td className="px-3 py-2 font-mono">{row.kb_name}</td>
                      <td className="px-3 py-2">{row.document_title}</td>
                      <td className="px-3 py-2 text-right font-mono">{Number(row.similarity).toFixed(3)}</td>
                      <td className="px-3 py-2">
                        <span className="line-clamp-2 text-muted-foreground">{row.content}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default KnowledgeBasePanel;
