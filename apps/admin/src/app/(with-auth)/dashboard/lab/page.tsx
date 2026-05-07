// src/app/(with-auth)/dashboard/lab/page.tsx
//
// Lab admin page — Sprint 3. Two tabs:
//   1. Pathologist worklist (results pending sign-off)
//   2. Critical alerts (NABH 5.6 acknowledgement workflow)
//
// Hits /api/v1/lab/pathologist/pending and /api/v1/lab/alerts/critical.

"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

type Tab = "worklist" | "alerts";

interface PendingResult {
  id: number;
  patient_uid: string;
  test_name: string;
  test_code: string | null;
  observation_datetime: string | null;
  value_text: string | null;
  value_numeric: number | null;
  unit: string | null;
  reference_range: string | null;
  abnormal_flag: string | null;
  received_at: string;
}

interface CriticalAlert {
  id: number;
  patient_uid: string;
  test_name: string;
  value_text: string | null;
  value_numeric: number | null;
  unit: string | null;
  threshold_breached: string | null;
  threshold_value: number | null;
  fired_at: string;
  acknowledged_at: string | null;
  acknowledged_by_name: string | null;
  read_back_method: string | null;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

function ageHours(s: string): number {
  const d = new Date(s).getTime();
  return Math.round((Date.now() - d) / 3_600_000);
}

function PathologistWorklist() {
  const [rows, setRows] = useState<PendingResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [signing, setSigning] = useState(false);
  const [signedByName, setSignedByName] = useState("");
  const [signedByReg, setSignedByReg] = useState("");

  const fetchPending = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: PendingResult[] } | PendingResult[]>(
        "/lab/pathologist/pending?limit=200",
      );
      const data = (r as { data?: PendingResult[] }).data ?? (r as PendingResult[]);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load worklist");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function signOff(decision: "verified" | "rejected") {
    if (selected.size === 0) return;
    if (!signedByName) {
      setError("Pathologist name is required for sign-off");
      return;
    }
    setSigning(true);
    setError(null);
    try {
      await fetchAdminAPI("/lab/pathologist/signoff", {
        method: "POST",
        body: JSON.stringify({
          result_ids: Array.from(selected),
          decision,
          signed_off_by_name: signedByName,
          signed_off_by_reg: signedByReg,
        }),
      });
      setSelected(new Set());
      await fetchPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-off failed");
    } finally {
      setSigning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Pathologist name
          </label>
          <input
            value={signedByName}
            onChange={(e) => setSignedByName(e.target.value)}
            placeholder="Dr. ..."
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Council reg #
          </label>
          <input
            value={signedByReg}
            onChange={(e) => setSignedByReg(e.target.value)}
            placeholder="MCI/SMC"
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={() => signOff("verified")}
          disabled={selected.size === 0 || signing}
          className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
        >
          {signing ? "Signing…" : `Verify (${selected.size})`}
        </button>
        <button
          onClick={() => signOff("rejected")}
          disabled={selected.size === 0 || signing}
          className="px-3 py-2 rounded-md bg-rose-600 text-white text-sm disabled:opacity-40"
        >
          Reject
        </button>
        <div className="flex-1" />
        <button
          onClick={fetchPending}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="Inbox zero" description="No results pending sign-off." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2">Test</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">Range</th>
                <th className="px-3 py-2">Flag</th>
                <th className="px-3 py-2">Received</th>
                <th className="px-3 py-2">Patient</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div>{r.test_name}</div>
                    {r.test_code && (
                      <div className="text-xs text-muted-foreground font-mono">
                        {r.test_code}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {r.value_numeric != null ? r.value_numeric : r.value_text ?? "—"}
                    {r.unit ? <span className="text-muted-foreground"> {r.unit}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.reference_range ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.abnormal_flag ? (
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          r.abnormal_flag.toUpperCase().includes("H") ||
                          r.abnormal_flag.toUpperCase().includes("L")
                            ? "bg-amber-100 text-amber-800"
                            : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {r.abnormal_flag}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtTs(r.received_at)}</td>
                  <td className="px-3 py-2 text-xs font-mono">
                    {r.patient_uid.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CriticalAlerts() {
  const [rows, setRows] = useState<CriticalAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acking, setAcking] = useState<number | null>(null);
  const [readBack, setReadBack] = useState<{ name: string; method: string }>({
    name: "",
    method: "phone",
  });

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: CriticalAlert[] } | CriticalAlert[]>(
        "/lab/alerts/critical?limit=100",
      );
      const data = (r as { data?: CriticalAlert[] }).data ?? (r as CriticalAlert[]);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    const i = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(i);
  }, [fetchAlerts]);

  async function acknowledge(id: number) {
    if (!readBack.name) {
      setError("Acknowledger name is required for read-back");
      return;
    }
    setAcking(id);
    setError(null);
    try {
      await fetchAdminAPI(`/lab/alerts/critical/${id}/ack`, {
        method: "POST",
        body: JSON.stringify({
          acknowledged_by_name: readBack.name,
          read_back_method: readBack.method,
        }),
      });
      await fetchAlerts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Acknowledge failed");
    } finally {
      setAcking(null);
    }
  }

  const open = rows.filter((r) => !r.acknowledged_at);
  const closed = rows.filter((r) => r.acknowledged_at);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Acknowledger (read-back)
          </label>
          <input
            value={readBack.name}
            onChange={(e) => setReadBack({ ...readBack, name: e.target.value })}
            placeholder="Nurse / Dr ..."
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Method</label>
          <select
            value={readBack.method}
            onChange={(e) => setReadBack({ ...readBack, method: e.target.value })}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="phone">Phone</option>
            <option value="in_person">In person</option>
            <option value="message">Secure message</option>
          </select>
        </div>
        <div className="flex-1" />
        <button
          onClick={fetchAlerts}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : (
        <>
          <section>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              Open <span className="text-rose-600">{open.length}</span>
            </h3>
            {open.length === 0 ? (
              <EmptyState title="All clear" description="No open critical alerts." compact />
            ) : (
              <div className="bg-white rounded-lg border border-rose-200 shadow-sm overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr className="text-left">
                      <th className="px-3 py-2">Test</th>
                      <th className="px-3 py-2">Value</th>
                      <th className="px-3 py-2">Threshold</th>
                      <th className="px-3 py-2">Patient</th>
                      <th className="px-3 py-2">Fired</th>
                      <th className="px-3 py-2">Age</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.map((r) => {
                      const ageH = ageHours(r.fired_at);
                      const stale = ageH >= 1;
                      return (
                        <tr
                          key={r.id}
                          className={`border-b last:border-0 ${
                            stale ? "bg-rose-50" : ""
                          }`}
                        >
                          <td className="px-3 py-2 font-medium">{r.test_name}</td>
                          <td className="px-3 py-2 font-mono">
                            {r.value_numeric != null ? r.value_numeric : r.value_text ?? "—"}
                            {r.unit ? (
                              <span className="text-muted-foreground"> {r.unit}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {r.threshold_breached ?? "—"}{" "}
                            {r.threshold_value != null ? `(${r.threshold_value})` : ""}
                          </td>
                          <td className="px-3 py-2 text-xs font-mono">
                            {r.patient_uid.slice(0, 8)}
                          </td>
                          <td className="px-3 py-2 text-xs">{fmtTs(r.fired_at)}</td>
                          <td
                            className={`px-3 py-2 text-xs ${
                              stale ? "text-rose-600 font-semibold" : ""
                            }`}
                          >
                            {ageH}h
                          </td>
                          <td className="px-3 py-2">
                            <button
                              onClick={() => acknowledge(r.id)}
                              disabled={acking === r.id}
                              className="px-2 py-1 rounded text-xs bg-emerald-600 text-white disabled:opacity-40"
                            >
                              {acking === r.id ? "…" : "Acknowledge"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {closed.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
                Acknowledged ({closed.length})
              </h3>
              <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr className="text-left">
                      <th className="px-3 py-2">Test</th>
                      <th className="px-3 py-2">Value</th>
                      <th className="px-3 py-2">Acknowledged by</th>
                      <th className="px-3 py-2">Method</th>
                      <th className="px-3 py-2">Fired</th>
                      <th className="px-3 py-2">Acked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closed.map((r) => (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="px-3 py-2">{r.test_name}</td>
                        <td className="px-3 py-2 font-mono">
                          {r.value_numeric != null ? r.value_numeric : r.value_text ?? "—"}
                        </td>
                        <td className="px-3 py-2">{r.acknowledged_by_name ?? "—"}</td>
                        <td className="px-3 py-2 text-xs">
                          {r.read_back_method ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-xs">{fmtTs(r.fired_at)}</td>
                        <td className="px-3 py-2 text-xs">
                          {fmtTs(r.acknowledged_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function LabPage() {
  const [tab, setTab] = useState<Tab>("worklist");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-6">Laboratory</h1>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit">
        {(
          [
            { key: "worklist", label: "🩸 Pathologist worklist" },
            { key: "alerts", label: "🚨 Critical alerts" },
          ] as { key: Tab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === key
                ? "bg-white text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "worklist" && <PathologistWorklist />}
      {tab === "alerts" && <CriticalAlerts />}
    </div>
  );
}
