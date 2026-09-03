// src/app/(with-auth)/dashboard/mar/page.tsx
//
// Sprint 14 — Medication Administration Record with 5-rights + barcode.
// Backend (services/clinical/marService.js + routes/clinical/clinicalRoutes
// /mar/*) was already shipped. This is the medication-round screen
// nurses use at the bedside.
//
// Workflow:
//   1. Pick a patient from the "due now" list
//   2. Scan / enter the patient wristband barcode (5R: right patient)
//   3. Scan / enter the drug strip barcode (5R: right drug, dose)
//   4. Backend's /mar/:id/administer-with-scan validates all 5 rights
//      and records the administration. Mismatch ⇒ rejected with
//      override_reason required.
//
// In a real deployment a USB barcode scanner enters the value into
// the focused input. Here we fall back to manual entry.
//
// "Print band" — on each dose row and beside the wristband field in the
// 5-rights modal — opens the backend's printable wristband for that patient.
// That band is the producer of the Code 39 barcode step 2 above asks the
// nurse to scan. See src/lib/bcmaWristband.ts for why it goes through the
// portal proxy rather than straight to the backend, and for who the backend
// lets print: the bedside nursing and treating-clinician roles this page is
// for, PLUS administrators. An ADMIN or SUPER_ADMIN session may print without
// break-glass; the backend admits it and writes an audit row instead
// (bcmaRoutes.js:50 quoting the 2026-08-25 owner decision, and
// WRISTBAND_ADMIN_AUDIT_ACTION = 'wristband-print-administrative-access' at
// :120). This comment previously claimed administrators get a 403 here; that
// was wrong, and mar-print-band.test.tsx pins the admitted behaviour.

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { usePermissions } from "@/hooks/usePermissions";
import { MAR_DUE_LIST_ROLES } from "@/lib/marRoles";
import { printableWristbandUrl } from "@/lib/bcmaWristband";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface MarDose {
  id: number;
  patient_uid: string;
  prescription_id: number | null;
  medication_name: string;
  dose: string | null;
  dosage: string | null;
  route: string | null;
  scheduled_time: string | null;
  status: "scheduled" | "administered" | "missed" | "held" | "refused";
  administered_at: string | null;
  notes: string | null;
}

