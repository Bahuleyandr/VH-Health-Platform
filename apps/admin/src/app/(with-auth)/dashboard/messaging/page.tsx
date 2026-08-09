// src/app/(with-auth)/dashboard/messaging/page.tsx
//
// Staff messaging inbox — Sprint 10. Patient ↔ staff secure threaded
// inbox. Hits /api/v1/staff-messaging/* for the staff side of the
// patientPortalService.

"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface ThreadSummary {
  id: number;
  patient_uid: string;
  subject: string;
  category: string;
  status:
    | "open"
    | "awaiting_patient"
    | "awaiting_staff"
    | "resolved"
    | "closed";
  priority: "low" | "normal" | "urgent";
  last_message_at: string | null;
  last_message_by: "patient" | "staff" | "system" | null;
  staff_unread_count: number;
  assigned_staff_uid: string | null;
  created_at: string;
}

interface Message {
  id: number;
  thread_id: number;
  sender_kind: "patient" | "staff" | "system";
  sender_name: string | null;
  body: string;
  attachments: Array<{ file_url: string; file_name?: string }>;
  read_by_staff_at: string | null;
  read_by_patient_at: string | null;
  created_at: string;
}

interface ThreadDetail {
  thread: ThreadSummary;
  messages: Message[];
}

const PRIORITY_COLOURS: Record<string, string> = {
  urgent: "bg-rose-100 text-rose-800",
  normal: "bg-blue-100 text-blue-800",
  low: "bg-slate-100 text-slate-700",
};

