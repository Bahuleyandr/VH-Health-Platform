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
  issueMut: UseMutationResult<any, Error, { month: number; year: number; acknowledge_failed_payslips?: boolean }, unknown>;
}

/**
 * Shown whenever a sign/countersign/issue action targets a run with failed
 * payslips (completed_with_errors, migration 644). The backend refuses these
 * actions without `acknowledge_failed_payslips: true`, so the signer must see
 * WHO is unpaid and tick the confirmation before the action is sent.
 */
function FailedPayslipsAck({
  run,
  acked,
  onAckChange,
}: {
  run: PayrollRun;
  acked: boolean;
  onAckChange: (v: boolean) => void;
}) {
  const failed = run.failed_staff_summary ?? [];
  return (
    <div className="rounded border border-red-200 bg-red-50 p-2 space-y-1">
      <p className="text-xs font-semibold text-red-700">
        {run.failed_staff_count} payslip{run.failed_staff_count === 1 ? "" : "s"} failed in this run — these staff have no payslip:
      </p>
      {failed.length > 0 && (
        <ul className="text-xs text-red-700 list-disc pl-4 max-h-24 overflow-y-auto">
          {failed.map((f) => (
            <li key={f.staff_uid}>{f.name ?? f.staff_uid}</li>
          ))}
        </ul>
      )}
      <label className="flex items-start gap-1.5 text-xs text-red-800 cursor-pointer">
        <input
          type="checkbox"
          checked={acked}
          onChange={(e) => onAckChange(e.target.checked)}
          className="mt-0.5"
          aria-label="Acknowledge failed payslips"
        />
        <span>I have reviewed the failed payslips and acknowledge proceeding without them</span>
      </label>
    </div>
  );
}

export function RunActions({ run, issueMut }: RunActionsProps) {
  const qc = useQueryClient();
  const [showConfirm, setShowConfirm] = useState<'hr' | 'admin' | 'issue' | null>(null);
  const [comment, setComment] = useState('');
  const [ackFailed, setAckFailed] = useState(false);

  // completed_with_errors (mig 644) is signable, but only with the explicit
  // acknowledgement; failed_staff_count keeps flagging the run after its
  // status moves on to approved/locked.
  const hasFailures = run.status === 'completed_with_errors' || (run.failed_staff_count ?? 0) > 0;
  const signable = run.status === 'completed' || run.status === 'completed_with_errors';
  const ackBody = hasFailures ? { acknowledge_failed_payslips: true } : {};

  const reset = () => { setShowConfirm(null); setComment(''); setAckFailed(false); };

  const hrSignMut = useMutation({
    mutationFn: (c: string) => hrSignPayrollRun(String(run.id), { comment: c, ...ackBody }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); toast.success('HR signature applied'); reset(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const adminSignMut = useMutation({
    mutationFn: (c: string) => adminSignPayrollRun(String(run.id), { comment: c, ...ackBody }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); toast.success('Admin countersign complete — ready to issue'); reset(); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Completed (possibly with errors) but not HR-signed
  if (signable && !run.hr_approved_at) {
    return showConfirm === 'hr' ? (
      <div className="flex flex-col gap-1 min-w-[200px]">
        {hasFailures && <FailedPayslipsAck run={run} acked={ackFailed} onAckChange={setAckFailed} />}
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="HR comment (optional)" className="text-xs border rounded px-2 py-1" />
        <div className="flex gap-1">
          <button
            onClick={() => hrSignMut.mutate(comment)}
            disabled={hrSignMut.isPending || (hasFailures && !ackFailed)}
            className="text-xs bg-teal-600 text-white px-2 py-1 rounded hover:bg-teal-700 disabled:opacity-50"
          >
            {hrSignMut.isPending ? '…' : 'Confirm HR Sign'}
          </button>
          <button onClick={reset} className="text-xs border px-2 py-1 rounded">Cancel</button>
        </div>
      </div>
    ) : (
      <button onClick={() => setShowConfirm('hr')} className="text-xs bg-blue-600 text-white px-3 py-1 rounded-full hover:bg-blue-700">
        HR Sign
      </button>
    );
  }

  // HR signed but not Admin countersigned
  if (signable && run.hr_approved_at && !run.admin_approved_at) {
    return showConfirm === 'admin' ? (
      <div className="flex flex-col gap-1 min-w-[200px]">
        <p className="text-xs text-gray-500">HR signed ✓</p>
        {hasFailures && <FailedPayslipsAck run={run} acked={ackFailed} onAckChange={setAckFailed} />}
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Admin comment (optional)" className="text-xs border rounded px-2 py-1" />
        <div className="flex gap-1">
          <button
            onClick={() => adminSignMut.mutate(comment)}
            disabled={adminSignMut.isPending || (hasFailures && !ackFailed)}
            className="text-xs bg-purple-600 text-white px-2 py-1 rounded hover:bg-purple-700 disabled:opacity-50"
          >
            {adminSignMut.isPending ? '…' : 'Countersign'}
          </button>
          <button onClick={reset} className="text-xs border px-2 py-1 rounded">Cancel</button>
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-teal-600">✓ HR Signed</span>
        <button onClick={() => setShowConfirm('admin')} className="text-xs bg-purple-600 text-white px-3 py-1 rounded-full hover:bg-purple-700">
          Admin Countersign
        </button>
      </div>
    );
  }

  // Both signed — ready to issue
  if (run.status === 'approved') {
    // A run that lost payslips needs the same explicit acknowledgement at
    // issue time — issuing is the last chance to re-run instead of paying an
    // incomplete month.
    if (hasFailures) {
      return showConfirm === 'issue' ? (
        <div className="flex flex-col gap-1 min-w-[200px]">
          <FailedPayslipsAck run={run} acked={ackFailed} onAckChange={setAckFailed} />
          <div className="flex gap-1">
            <button
              onClick={() => issueMut.mutate({ month: run.month, year: run.year, acknowledge_failed_payslips: true })}
              disabled={issueMut.isPending || !ackFailed}
              className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 disabled:opacity-50"
            >
              {issueMut.isPending ? 'Issuing…' : 'Confirm Issue'}
            </button>
            <button onClick={reset} className="text-xs border px-2 py-1 rounded">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-teal-600">✓ HR + Admin signed</span>
          <button
            onClick={() => setShowConfirm('issue')}
            className="text-xs bg-green-600 text-white px-3 py-1 rounded-full hover:bg-green-700"
          >
            Issue to Staff
          </button>
        </div>
      );
    }
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