interface RightsResult {
  all_rights_passed: boolean;
  rights_passed: Record<string, boolean>;
  failures?: string[];
}

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  if (Array.isArray(data)) return data as T[];
  for (const k of ["doses", "rows", "items"]) {
    const inner = (data as Record<string, unknown>)?.[k];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function fmtTime(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function minsLate(scheduled: string | null): number | null {
  if (!scheduled) return null;
  const diff = Date.now() - new Date(scheduled).getTime();
  return Math.round(diff / 60000);
}

/**
 * Opens the printable wristband for this patient in a new tab — the band whose
 * Code 39 barcode is the value the patient-scan field asks for.
 *
 * A plain link rather than a scripted `window.open`, so nothing in the
 * medication round depends on a popup succeeding or on any JS running here.
 *
 * Rendered for every viewer, because the backend is the only authority on
 * patient access and re-deciding it here would give a second, drifting answer.
 * It answers in the new tab: a bedside nursing or treating-clinician session
 * gets the band; an ADMIN/SUPER_ADMIN session also gets it, without
 * break-glass, and the print is recorded as administrative access (owner
 * decision 2026-08-25); any other staff role with no care relationship to the
 * patient gets a 403. Nothing on this page changes in any of those cases.
 */
function PrintBandLink({
  patientUid,
  className,
}: {
  patientUid: string;
  className: string;
}) {
  const href = printableWristbandUrl(patientUid);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open the printable wristband (Code 39 patient barcode) in a new tab"
      className={className}
    >
      Print band
    </a>
  );
}

export default function MarPage() {
  const qc = useQueryClient();
  const [windowMins, setWindowMins] = useState(60);
  const [scanning, setScanning] = useState<MarDose | null>(null);

  // Only the two ENUMERATE reads below are nursing-only. The backend guards
  // /clinical/mar/due and /clinical/mar/overdue with requireMarDueListRole over
  // MAR_DUE_LIST_ROLES (clinicalRoutes.js:145-153,186-191), which deliberately
  // omits ADMIN and SUPER_ADMIN — enumerating every due dose in the hospital is
  // a bedside nursing act.
  //
  // This is scoped to the queries ON PURPOSE, not lifted to the route policy.
  // The page carries four different backend contracts and only this one
  // excludes administrators: administer-with-scan admits ADMIN and SUPER_ADMIN
  // (MEDICATION_ADMINISTRATION_ROLES, clinicalRoutes.js:126-137), /mar/verify
  // carries no role gate at all, and wristband print admits administrators by
  // explicit owner decision with an audit row (bcmaRoutes.js:50,120). Gating
  // the whole route would revoke three grants to silence one.
  //
  // rawRole, not `allowed` — usePermissions short-circuits SUPER_ADMIN to true
  // (usePermissions.ts:58,70), which is exactly the identity this must refuse.
  const { rawRole } = usePermissions();
  const canEnumerateDueList = MAR_DUE_LIST_ROLES.includes(rawRole ?? "");

  const {
    data: due = [],
    error,
    isLoading,
  } = useQuery<MarDose[]>({
    queryKey: ["mar", "due", windowMins],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        `/clinical/mar/due?within_minutes=${windowMins}&limit=200`,
      );
      return unwrapList<MarDose>(r);
    },
    enabled: canEnumerateDueList,
    refetchInterval: 30_000,
  });

  const { data: overdue = [] } = useQuery<MarDose[]>({
    queryKey: ["mar", "overdue"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/clinical/mar/overdue?limit=100");
      return unwrapList<MarDose>(r);
    },
    enabled: canEnumerateDueList,
    refetchInterval: 30_000,
  });

  const errMsg = error?.toString();

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            Medication Administration
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            5-rights + barcode bedside flow. Auto-refreshes every 30s.
          </p>
        </div>
        <div className="flex gap-2 items-end">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Due window
            </label>
            <select
              value={windowMins}
              onChange={(e) => setWindowMins(Number(e.target.value))}
              className="border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value={30}>Next 30 min</option>
              <option value={60}>Next 1 hour</option>
              <option value={120}>Next 2 hours</option>
              <option value={240}>Next 4 hours</option>
            </select>
          </div>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ["mar"] })}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Refresh
          </button>
        </div>
      </div>

      {!canEnumerateDueList && (
        // Say why the lists are empty. Without this an administrator reads an
        // empty due list as "nothing is due", which is a worse answer than the
        // 403 this replaces. Deliberately avoids the route-crawl's
        // visible-error vocabulary (route-crawl.spec.ts:167) because this is a
        // scope notice, not a failure.
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          The due and overdue lists are limited to bedside nursing roles, so
          they are not shown for your role. The 5-rights check, barcode
          administration and wristband printing on this page remain available.
        </div>
      )}
      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {/* Headline */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="bg-card rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Due in window</p>
          <p className="text-xl font-semibold mt-1">{due.length}</p>
        </div>
        <div
          className={`bg-card rounded-lg border shadow-sm p-3 ${
            overdue.length > 0 ? "border-rose-300" : ""
          }`}
        >
          <p className="text-xs text-muted-foreground">Overdue</p>
          <p
            className={`text-xl font-semibold mt-1 ${
              overdue.length > 0 ? "text-rose-700" : ""
            }`}
          >
            {overdue.length}
          </p>
        </div>
        <div className="bg-card rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Total to round</p>
          <p className="text-xl font-semibold mt-1">
            {due.length + overdue.length}
          </p>
        </div>
      </div>

      {/* Overdue list (top — most urgent) */}
      {overdue.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-rose-700 mb-2">
            Overdue ({overdue.length})
          </h2>
          <DoseList rows={overdue} onScan={(d) => setScanning(d)} overdue />
        </section>
      )}

      {/* Due list */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          Due in next {windowMins} min ({due.length})
        </h2>
        {isLoading ? (
          <LoadingSpinner />
        ) : due.length === 0 ? (
          <EmptyState
            title="Nothing due"
            description="No medications scheduled in this window."
          />
        ) : (
          <DoseList rows={due} onScan={(d) => setScanning(d)} />
        )}
      </section>

      {scanning && (
        <ScanModal
          dose={scanning}
          onClose={() => setScanning(null)}
          onSaved={() => {
            setScanning(null);
            qc.invalidateQueries({ queryKey: ["mar"] });
          }}
        />
      )}
    </div>
  );
}

