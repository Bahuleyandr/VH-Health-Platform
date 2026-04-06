"use client";

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, Clock, Users, TrendingUp, Shield,
  Activity, CheckCircle, XCircle, Eye
} from 'lucide-react';
import { getAuditDashboard, getAdminActivityReport, getSLAReport, getReportAuditTrail } from '@/lib/api/reports';
import { Skeleton } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────
interface SLABreach {
  type: string;
  id: number;
  report_number: string;
  severity: string;
  title: string;
  status: string;
  created_at: string;
  assigned_to_name: string | null;
  hours_open: number;
  admin_action_count: number;
}

interface RecentActivity {
  id: number;
  report_type: string;
  report_number: string;
  author_name: string;
  author_role: string;
  message: string;
  is_internal: boolean;
  created_at: string;
}

interface Unassigned {
  type: string;
  id: number;
  report_number: string;
  priority_indicator: string;
  subject: string;
  created_at: string;
  hours_open?: number;
}

interface AuditDashboardData {
  incidents: Record<string, string | number>;
  grievances: Record<string, string | number>;
  sla_breaches: SLABreach[];
  recent_activity: RecentActivity[];
  unassigned: Unassigned[];
}

interface AdminActivityData {
  admin_activity: Array<{
    id: number;
    name: string;
    role: string;
    incident_actions: number;
    grievance_actions: number;
    total_actions: number;
    last_action: string;
    internal_notes: number;
    public_updates: number;
  }>;
  neglected_reports: Array<{
    type: string;
    report_number: string;
    subject: string;
    severity?: string;
    hours_open: number;
    assigned_to_name: string | null;
  }>;
  resolution_stats: Array<{
    type: string;
    resolved: number;
    open: number;
    total: number;
    resolution_rate_pct: number;
    avg_hours_to_resolve: number;
  }>;
}