const STATUS_COLOURS: Record<string, string> = {
  open: "bg-amber-100 text-amber-800",
  awaiting_staff: "bg-rose-100 text-rose-800",
  awaiting_patient: "bg-blue-100 text-blue-800",
  resolved: "bg-emerald-100 text-emerald-800",
  closed: "bg-slate-200 text-slate-600",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

export default function MessagingPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("awaiting_staff");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [reply, setReply] = useState("");

  // Inbox query — auto-refresh every 60s.
  const {
    data: threads = [],
    error: inboxError,
    isLoading: inboxLoading,
  } = useQuery<ThreadSummary[]>({
    queryKey: ["staff-messaging", "inbox", { statusFilter, priorityFilter }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (statusFilter) params.set("status", statusFilter);
      if (priorityFilter) params.set("priority", priorityFilter);
      const r = await fetchAdminAPI<unknown>(
        `/staff-messaging/inbox?${params.toString()}`,
      );
      const data = unwrap<ThreadSummary[]>(r);
      return Array.isArray(data) ? data : [];
    },
    refetchInterval: 60_000,
  });

  // Detail query for the open thread.
  const { data: detail, isLoading: detailLoading } =
    useQuery<ThreadDetail | null>({
      queryKey: ["staff-messaging", "thread", open],
      queryFn: async () => {
        if (open === null) return null;
        const r = await fetchAdminAPI<unknown>(
          `/staff-messaging/threads/${open}`,
        );
        return unwrap<ThreadDetail>(r);
      },
      enabled: open !== null,
    });

  // Side-effect: mark read on view (one-shot, fire-and-forget).
  useEffect(() => {
    if (open === null) return;
    (async () => {
      await fetchAdminAPI(`/staff-messaging/threads/${open}/read`, {
        method: "POST",
      }).catch((err: unknown) => {
        // Surface instead of swallowing: a failed mark-read leaves the inbox
        // unread count drifting from what the user has actually seen.
        console.error(`Failed to mark thread ${open} as read`, err);
      });
      qc.invalidateQueries({ queryKey: ["staff-messaging", "inbox"] });
    })();
  }, [open, qc]);

  const replyMutation = useMutation({
    mutationFn: async (body: string) => {
      if (open === null) throw new Error("No thread open");
      return fetchAdminAPI(`/staff-messaging/threads/${open}/reply`, {
        method: "POST",
        body: { body },
      });
    },
    onSuccess: () => {
      setReply("");
      qc.invalidateQueries({ queryKey: ["staff-messaging", "thread", open] });
      qc.invalidateQueries({ queryKey: ["staff-messaging", "inbox"] });
    },
  });

  const statusMutation = useMutation({
    mutationFn: async (status: string) => {
      if (open === null) throw new Error("No thread open");
      return fetchAdminAPI(`/staff-messaging/threads/${open}/status`, {
        method: "POST",
        body: { status },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff-messaging", "thread", open] });
      qc.invalidateQueries({ queryKey: ["staff-messaging", "inbox"] });
    },
  });

  const counts = useMemo(() => {
    const byStatus = threads.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});
    return byStatus;
  }, [threads]);

  const error = inboxError ?? replyMutation.error ?? statusMutation.error;

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6 h-[calc(100vh-100px)]">
      {/* Left rail: thread list */}
      <div className="flex flex-col min-h-0">
        <h1 className="text-2xl font-bold text-foreground">Patient Messages</h1>

        <div className="flex gap-2 mt-3 mb-3 items-end flex-wrap">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground block mb-1">
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full border border-border rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">All</option>
              <option value="awaiting_staff">Awaiting staff</option>
              <option value="awaiting_patient">Awaiting patient</option>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground block mb-1">
              Priority
            </label>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="w-full border border-border rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">Any</option>
              <option value="urgent">Urgent</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>

        <div className="flex gap-2 text-xs text-muted-foreground mb-2">
          {Object.entries(counts).map(([s, n]) => (
            <span key={s} className="px-2 py-0.5 rounded bg-muted">
              {s}: <strong>{n}</strong>
            </span>
          ))}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive mb-2">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}

        {inboxLoading ? (
          <LoadingSpinner />
        ) : threads.length === 0 ? (
          <EmptyState
            title="Inbox zero"
            description="No threads match these filters."
            compact
          />
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1">
            {threads.map((t) => (
              <button
                key={t.id}
                onClick={() => setOpen(t.id)}
                className={`w-full text-left bg-card rounded-lg border shadow-sm p-3 hover:bg-muted/30 ${
                  open === t.id ? "ring-2 ring-blue-400" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-sm">{t.subject}</div>
                  {t.staff_unread_count > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-rose-600 text-white text-xs">
                      {t.staff_unread_count}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                      PRIORITY_COLOURS[t.priority]
                    }`}
                  >
                    {t.priority}
                  </span>
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-xs ${
                      STATUS_COLOURS[t.status]
                    }`}
                  >
                    {t.status}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t.category}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1.5">
                  Patient {t.patient_uid.slice(0, 8)} ·{" "}
                  {fmtTs(t.last_message_at)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right pane: thread detail */}
      <div className="bg-card rounded-lg border shadow-sm flex flex-col min-h-0">
        {open === null ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              title="Select a thread"
              description="Pick a conversation from the list to read and reply."
              compact
            />
          </div>
        ) : detailLoading || !detail ? (
          <LoadingSpinner />
        ) : (
          <>
            <div className="p-4 border-b">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {detail.thread.subject}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1 font-mono">
                    Patient {detail.thread.patient_uid.slice(0, 8)} · thread #
                    {detail.thread.id}
                  </p>
                </div>
                <div className="flex gap-1 flex-wrap">
                  <button
                    onClick={() => statusMutation.mutate("resolved")}
                    disabled={statusMutation.isPending}
                    className="px-2 py-1 rounded border text-xs hover:bg-muted disabled:opacity-40"
                  >
                    Resolve
                  </button>
                  <button
                    onClick={() => statusMutation.mutate("closed")}
                    disabled={statusMutation.isPending}
                    className="px-2 py-1 rounded border text-xs hover:bg-muted disabled:opacity-40"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {detail.messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${
                    m.sender_kind === "staff" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg p-3 ${
                      m.sender_kind === "staff"
                        ? "bg-blue-50 text-foreground"
                        : m.sender_kind === "system"
                          ? "bg-slate-100 text-muted-foreground italic"
                          : "bg-muted"
                    }`}
                  >
                    <div className="text-xs font-medium mb-1">
                      {m.sender_kind === "staff"
                        ? `${m.sender_name ?? "Staff"} (you)`
                        : m.sender_kind === "system"
                          ? "System"
                          : "Patient"}
                      <span className="ml-2 text-muted-foreground font-normal">
                        {fmtTs(m.created_at)}
                      </span>
                    </div>
                    <div className="text-sm whitespace-pre-wrap">{m.body}</div>
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {m.attachments.map((a, i) => (
                          <a
                            key={i}
                            href={a.file_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-blue-700 hover:underline block"
                          >
                            📎 {a.file_name ?? "attachment"}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t p-3">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Reply to patient…"
                rows={3}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
              <div className="mt-2 flex justify-end">
                <button
                  onClick={() =>
                    reply.trim() && replyMutation.mutate(reply.trim())
                  }
                  disabled={!reply.trim() || replyMutation.isPending}
                  className="px-4 py-2 rounded-md bg-foreground text-background text-sm disabled:opacity-40"
                >
                  {replyMutation.isPending ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