function DoseList({
  rows,
  onScan,
  overdue,
}: {
  rows: MarDose[];
  onScan: (d: MarDose) => void;
  overdue?: boolean;
}) {
  return (
    <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-xs text-muted-foreground border-b">
          <tr className="text-left">
            <th className="px-3 py-2">Scheduled</th>
            <th className="px-3 py-2">Patient</th>
            <th className="px-3 py-2">Medication</th>
            <th className="px-3 py-2">Dose</th>
            <th className="px-3 py-2">Route</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const late = minsLate(d.scheduled_time);
            return (
              <tr
                key={d.id}
                className={`border-b last:border-0 ${
                  overdue ? "bg-rose-50/50" : "hover:bg-muted/30"
                }`}
              >
                <td className="px-3 py-2 text-xs">
                  <div>{fmtTime(d.scheduled_time)}</div>
                  {late != null && late > 0 && (
                    <div className="text-rose-700 font-semibold">
                      +{late}m late
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs font-mono">
                  {d.patient_uid.slice(0, 8)}
                </td>
                <td className="px-3 py-2 font-medium">{d.medication_name}</td>
                <td className="px-3 py-2 text-xs">
                  {d.dose ?? d.dosage ?? "—"}
                </td>
                <td className="px-3 py-2 text-xs">{d.route ?? "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-2">
                    <PrintBandLink
                      patientUid={d.patient_uid}
                      className="px-2 py-1 rounded border border-border text-xs hover:bg-muted"
                    />
                    <button
                      onClick={() => onScan(d)}
                      className="px-2 py-1 rounded bg-blue-600 text-white text-xs"
                    >
                      Administer →
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ScanModal({
  dose,
  onClose,
  onSaved,
}: {
  dose: MarDose;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [patientBarcode, setPatientBarcode] = useState("");
  const [drugBarcode, setDrugBarcode] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [verifyResult, setVerifyResult] = useState<RightsResult | null>(null);

  const verifyMut = useMutation({
    mutationFn: async () => {
      const r = await fetchAdminAPI<unknown>("/clinical/mar/verify", {
        method: "POST",
        body: {
          mar_id: dose.id,
          scanned_patient_uid: patientBarcode,
          scanned_barcode: drugBarcode,
        },
      });
      return unwrap<RightsResult>(r);
    },
    onSuccess: (data) => setVerifyResult(data),
  });

  const administerMut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI(`/clinical/mar/${dose.id}/administer-with-scan`, {
        method: "POST",
        body: {
          scanned_patient_uid: patientBarcode,
          scanned_barcode: drugBarcode,
          override_reason: overrideReason || undefined,
        },
      }),
    onSuccess: onSaved,
  });

  const errMsg = (verifyMut.error ?? administerMut.error)?.toString();
  const allRightsPassed = verifyResult?.all_rights_passed === true;
  const canAdministerWithoutOverride = allRightsPassed;
  const canAdministerWithOverride =
    verifyResult && !allRightsPassed && overrideReason.length >= 10;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-card rounded-lg shadow-lg w-full max-w-lg">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold">5-Rights Check</h2>
          <p className="text-sm text-muted-foreground mt-1">
            <strong>{dose.medication_name}</strong> · {dose.dose ?? dose.dosage}
            {dose.route && ` · ${dose.route}`} · scheduled{" "}
            {fmtTime(dose.scheduled_time)}
          </p>
          <p className="text-xs text-muted-foreground font-mono mt-1">
            Patient {dose.patient_uid.slice(0, 8)}
          </p>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className="text-xs text-muted-foreground">
                1️⃣ Scan patient wristband (UID)
              </label>
              <PrintBandLink
                patientUid={dose.patient_uid}
                className="text-xs underline text-muted-foreground hover:text-foreground"
              />
            </div>
            <input
              autoFocus
              value={patientBarcode}
              onChange={(e) => {
                setPatientBarcode(e.target.value);
                setVerifyResult(null);
              }}
              placeholder="11111111-1111-…"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              2️⃣ Scan drug barcode
            </label>
            <input
              value={drugBarcode}
              onChange={(e) => {
                setDrugBarcode(e.target.value);
                setVerifyResult(null);
              }}
              placeholder="GTIN / drug strip code"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>

          <button
            onClick={() => verifyMut.mutate()}
            disabled={verifyMut.isPending || !patientBarcode || !drugBarcode}
            className="w-full px-3 py-2 rounded-md border text-sm hover:bg-muted disabled:opacity-40"
          >
            {verifyMut.isPending ? "Checking…" : "Verify 5 rights"}
          </button>

          {verifyResult && (
            <div
              className={`rounded-lg border p-3 ${
                allRightsPassed
                  ? "bg-emerald-50 border-emerald-300"
                  : "bg-rose-50 border-rose-300"
              }`}
            >
              <p className="text-sm font-semibold mb-2">
                {allRightsPassed
                  ? "✓ All 5 rights passed"
                  : "✗ Rights check FAILED"}
              </p>
              <ul className="text-xs space-y-1">
                {Object.entries(verifyResult.rights_passed).map(([k, ok]) => (
                  <li key={k} className="flex items-center gap-2">
                    <span className={ok ? "text-emerald-700" : "text-rose-700"}>
                      {ok ? "✓" : "✗"}
                    </span>
                    <span>{k.replace(/_/g, " ")}</span>
                  </li>
                ))}
              </ul>
              {verifyResult.failures && verifyResult.failures.length > 0 && (
                <div className="mt-2 text-xs text-rose-800">
                  <p className="font-semibold">Failures:</p>
                  <ul className="list-disc list-inside">
                    {verifyResult.failures.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {verifyResult && !allRightsPassed && (
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Override reason (≥10 chars, audited)
              </label>
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                rows={2}
                className="w-full border border-rose-300 rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. Drug strip damaged but verified visually with witness Dr. X"
              />
            </div>
          )}

          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={() => administerMut.mutate()}
            disabled={
              administerMut.isPending ||
              (!canAdministerWithoutOverride && !canAdministerWithOverride)
            }
            className={`px-3 py-2 rounded-md text-white text-sm disabled:opacity-40 ${
              allRightsPassed ? "bg-emerald-600" : "bg-rose-600"
            }`}
          >
            {administerMut.isPending
              ? "Recording…"
              : allRightsPassed
                ? "Administer"
                : "Administer with override"}
          </button>
        </div>
      </div>
    </div>
  );
}
