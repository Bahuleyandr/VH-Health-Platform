// src/app/(with-auth)/dashboard/lab/page.tsx
//
// Lab admin page — Sprint 3. Two tabs:
//   1. Pathologist worklist (results pending sign-off)
//   2. Critical alerts (NABH 5.6 acknowledgement workflow)

"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { fetchAdminAPI } from "@/lib/api";
import { payloadIdentity } from "@/lib/idempotencyKey";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { LAB_CHANNEL, labRefetchMs } from "./realtime";

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

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
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
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [signedByName, setSignedByName] = useState("");
  const [signedByReg, setSignedByReg] = useState("");

  const {
    data: rows = [],
    error,
    isLoading,
  } = useQuery<PendingResult[]>({
    queryKey: ["lab", "pathologist", "pending"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/lab/pathologist/pending?limit=200",
      );
      const data = unwrap<PendingResult[]>(r);
      return Array.isArray(data) ? data : [];
    },
  });

  // `/lab/pathologist/signoff` is mounted with requireIdempotencyKey({
  // required: true, scope: 'lab-pathologist-signoff' }). One key per
  // (result set + decision + signer) attempt so a double-click replays the
  // first sign-off instead of signing the batch twice; rotated on success.
  const signOffKey = useIdempotencyKey("lab-pathologist-signoff");

  const signMutation = useMutation({
    mutationFn: async (decision: "verified" | "rejected") => {
      if (selected.size === 0) throw new Error("Nothing selected");
      if (!signedByName) {
        throw new Error("Pathologist name is required for sign-off");
      }
      const body = {
        result_ids: Array.from(selected),
        decision,
        signed_off_by_name: signedByName,
        signed_off_by_reg: signedByReg,
      };
      return fetchAdminAPI("/lab/pathologist/signoff", {
        method: "POST",
        body,
        headers: {
          "Idempotency-Key": signOffKey.keyFor(payloadIdentity(body)),
        },
      });
    },
    onSuccess: () => {
      signOffKey.reset();
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["lab", "pathologist", "pending"] });
    },
  });

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : String(error)
    : signMutation.error
      ? signMutation.error instanceof Error
        ? signMutation.error.message
        : String(signMutation.error)
      : null;

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
          onClick={() => signMutation.mutate("verified")}
          disabled={selected.size === 0 || signMutation.isPending}
          className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
        >
          {signMutation.isPending ? "Signing…" : `Verify (${selected.size})`}
        </button>
        <button
          onClick={() => signMutation.mutate("rejected")}
          disabled={selected.size === 0 || signMutation.isPending}
          className="px-3 py-2 rounded-md bg-rose-600 text-white text-sm disabled:opacity-40"
        >
          Reject
        </button>
        <div className="flex-1" />
        <button
          onClick={() =>
            qc.invalidateQueries({
              queryKey: ["lab", "pathologist", "pending"],
            })
          }
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {errorMessage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Inbox zero"
          description="No results pending sign-off."
        />
      ) : (
        <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
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
                <tr
                  key={r.id}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
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
                    {r.value_numeric != null
                      ? r.value_numeric
                      : (r.value_text ?? "—")}
                    {r.unit ? (
                      <span className="text-muted-foreground"> {r.unit}</span>
                    ) : null}
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

function CriticalAlerts({ subscribed }: { subscribed: boolean }) {
  const qc = useQueryClient();
  const [readBack, setReadBack] = useState<{ name: string; method: string }>({
    name: "",
    method: "phone",
  });

  const {
    data: rows = [],
    error,
    isLoading,
  } = useQuery<CriticalAlert[]>({
    queryKey: ["lab", "alerts", "critical"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/lab/alerts/critical?limit=100");
      const data = unwrap<CriticalAlert[]>(r);
      return Array.isArray(data) ? data : [];
    },
    refetchInterval: labRefetchMs(subscribed, 60_000),
  });

  const ackMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!readBack.name) {
        throw new Error("Acknowledger name is required for read-back");
      }
      return fetchAdminAPI(`/lab/alerts/critical/${id}/ack`, {
        method: "POST",
        body: {
          acknowledged_by_name: readBack.name,
          read_back_method: readBack.method,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lab", "alerts", "critical"] });
    },
  });

  const open = rows.filter((r) => !r.acknowledged_at);
  const closed = rows.filter((r) => r.acknowledged_at);

  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : String(error)
    : ackMutation.error
      ? ackMutation.error instanceof Error
        ? ackMutation.error.message
        : String(ackMutation.error)
      : null;

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
          <label className="text-xs text-muted-foreground block mb-1">
            Method
          </label>
          <select
            value={readBack.method}
            onChange={(e) =>
              setReadBack({ ...readBack, method: e.target.value })
            }
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="phone">Phone</option>
            <option value="in_person">In person</option>
            <option value="message">Secure message</option>
          </select>
        </div>
        <div className="flex-1" />
        <button
          onClick={() =>
            qc.invalidateQueries({ queryKey: ["lab", "alerts", "critical"] })
          }
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {errorMessage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : (
        <>
          <section>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              Open <span className="text-rose-600">{open.length}</span>
            </h3>
            {open.length === 0 ? (
              <EmptyState
                title="All clear"
                description="No open critical alerts."
                compact
              />
            ) : (
              <div className="bg-card rounded-lg border border-rose-200 shadow-sm overflow-x-auto">
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
                          <td className="px-3 py-2 font-medium">
                            {r.test_name}
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {r.value_numeric != null
                              ? r.value_numeric
                              : (r.value_text ?? "—")}
                            {r.unit ? (
                              <span className="text-muted-foreground">
                                {" "}
                                {r.unit}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {r.threshold_breached ?? "—"}{" "}
                            {r.threshold_value != null
                              ? `(${r.threshold_value})`
                              : ""}
                          </td>
                          <td className="px-3 py-2 text-xs font-mono">
                            {r.patient_uid.slice(0, 8)}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {fmtTs(r.fired_at)}
                          </td>
                          <td
                            className={`px-3 py-2 text-xs ${
                              stale ? "text-rose-600 font-semibold" : ""
                            }`}
                          >
                            {ageH}h
                          </td>
                          <td className="px-3 py-2">
                            <button
                              onClick={() => ackMutation.mutate(r.id)}
                              disabled={ackMutation.isPending}
                              className="px-2 py-1 rounded text-xs bg-emerald-600 text-white disabled:opacity-40"
                            >
                              {ackMutation.isPending ? "…" : "Acknowledge"}
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
              <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
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
                          {r.value_numeric != null
                            ? r.value_numeric
                            : (r.value_text ?? "—")}
                        </td>
                        <td className="px-3 py-2">
                          {r.acknowledged_by_name ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.read_back_method ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {fmtTs(r.fired_at)}
                        </td>
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
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(LAB_CHANNEL, [
    ["lab", "pathologist"],
    ["lab", "alerts"],
  ]);

  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:lab — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:lab"
    : connected
      ? "Connecting…"
      : "Polling (real-time unavailable)";

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-6">
        <h1 className="text-3xl font-bold text-foreground">Laboratory</h1>
        <span
          data-testid="lab-realtime-indicator"
          role="status"
          aria-label={
            subscribed
              ? "Live — real-time lab updates active"
              : "Polling — real-time updates unavailable"
          }
          title={liveTitle}
          className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
        >
          {liveLabel}
        </span>
      </div>
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
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "worklist" && <PathologistWorklist />}
      {tab === "alerts" && <CriticalAlerts subscribed={subscribed} />}
    </div>
  );
}
