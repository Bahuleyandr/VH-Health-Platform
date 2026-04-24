"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  getAllPayslipQueries,
  replyToPayslipQuery,
  type PayslipQuery,
} from "@/lib/api/payroll";
import { unwrap, fmtDate, MONTHS } from "./complianceHelpers";

export function PayslipQueriesSection() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"open" | "in_review" | "resolved">("open");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [replyText, setReplyText] = useState<Record<number, string>>({});
  const [resolveCheck, setResolveCheck] = useState<Record<number, boolean>>({});

  const { data: raw } = useQuery({
    queryKey: ["payslip-queries", statusFilter],
    queryFn: () => getAllPayslipQueries(statusFilter),
  });
  const queries = unwrap<PayslipQuery[]>(raw) ?? [];

  const replyMut = useMutation({
    mutationFn: ({ id, message, resolve }: { id: number; message: string; resolve: boolean }) =>
      replyToPayslipQuery(id, message, resolve),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["payslip-queries"] });
      setReplyText(r => ({ ...r, [vars.id]: "" }));
      toast.success(vars.resolve ? "Query resolved" : "Reply sent");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusChip = (s: string) => {
    const map: Record<string, string> = {
      open: "bg-orange-100 text-orange-700",
      in_review: "bg-blue-100 text-blue-700",
      resolved: "bg-green-100 text-green-700",
    };
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[s] ?? "bg-gray-100 text-gray-600"}`}>{s}</span>;
  };

  const catChip = (c: string) => (
    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">{c}</span>
  );

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-800">Payslip Queries</h3>
        <div className="flex gap-1 border rounded-lg overflow-hidden">
          {(["open", "in_review", "resolved"] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-sm ${statusFilter === s ? "bg-teal-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}>
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        {queries.map(q => (
          <div key={q.id} className="border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer"
              onClick={() => setExpanded(expanded === q.id ? null : q.id)}>
              <div className="flex-1">
                <div className="font-medium text-sm">{q.subject}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {q.staff_name} · {MONTHS[(q.month - 1 + 12) % 12]} {q.year} · {fmtDate(q.created_at)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {catChip(q.category)}
                {statusChip(q.status)}
              </div>
            </div>
            {expanded === q.id && (
              <div className="border-t px-4 py-3 bg-gray-50">
                <p className="text-sm text-gray-700 mb-3">{q.description}</p>
                {/* Reply thread */}
                {q.replies && q.replies.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {q.replies.map(r => (
                      <div key={r.id} className={`flex gap-2 text-xs ${r.author_role === "HR" || r.author_role === "ADMIN" ? "flex-row-reverse" : ""}`}>
                        <div className={`rounded-lg px-3 py-2 max-w-sm ${r.author_role === "HR" || r.author_role === "ADMIN" ? "bg-teal-50 text-teal-900" : "bg-white border text-gray-700"}`}>
                          <div className="font-medium text-xs mb-1">{r.author_role}</div>
                          {r.message}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {q.status !== "resolved" && (
                  <div className="flex gap-2 items-end">
                    <textarea
                      className="flex-1 border rounded px-2 py-1.5 text-sm resize-none"
                      rows={2} placeholder="Type reply..."
                      value={replyText[q.id] ?? ""}
                      onChange={e => setReplyText(r => ({ ...r, [q.id]: e.target.value }))}
                    />
                    <div className="flex flex-col gap-1">
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        <input type="checkbox" checked={resolveCheck[q.id] ?? false}
                          onChange={e => setResolveCheck(r => ({ ...r, [q.id]: e.target.checked }))} />
                        Resolve
                      </label>
                      <button onClick={() => replyMut.mutate({ id: q.id, message: replyText[q.id] ?? "", resolve: resolveCheck[q.id] ?? false })}
                        disabled={!replyText[q.id] || replyMut.isPending}
                        className="px-3 py-1.5 bg-teal-600 text-white rounded text-xs disabled:opacity-50">
                        Send
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {queries.length === 0 && (
          <div className="py-8 text-center text-gray-400">No {statusFilter} queries</div>
        )}
      </div>
    </div>
  );
}
