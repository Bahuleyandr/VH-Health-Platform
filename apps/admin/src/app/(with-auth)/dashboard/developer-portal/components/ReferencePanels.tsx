import { BookOpen, Check } from "lucide-react";
import type { DeveloperPortalSummary } from "@/lib/api/developerPortal";
import { formatDate } from "./helpers";

export function IntegrationGuidePanel({ portal }: { portal: DeveloperPortalSummary }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-teal-700" />
        <h2 className="text-lg font-semibold text-slate-950">Integration guide</h2>
      </div>
      <div className="mt-4 space-y-4 text-sm text-slate-600">
        <p>{portal.integration_guide.base_url_hint}</p>
        {[portal.integration_guide.authentication, portal.integration_guide.lifecycle, portal.integration_guide.security_notes].map((items, index) => (
          <ul key={index} className="space-y-2">
            {items.map((item) => (
              <li key={item} className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

export function ScopeDictionaryPanel({ portal }: { portal: DeveloperPortalSummary }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-slate-950">Scope dictionary</h2>
      <div className="mt-4 grid gap-3">
        {portal.scope_dictionary.map((scope) => (
          <div key={scope.key} className="rounded-md border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className="font-mono text-sm font-semibold text-slate-950">{scope.key}</code>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-xs capitalize text-slate-700">
                {scope.risk}
              </span>
            </div>
            <p className="mt-2 text-sm font-medium text-slate-800">{scope.label}</p>
            <p className="mt-1 text-sm text-slate-600">{scope.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AuditTrailPanel({ portal }: { portal: DeveloperPortalSummary }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-slate-950">Audit trail</h2>
      <div className="mt-4 overflow-hidden rounded-md border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Event</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {portal.audit_events.map((event) => (
              <tr key={String(event.id)}>
                <td className="px-4 py-3">
                  <span className="block font-medium text-slate-950">{event.event_type}</span>
                  <span className="block text-xs text-slate-500">{event.summary || "Recorded"}</span>
                </td>
                <td className="px-4 py-3 text-slate-700">{event.actor_role || "system"}</td>
                <td className="px-4 py-3 text-slate-500">{formatDate(event.created_at)}</td>
              </tr>
            ))}
            {portal.audit_events.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                  No audit events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
