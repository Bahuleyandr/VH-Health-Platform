"use client";

import { useState } from "react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import {
  adminSignPayrollRun,
  hrSignPayrollRun,
  type PayrollRun,
} from "@/lib/api/payroll";

interface RunActionsProps {
  run: PayrollRun;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  issueMut: UseMutationResult<any, Error, { month: number; year: number }, unknown>;
}

export function RunActions({ run, issueMut }: RunActionsProps) {
  const qc = useQueryClient();
  const [showComment, setShowComment] = useState<'hr' | 'admin' | null>(null);
  const [comment, setComment] = useState('');

  const hrSignMut = useMutation({
    mutationFn: (c: string) => hrSignPayrollRun(String(run.id), { comment: c }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); toast.success('HR signature applied'); setShowComment(null); setComment(''); },
    onError: (e: Error) => toast.error(e.message),
  });

  const adminSignMut = useMutation({
    mutationFn: (c: string) => adminSignPayrollRun(String(run.id), { comment: c }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); toast.success('Admin countersign complete — ready to issue'); setShowComment(null); setComment(''); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Completed but not HR-signed
  if (run.status === 'completed' && !run.hr_approved_at) {
    return showComment === 'hr' ? (
      <div className="flex flex-col gap-1 min-w-[200px]">
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="HR comment (optional)" className="text-xs border rounded px-2 py-1" />
        <div className="flex gap-1">
          <button onClick={() => hrSignMut.mutate(comment)} disabled={hrSignMut.isPending} className="text-xs bg-teal-600 text-white px-2 py-1 rounded hover:bg-teal-700 disabled:opacity-50">
            {hrSignMut.isPending ? '…' : 'Confirm HR Sign'}
          </button>
          <button onClick={() => setShowComment(null)} className="text-xs border px-2 py-1 rounded">Cancel</button>
        </div>
      </div>
    ) : (
      <button onClick={() => setShowComment('hr')} className="text-xs bg-blue-600 text-white px-3 py-1 rounded-full hover:bg-blue-700">
        HR Sign
      </button>
    );
  }

  // HR signed but not Admin countersigned
  if (run.status === 'completed' && run.hr_approved_at && !run.admin_approved_at) {
    return showComment === 'admin' ? (
      <div className="flex flex-col gap-1 min-w-[200px]">
        <p className="text-xs text-gray-500">HR signed ✓</p>
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Admin comment (optional)" className="text-xs border rounded px-2 py-1" />
        <div className="flex gap-1">
          <button onClick={() => adminSignMut.mutate(comment)} disabled={adminSignMut.isPending} className="text-xs bg-purple-600 text-white px-2 py-1 rounded hover:bg-purple-700 disabled:opacity-50">
            {adminSignMut.isPending ? '…' : 'Countersign'}
          </button>
          <button onClick={() => setShowComment(null)} className="text-xs border px-2 py-1 rounded">Cancel</button>
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-teal-600">✓ HR Signed</span>
        <button onClick={() => setShowComment('admin')} className="text-xs bg-purple-600 text-white px-3 py-1 rounded-full hover:bg-purple-700">
          Admin Countersign
        </button>
      </div>
    );
  }

  // Both signed — ready to issue
  if (run.status === 'approved') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-teal-600">✓ HR + Admin signed</span>
        <button
          onClick={() => issueMut.mutate({ month: run.month, year: run.year })}
          disabled={issueMut.isPending}
          className="text-xs bg-green-600 text-white px-3 py-1 rounded-full hover:bg-green-700 disabled:opacity-50"
        >
          {issueMut.isPending ? 'Issuing…' : 'Issue to Staff'}
        </button>
      </div>
    );
  }

  // Locked/issued
  if (run.status === 'locked') {
    return <span className="text-xs text-green-600 font-medium">✓ Issued</span>;
  }

  return null;
}
