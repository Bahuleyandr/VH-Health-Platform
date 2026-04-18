'use client';

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import toast from 'react-hot-toast';
import { getPendingDisputes, resolveDispute } from '@/lib/api/attendance';
import { Button } from '@/components/ui/button';

interface Dispute {
  id: number;
  staff_id: number;
  staff_name: string;
  date: string;
  dispute_type: string;
  description: string;
  requested_check_in: string;
  requested_check_out: string;
  evidence_url: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewer_comment: string;
  created_at: string;
}

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDispute, setSelectedDispute] = useState<Dispute | null>(null);
  const [, setResolving] = useState(false);
  const [applyCorrection] = useState(true);
  const [reviewerComment, setReviewerComment] = useState('');
  const [resolveAction, setResolveAction] = useState<'approved' | 'rejected' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const loadDisputes = async () => {
      try {
        setLoading(true);
        const data = await getPendingDisputes<{ data: Dispute[] }>();
        setDisputes(data.data || []);
      } catch {
        toast.error('Failed to load disputes');
      } finally {
        setLoading(false);
      }
    };

    loadDisputes();
  }, []);

  const handleResolve = async () => {
    if (!selectedDispute || !resolveAction) return;

    try {
      setResolving(true);
      await resolveDispute(selectedDispute.id, {
        status: resolveAction,
        reviewer_comment: reviewerComment || undefined,
        apply_correction: applyCorrection
      });

      toast.success(`Dispute ${resolveAction} successfully`);

      // Remove from list
      setDisputes(disputes.filter(d => d.id !== selectedDispute.id));
      setSelectedDispute(null);
      setReviewerComment('');
      setResolveAction(null);
    } catch {
      toast.error('Failed to resolve dispute');
    } finally {
      setResolving(false);
    }
  };

  const getDisputeTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      'missed_checkin': 'Missed Check-in',
      'missed_checkout': 'Missed Check-out',
      'wrong_time': 'Wrong Time',
      'app_failure': 'App Failure',
      'other': 'Other'
    };
    return labels[type] || type;
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold text-primary">Attendance Disputes</h1>
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-primary">Attendance Disputes</h1>
        <p className="text-sm text-gray-600 mt-1">
          {disputes.length} pending dispute{disputes.length !== 1 ? 's' : ''}
        </p>
      </div>

      {disputes.length === 0 ? (
        <div className="bg-gray-50 rounded-lg p-8 text-center">
          <p className="text-gray-600">No pending disputes</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="px-6 py-3 text-left font-semibold">Staff Member</th>
                <th className="px-6 py-3 text-left font-semibold">Date</th>
                <th className="px-6 py-3 text-left font-semibold">Type</th>
                <th className="px-6 py-3 text-left font-semibold">Description</th>
                <th className="px-6 py-3 text-left font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {disputes.map((dispute) => (
                <tr key={dispute.id} className="border-b hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="font-medium text-gray-900">{dispute.staff_name}</div>
                  </td>
                  <td className="px-6 py-4">
                    {new Date(dispute.date).toLocaleDateString('en-GB')}
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-3 py-1 rounded border border-gray-300 text-xs font-medium bg-white">
                      {getDisputeTypeLabel(dispute.dispute_type)}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <p className="text-gray-600 truncate max-w-xs">{dispute.description}</p>
                  </td>
                  <td className="px-6 py-4">
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelectedDispute(dispute);
                        setResolveAction('approved');
                        setConfirmOpen(true);
                      }}
                      className="bg-primary text-white hover:bg-primary/90 mr-2"
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSelectedDispute(dispute);
                        setResolveAction('rejected');
                        setConfirmOpen(true);
                      }}
                    >
                      Reject
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Resolve Dialog */}
      {selectedDispute && resolveAction && (
        <ConfirmDialog
          open={confirmOpen}
          setOpen={setConfirmOpen}
          title={`${resolveAction === 'approved' ? 'Approve' : 'Reject'} Dispute`}
          message={`Are you sure you want to ${resolveAction === 'approved' ? 'approve' : 'reject'} this dispute?`}
          onConfirm={handleResolve}
          onCancel={() => {
            setSelectedDispute(null);
            setResolveAction(null);
            setReviewerComment('');
          }}
          confirmLabel={resolveAction === 'approved' ? 'Approve' : 'Reject'}
          variant={resolveAction === 'approved' ? 'default' : 'destructive'}
        />
      )}
    </div>
  );
}
