'use client';

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import toast from 'react-hot-toast';
import { getPendingOvertimeRequests, approveOvertimeRequest } from '@/lib/api/attendance';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface OvertimeRequest {
  id: number;
  staff_id: number;
  staff_name: string;
  department: string;
  date: string;
  extra_hours: number;
  reason: string;
  type: 'comp_time' | 'payment';
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

export default function OvertimePage() {
  const [requests, setRequests] = useState<OvertimeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRequest, setSelectedRequest] = useState<OvertimeRequest | null>(null);
  const [approving, setApproving] = useState(false);
  const [action, setAction] = useState<'approved' | 'rejected' | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [stats, setStats] = useState({ pending: 0, totalHours: 0 });
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const loadRequests = async () => {
      try {
        setLoading(true);
        const data = await getPendingOvertimeRequests<{ data: OvertimeRequest[] }>();
        const list = data.data || [];
        setRequests(list);
        
        // Calculate stats
        const pending = list.filter(r => r.status === 'pending').length;
        const totalHours = list.reduce((sum, r) => sum + parseFloat(String(r.extra_hours)), 0);
        setStats({ pending, totalHours });
      } catch {
        toast.error('Failed to load overtime requests');
      } finally {
        setLoading(false);
      }
    };

    loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApprove = async () => {
    if (!selectedRequest || !action) return;

    try {
      setApproving(true);
      await approveOvertimeRequest(selectedRequest.id, {
        status: action,
        rejection_reason: action === 'rejected' ? rejectionReason || undefined : undefined
      });

      toast.success(`Overtime request ${action}d successfully`);

      // Remove from list
      setRequests(requests.filter(r => r.id !== selectedRequest.id));
      setSelectedRequest(null);
      setAction(null);
      setRejectionReason('');
    } catch {
      toast.error('Failed to process overtime request');
    } finally {
      setApproving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold text-primary">Overtime Approvals</h1>
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
        <h1 className="text-3xl font-bold text-primary">Overtime Approvals</h1>
        <p className="text-sm text-gray-600 mt-1">
          {stats.pending} pending request{stats.pending !== 1 ? 's' : ''} • {stats.totalHours.toFixed(1)} hours
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
          <p className="text-sm text-gray-600">Pending Requests</p>
          <p className="text-3xl font-bold text-primary mt-1">{stats.pending}</p>
        </div>
        <div className="bg-green-50 rounded-lg p-4 border border-green-200">
          <p className="text-sm text-gray-600">Total Hours This Month</p>
          <p className="text-3xl font-bold text-green-600 mt-1">{stats.totalHours.toFixed(1)}</p>
        </div>
      </div>

      {requests.length === 0 ? (
        <div className="bg-gray-50 rounded-lg p-8 text-center">
          <p className="text-gray-600">No pending overtime requests</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="px-6 py-3 text-left font-semibold">Staff Member</th>
                <th className="px-6 py-3 text-left font-semibold">Department</th>
                <th className="px-6 py-3 text-left font-semibold">Date</th>
                <th className="px-6 py-3 text-left font-semibold">Hours</th>
                <th className="px-6 py-3 text-left font-semibold">Type</th>
                <th className="px-6 py-3 text-left font-semibold">Reason</th>
                <th className="px-6 py-3 text-left font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id} className="border-b hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="font-medium text-gray-900">{request.staff_name}</div>
                  </td>
                  <td className="px-6 py-4 text-gray-600">{request.department || '—'}</td>
                  <td className="px-6 py-4">
                    {new Date(request.date).toLocaleDateString('en-GB')}
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-3 py-1 rounded text-xs font-medium bg-primary text-white">
                      {request.extra_hours.toFixed(1)}h
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-3 py-1 rounded border border-gray-300 text-xs font-medium bg-white">
                      {request.type === 'comp_time' ? 'Comp Time' : 'Payment'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <p className="text-gray-600 truncate max-w-xs">{request.reason}</p>
                  </td>
                  <td className="px-6 py-4 space-x-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelectedRequest(request);
                        setAction('approved');
                        setConfirmOpen(true);
                      }}
                      className="bg-primary text-white hover:bg-primary/90"
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSelectedRequest(request);
                        setAction('rejected');
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

      {/* Approve Dialog */}
      {selectedRequest && action && (
        <ConfirmDialog
          open={confirmOpen}
          setOpen={setConfirmOpen}
          title={`${action === 'approved' ? 'Approve' : 'Reject'} Overtime Request`}
          message={`${selectedRequest.staff_name} - ${selectedRequest.extra_hours} hours`}
          onConfirm={handleApprove}
          onCancel={() => {
            setSelectedRequest(null);
            setAction(null);
            setRejectionReason('');
          }}
          confirmLabel={action === 'approved' ? 'Approve' : 'Reject'}
          variant={action === 'approved' ? 'default' : 'destructive'}
        />
      )}
    </div>
  );
}