interface SLAData {
  incident_sla: Array<{
    severity: string;
    total: number;
    resolved: number;
    resolved_within_sla: number;
    currently_breached: number;
    avg_resolution_hours: number;
  }>;
  grievance_sla: Array<{
    priority: string;
    total: number;
    resolved: number;
    currently_breached: number;
    avg_resolution_hours: number;
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function severityColor(s: string) {
  const m: Record<string, string> = {
    sentinel: 'text-red-900 bg-red-100 border-red-400',
    severe:   'text-red-700 bg-red-50 border-red-300',
    moderate: 'text-orange-700 bg-orange-50 border-orange-300',
    low:      'text-green-700 bg-green-50 border-green-200',
  };
  return m[s] ?? 'text-gray-600 bg-gray-50 border-gray-200';
}


function hoursAgo(iso: string) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function formatHours(h: number | null) {
  if (!h) return '—';
  if (h < 24) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
type Tab = 'overview' | 'activity' | 'sla';

export default function AuditPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(30);
  const [trailTarget, setTrailTarget] = useState<{ type: 'incident' | 'grievance'; id: string; number: string } | null>(null);

  const dashQuery = useQuery<AuditDashboardData>({
    queryKey: ['audit-dashboard'],
    queryFn: async () => {
      const r = await getAuditDashboard<unknown>();
      return (r as { data: AuditDashboardData }).data ?? r as AuditDashboardData;
    },
    refetchInterval: 60000, // refresh every minute
  });

  const activityQuery = useQuery<AdminActivityData>({
    queryKey: ['audit-activity', days],
    queryFn: async () => {
      const r = await getAdminActivityReport<unknown>(days);
      return (r as { data: AdminActivityData }).data ?? r as AdminActivityData;
    },
    enabled: tab === 'activity',
  });

  const slaQuery = useQuery<SLAData>({
    queryKey: ['audit-sla', days],
    queryFn: async () => {
      const r = await getSLAReport<unknown>(days);
      return (r as { data: SLAData }).data ?? r as SLAData;
    },
    enabled: tab === 'sla',
  });

  const trailQuery = useQuery({
    queryKey: ['audit-trail', trailTarget?.type, trailTarget?.id],
    queryFn: async () => {
      if (!trailTarget) return null;
      const r = await getReportAuditTrail<unknown>(trailTarget.type, trailTarget.id);
      return (r as { data: unknown }).data ?? r;
    },
    enabled: !!trailTarget,
  });

  const dash = dashQuery.data;
  const hasSentinel = (dash?.incidents?.open_sentinel as number) > 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="text-primary" size={22} />
            <h1 className="text-2xl font-bold text-gray-900">Reports Audit</h1>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Super-admin oversight — incident reports, grievances, HR activity, SLA compliance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Period:</label>
          <select
            value={days}
            onChange={e => setDays(parseInt(e.target.value))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {/* Sentinel alert banner */}
      {hasSentinel && (
        <div className="mb-5 flex items-center gap-3 bg-red-900 text-white px-4 py-3 rounded-xl">
          <AlertTriangle size={18} className="shrink-0 animate-pulse" />
          <span className="font-semibold">
            {dash?.incidents?.open_sentinel} SENTINEL event(s) unresolved — requires immediate investigation
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b mb-6">
        {(['overview', 'activity', 'sla'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize rounded-t-lg transition-colors ${
              tab === t ? 'bg-primary text-white' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {t === 'sla' ? 'SLA Compliance' : t === 'activity' ? 'HR Activity' : 'Overview'}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ── */}
      {tab === 'overview' && (
        <div className="space-y-6">
          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {dashQuery.isLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <StatCard icon={<AlertTriangle size={20} className="text-orange-500" />} label="Open Incidents" value={String(dash?.incidents?.open_count ?? 0)} sub={`${dash?.incidents?.overdue_new ?? 0} overdue`} alert={(dash?.incidents?.overdue_new as number) > 0} />
                <StatCard icon={<Users size={20} className="text-purple-500" />} label="Open Grievances" value={String(dash?.grievances?.open_count ?? 0)} sub={`${dash?.grievances?.overdue_new ?? 0} overdue`} alert={(dash?.grievances?.overdue_new as number) > 0} />
                <StatCard icon={<Clock size={20} className="text-blue-500" />} label="Unassigned" value={String(dash?.unassigned?.length ?? 0)} sub="need assignment" alert={(dash?.unassigned?.length ?? 0) > 0} />
                <StatCard icon={<TrendingUp size={20} className="text-green-500" />} label="Avg Resolution" value={`${formatHours(Number(dash?.incidents?.avg_resolution_hours))}`} sub="incidents" />
              </>
            )}
          </div>

          {/* SLA Breaches */}
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
              <XCircle size={14} className="text-red-500" />
              SLA Breaches — Action Required
              {(dash?.sla_breaches?.length ?? 0) > 0 && (
                <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">{dash?.sla_breaches?.length}</span>
              )}
            </h2>
            {dashQuery.isLoading ? <Skeleton className="h-32 rounded-xl" /> : (
              dash?.sla_breaches?.length === 0 ? (
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-green-700 text-sm flex items-center gap-2">
                  <CheckCircle size={16} /> All reports are within SLA thresholds
                </div>
              ) : (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Report</th>
                        <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Severity</th>
                        <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Time Open</th>
                        <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Assigned To</th>
                        <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Admin Actions</th>
                        <th className="px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {dash?.sla_breaches?.map(b => (
                        <tr key={`${b.type}-${b.id}`} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <p className="font-medium text-gray-900">{b.report_number}</p>
                            <p className="text-xs text-gray-500 truncate max-w-48">{b.title}</p>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${severityColor(b.severity)}`}>
                              {b.severity?.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-red-600 font-semibold">
                            {formatHours(b.hours_open)}
                          </td>
                          <td className="px-4 py-3 text-gray-600">
                            {b.assigned_to_name ?? <span className="text-red-500 text-xs">Unassigned</span>}
                          </td>
                          <td className="px-4 py-3">
                            {b.admin_action_count === 0 ? (
                              <span className="text-xs text-red-600 font-medium">No action taken</span>
                            ) : (
                              <span className="text-xs text-gray-500">{b.admin_action_count} action(s)</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setTrailTarget({ type: b.type as 'incident' | 'grievance', id: String(b.id), number: b.report_number })}
                              className="flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <Eye size={12} /> Trail
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </section>

          {/* Unassigned + Recent activity side by side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Unassigned */}
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-yellow-500" />
                Unassigned Reports
              </h2>
              <div className="bg-white border border-gray-200 rounded-xl divide-y max-h-80 overflow-y-auto">
                {dash?.unassigned?.length === 0 ? (
                  <div className="p-4 text-sm text-gray-500 text-center">All reports are assigned ✓</div>
                ) : dash?.unassigned?.map(u => (
                  <div key={`${u.type}-${u.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                    <div className={`w-2 h-2 rounded-full ${u.type === 'incident' ? 'bg-orange-400' : 'bg-purple-400'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-gray-500">{u.report_number}</p>
                      <p className="text-sm truncate">{u.subject}</p>
                    </div>
                    <span className="text-xs text-gray-400 shrink-0">{hoursAgo(u.created_at)}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Recent activity */}
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                <Activity size={14} className="text-blue-500" />
                Recent Admin Activity
              </h2>
              <div className="bg-white border border-gray-200 rounded-xl divide-y max-h-80 overflow-y-auto">
                {dash?.recent_activity?.length === 0 ? (
                  <div className="p-4 text-sm text-gray-500 text-center">No recent activity</div>
                ) : dash?.recent_activity?.map(a => (
                  <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                    <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${a.report_type === 'incident' ? 'bg-orange-400' : 'bg-purple-400'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-bold text-gray-500">{a.report_number}</span>
                        <span className="text-xs text-gray-400">·</span>
                        <span className="text-xs font-medium">{a.author_name}</span>
                        {a.is_internal && (
                          <span className="text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 px-1.5 py-0.5 rounded">internal</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">{a.message}</p>
                    </div>
                    <span className="text-xs text-gray-400 shrink-0">{hoursAgo(a.created_at)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* ── ACTIVITY TAB ── */}
      {tab === 'activity' && (
        <div className="space-y-6">
          {activityQuery.isLoading ? <Skeleton className="h-64 rounded-xl" /> : (
            <>
              {/* Resolution stats */}
              <div className="grid grid-cols-2 gap-4">
                {activityQuery.data?.resolution_stats?.map(rs => (
                  <div key={rs.type} className="bg-white border border-gray-200 rounded-xl p-5">
                    <p className="text-xs text-gray-500 uppercase font-medium mb-1 capitalize">{rs.type} Resolution</p>
                    <p className="text-3xl font-bold text-gray-900">{rs.resolution_rate_pct ?? 0}%</p>
                    <p className="text-sm text-gray-500">{rs.resolved}/{rs.total} resolved · avg {formatHours(rs.avg_hours_to_resolve)}</p>
                  </div>
                ))}
              </div>

              {/* Per-admin table */}
              <section>
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">HR / Admin Actions (last {days} days)</h2>
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  {(activityQuery.data?.admin_activity?.length ?? 0) === 0 ? (
                    <div className="p-6 text-center text-sm text-gray-500">No admin activity recorded</div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Staff Member</th>
                          <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Role</th>
                          <th className="text-right px-4 py-2.5 text-xs text-gray-500 font-medium">Incidents</th>
                          <th className="text-right px-4 py-2.5 text-xs text-gray-500 font-medium">Grievances</th>
                          <th className="text-right px-4 py-2.5 text-xs text-gray-500 font-medium">Total Actions</th>
                          <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Last Active</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {activityQuery.data?.admin_activity?.map(a => (
                          <tr key={a.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-medium">{a.name}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs">{a.role}</td>
                            <td className="px-4 py-3 text-right">{a.incident_actions}</td>
                            <td className="px-4 py-3 text-right">{a.grievance_actions}</td>
                            <td className="px-4 py-3 text-right font-bold">{a.total_actions}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs">{a.last_action ? hoursAgo(a.last_action) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>

              {/* Neglected reports */}
              {(activityQuery.data?.neglected_reports?.length ?? 0) > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-red-600 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <AlertTriangle size={14} /> Reports with Zero Admin Action
                  </h2>
                  <div className="bg-white border border-red-200 rounded-xl divide-y">
                    {activityQuery.data?.neglected_reports?.map((r, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${r.type === 'incident' ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>
                          {r.report_number}
                        </span>
                        <p className="flex-1 text-sm truncate">{r.subject}</p>
                        <span className="text-xs text-red-600 font-medium">{formatHours(r.hours_open)} open</span>
                        <span className="text-xs text-gray-500">{r.assigned_to_name ?? 'Unassigned'}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {/* ── SLA TAB ── */}
      {tab === 'sla' && (
        <div className="space-y-6">
          {slaQuery.isLoading ? <Skeleton className="h-64 rounded-xl" /> : (
            <>
              <section>
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Incident SLA by Severity</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {slaQuery.data?.incident_sla?.map(row => {
                    const compliance = row.resolved > 0 ? Math.round((Number(row.resolved_within_sla) / row.resolved) * 100) : null;
                    return (
                      <div key={row.severity} className={`bg-white border rounded-xl p-4 ${row.currently_breached > 0 ? 'border-red-300' : 'border-gray-200'}`}>
                        <div className="flex items-center justify-between mb-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full border font-bold ${severityColor(row.severity)}`}>
                            {row.severity?.toUpperCase()}
                          </span>
                          {row.currently_breached > 0 && (
                            <span className="text-xs text-red-600 font-semibold">{row.currently_breached} breached now</span>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div>
                            <p className="text-xl font-bold">{row.total}</p>
                            <p className="text-xs text-gray-500">Total</p>
                          </div>
                          <div>
                            <p className="text-xl font-bold text-green-600">{row.resolved}</p>
                            <p className="text-xs text-gray-500">Resolved</p>
                          </div>
                          <div>
                            <p className={`text-xl font-bold ${compliance !== null && compliance < 70 ? 'text-red-600' : 'text-green-600'}`}>
                              {compliance !== null ? `${compliance}%` : '—'}
                            </p>
                            <p className="text-xs text-gray-500">Within SLA</p>
                          </div>
                        </div>
                        <p className="text-xs text-gray-400 mt-2 text-center">
                          Avg resolution: {formatHours(row.avg_resolution_hours)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section>
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Grievance SLA by Priority</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {slaQuery.data?.grievance_sla?.map(row => (
                    <div key={row.priority} className={`bg-white border rounded-xl p-4 ${row.currently_breached > 0 ? 'border-red-300' : 'border-gray-200'}`}>
                      <p className="font-semibold text-sm capitalize mb-2">{row.priority}</p>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Total: <b>{row.total}</b></span>
                        <span className="text-green-600">Resolved: <b>{row.resolved}</b></span>
                      </div>
                      {row.currently_breached > 0 && (
                        <p className="text-xs text-red-600 mt-1 font-medium">{row.currently_breached} currently past SLA</p>
                      )}
                      <p className="text-xs text-gray-400 mt-1">Avg: {formatHours(row.avg_resolution_hours)}</p>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      )}

      {/* ── AUDIT TRAIL PANEL ── */}
      {trailTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b">
              <div>
                <h2 className="font-semibold text-lg">{trailTarget.number} — Audit Trail</h2>
                <p className="text-xs text-gray-500 capitalize">{trailTarget.type} report · complete action history</p>
              </div>
              <button onClick={() => setTrailTarget(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {trailQuery.isLoading ? <Skeleton className="h-48" /> : (
                <TrailPanel data={trailQuery.data as Record<string, unknown> | null} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, alert }: { icon: React.ReactNode; label: string; value: string; sub?: string; alert?: boolean }) {
  return (
    <div className={`bg-white border rounded-xl p-4 ${alert ? 'border-red-300' : 'border-gray-200'}`}>
      <div className="flex items-center gap-2 mb-1">{icon}<span className="text-xs text-gray-500 font-medium">{label}</span></div>
      <p className={`text-3xl font-bold ${alert ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function TrailPanel({ data }: { data: Record<string, unknown> | null }) {
  if (!data) return <p className="text-gray-500 text-sm">No data</p>;

  const report = data.report as Record<string, unknown> | undefined;
  const trail = data.audit_trail as Array<Record<string, unknown>> | undefined ?? [];
  const sla = data.sla as Record<string, unknown> | undefined;

  return (
    <div className="space-y-4">
      {/* SLA summary */}
      {sla && (
        <div className={`rounded-lg p-3 border text-sm ${sla.resolve_breached ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
          <p className="font-medium mb-1">{sla.resolve_breached ? '⚠️ SLA Breached' : '✓ Within SLA'}</p>
          <p className="text-xs text-gray-600">
            Open {String(sla.hours_open)}h · Resolve threshold: {String(sla.resolve_threshold_hours)}h
            {sla.resolved_within_sla !== null && ` · Resolved within SLA: ${sla.resolved_within_sla ? 'Yes' : 'No'}`}
          </p>
        </div>
      )}

      {/* Report summary */}
      {report && (
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="font-semibold">{String(report.report_number ?? report.grievance_number ?? '')}</p>
          <p className="text-gray-700 mt-0.5">{String(report.title ?? report.subject ?? '')}</p>
          <div className="flex gap-4 mt-2 text-xs text-gray-500">
            <span>Status: <b className="text-gray-800">{String(report.status ?? '')}</b></span>
            {report.assigned_to_name ? <span>Assigned: <b className="text-gray-800">{String(report.assigned_to_name)}</b></span> : null}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Timeline ({trail.length} entries)</p>
        <div className="relative pl-5 border-l-2 border-gray-200 space-y-4">
          {trail.map((entry, i) => (
            <div key={i} className="relative">
              <div className={`absolute -left-[21px] top-1 w-3 h-3 rounded-full border-2 border-white ${
                entry.author_role === 'system' ? 'bg-gray-300' :
                entry.author_role === 'reporter' ? 'bg-blue-400' :
                entry.is_internal ? 'bg-yellow-400' : 'bg-green-400'
              } `} />
              <div className="bg-white border border-gray-200 rounded-lg p-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-gray-800">
                    {entry.author_name ? String(entry.author_name) : String(entry.author_role ?? '')}
                  </span>
                  {entry.is_internal ? (
                    <span className="text-xs bg-yellow-50 border border-yellow-200 text-yellow-700 px-1.5 py-0.5 rounded">internal note</span>
                  ) : null}
                  <span className="text-xs text-gray-400 ml-auto">
                    {new Date(String(entry.created_at)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </div>
                <p className="text-gray-600">{String(entry.message ?? '')}</p>
              </div>
            </div>
          ))}
          {trail.length === 0 && <p className="text-sm text-gray-500">No actions recorded yet</p>}
        </div>
      </div>
    </div>
  );
}
