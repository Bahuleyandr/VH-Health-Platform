"use client";

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Lock, Plus, Pencil, Trash2, Save, X } from 'lucide-react';
import { getJSON, postJSON, putJSON, deleteJSON } from '@/lib/api/core';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from 'sonner';

interface Shift {
  id: number;
  name: string;
  start_time: string;
  end_time: string;
  grace_period_minutes: number;
  late_threshold_minutes: number;
  absent_threshold_minutes: number;
  department: string | null;
  is_preset: boolean;
  is_active: boolean;
}

interface ShiftFormData {
  name: string;
  start_time: string;
  end_time: string;
  grace_period_minutes: number;
  late_threshold_minutes: number;
  absent_threshold_minutes: number;
  department: string;
}

const emptyForm: ShiftFormData = {
  name: '',
  start_time: '09:00',
  end_time: '18:00',
  grace_period_minutes: 15,
  late_threshold_minutes: 30,
  absent_threshold_minutes: 60,
  department: '',
};

function formatTime(t: string) {
  // Convert HH:MM:SS → HH:MM
  return t?.substring(0, 5) ?? t;
}

function shiftDuration(start: string, end: string): string {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // overnight
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default function ShiftsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingShift, setEditingShift] = useState<Shift | null>(null);
  const [form, setForm] = useState<ShiftFormData>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<Shift | null>(null);

  const { data: shifts = [], isLoading } = useQuery<Shift[]>({
    queryKey: ['shifts'],
    queryFn: async () => {
      const r = await getJSON<unknown>('/api/v1/staff/admin/shifts');
      const res = r as { data?: Shift[] } | Shift[];
      return (Array.isArray(res) ? res : (res as { data?: Shift[] }).data) ?? [];
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: ShiftFormData) =>
      postJSON('/api/v1/staff/admin/shifts/custom', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      toast.success('Custom shift created');
      setShowForm(false);
      setForm(emptyForm);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<ShiftFormData> }) =>
      putJSON(`/api/v1/staff/admin/shifts/custom/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      toast.success('Shift updated');
      setEditingShift(null);
      setForm(emptyForm);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      deleteJSON(`/api/v1/staff/admin/shifts/custom/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      toast.success('Shift deactivated');
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const presets = shifts.filter(s => s.is_preset);
  const customs = shifts.filter(s => !s.is_preset);

  function openCreate() {
    setEditingShift(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(shift: Shift) {
    setEditingShift(shift);
    setForm({
      name: shift.name,
      start_time: formatTime(shift.start_time),
      end_time: formatTime(shift.end_time),
      grace_period_minutes: shift.grace_period_minutes,
      late_threshold_minutes: shift.late_threshold_minutes,
      absent_threshold_minutes: shift.absent_threshold_minutes,
      department: shift.department ?? '',
    });
    setShowForm(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editingShift) {
      updateMutation.mutate({ id: editingShift.id, data: form });
    } else {
      createMutation.mutate(form);
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Shift Management</h1>
          <p className="text-sm text-gray-500 mt-1">
            3 preset shifts + unlimited custom shifts per department
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus size={16} />
          New Custom Shift
        </button>
      </div>

      {/* Preset Shifts */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Lock size={15} className="text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Preset Shifts (read-only)
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {isLoading
            ? [1, 2, 3].map(i => (
                <div key={i} className="h-28 bg-gray-100 rounded-xl animate-pulse" />
              ))
            : presets.map(shift => (
                <div
                  key={shift.id}
                  className="bg-white border border-gray-200 rounded-xl p-4 relative"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-semibold text-gray-900">{shift.name}</p>
                      <p className="text-primary font-mono text-lg mt-1">
                        {formatTime(shift.start_time)} – {formatTime(shift.end_time)}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        {shiftDuration(shift.start_time, shift.end_time)} ·{' '}
                        {shift.grace_period_minutes}min grace
                      </p>
                    </div>
                    <span className="flex items-center gap-1 text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded-full">
                      <Lock size={10} />
                      Preset
                    </span>
                  </div>
                </div>
              ))}
        </div>
      </section>

      {/* Custom Shifts */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Clock size={15} className="text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Custom Shifts ({customs.length})
          </h2>
        </div>
        {customs.length === 0 && !isLoading ? (
          <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center">
            <Clock className="mx-auto text-gray-300 mb-2" size={32} />
            <p className="text-gray-500 text-sm">No custom shifts yet.</p>
            <p className="text-gray-400 text-xs mt-1">
              Create one for departments with non-standard hours.
            </p>
            <button
              onClick={openCreate}
              className="mt-4 text-primary text-sm font-medium hover:underline"
            >
              + Create custom shift
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {customs.map(shift => (
              <div
                key={shift.id}
                className="bg-white border border-gray-200 rounded-xl p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{shift.name}</p>
                    <p className="text-primary font-mono text-lg mt-1">
                      {formatTime(shift.start_time)} – {formatTime(shift.end_time)}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                      <span className="text-xs text-gray-500">
                        ⏱ {shiftDuration(shift.start_time, shift.end_time)}
                      </span>
                      <span className="text-xs text-gray-500">
                        ✓ {shift.grace_period_minutes}min grace
                      </span>
                      {shift.department && (
                        <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">
                          {shift.department}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 ml-2 shrink-0">
                    <button
                      onClick={() => openEdit(shift)}
                      className="p-1.5 text-gray-400 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
                      title="Edit"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(shift)}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      title="Deactivate"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Create/Edit Form Drawer */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl">
            <div className="flex items-center justify-between p-5 border-b">
              <h2 className="text-lg font-semibold">
                {editingShift ? 'Edit Custom Shift' : 'New Custom Shift'}
              </h2>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Shift Name *</label>
                <input
                  required
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. ICU Afternoon, OT Standby"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Time *</label>
                  <input
                    required
                    type="time"
                    value={form.start_time}
                    onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End Time *</label>
                  <input
                    required
                    type="time"
                    value={form.end_time}
                    onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>

              {form.start_time && form.end_time && (
                <p className="text-xs text-primary -mt-2">
                  Duration: {shiftDuration(form.start_time + ':00', form.end_time + ':00')}
                  {form.end_time < form.start_time ? ' (overnight)' : ''}
                </p>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Department (optional)</label>
                <input
                  value={form.department}
                  onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                  placeholder="e.g. ICU, OT, Radiology"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <div className="border-t pt-4">
                <p className="text-xs font-medium text-gray-500 mb-3 uppercase tracking-wide">
                  Lateness Rules
                </p>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Grace (min)', key: 'grace_period_minutes' as const, help: 'On-time window' },
                    { label: 'Late (min)', key: 'late_threshold_minutes' as const, help: 'Flagged late' },
                    { label: 'Absent (min)', key: 'absent_threshold_minutes' as const, help: 'Counted absent' },
                  ].map(({ label, key, help }) => (
                    <div key={key}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                      <input
                        type="number"
                        min={0}
                        max={480}
                        value={form[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: parseInt(e.target.value) || 0 }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                      <p className="text-xs text-gray-400 mt-0.5">{help}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg text-sm font-medium hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex-1 flex items-center justify-center gap-2 bg-primary text-white py-2 rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {isSaving ? (
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  ) : (
                    <Save size={15} />
                  )}
                  {editingShift ? 'Save Changes' : 'Create Shift'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        setOpen={(v) => { if (!v) setDeleteTarget(null); }}
        title="Deactivate Shift"
        message={`Deactivate "${deleteTarget?.name}"? Staff currently assigned to this shift will keep their assignment but should be reassigned to an active shift.`}
        confirmLabel="Deactivate"
        variant="destructive"
        onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget.id); }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
