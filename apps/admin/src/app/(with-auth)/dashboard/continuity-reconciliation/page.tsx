"use client";

import { FormEvent, useCallback, useMemo, useState } from "react";

import {
  approveClinicalContinuityIdentityMatch,
  attestClinicalContinuityClosure,
  checkClinicalContinuityClosure,
  closeClinicalContinuityIncident,
  decideClinicalContinuityReconciliationItem,
  executeClinicalContinuityIdentityMatch,
  loadClinicalContinuityWorkbench,
  proposeClinicalContinuityIdentityMatch,
  recordClinicalContinuityDeviceOffset,
  recordClinicalContinuityInterfaceRequirement,
  recordClinicalContinuityRangeDisposition,
  transitionClinicalContinuityIncident,
  type ClinicalContinuityClosure,
  type ClinicalContinuityFacilityAuthority,
  type ClinicalContinuityWorkbench,
} from "@/lib/api/clinicalContinuityReconciliation";

type Incident = ClinicalContinuityWorkbench["incidents"][number];
type PaperRange = ClinicalContinuityWorkbench["paper_ranges"][number];
type QueueItem = ClinicalContinuityWorkbench["reconciliation_items"][number];
type TemporaryIdentity =
  ClinicalContinuityWorkbench["temporary_identities"][number];
type DeviceOffset = ClinicalContinuityWorkbench["device_offsets"][number];
type InterfaceRequirement = ClinicalContinuityWorkbench["interfaces"][number];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_WORKBENCH: ClinicalContinuityWorkbench = {
  incidents: [],
  packets: [],
  paper_ranges: [],
  paper_items: [],
  reconciliation_items: [],
  temporary_identities: [],
  device_offsets: [],
  interfaces: [],
};
const ATTESTATION_ONLY_BLOCKERS = new Set([
  "CONTINUITY_CLOSURE_COMMANDER_ATTESTATION_REQUIRED",
  "CONTINUITY_CLOSURE_CLINICAL_ATTESTATION_REQUIRED",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The continuity command failed";
}

function isSafeProtocolInteger(
  value: string | number | null | undefined,
): boolean {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return false;
  }
  return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function toSafeProtocolInteger(value: string | number): number {
  if (!isSafeProtocolInteger(value)) {
    throw new TypeError(
      "The server high-water mark exceeds this client's safe integer contract",
    );
  }
  return Number(value);
}

function statusTone(status: string): string {
  if (
    [
      "closed",
      "accounted",
      "applied",
      "resolved",
      "reconciled",
      "matched",
    ].includes(status)
  ) {
    return "bg-emerald-100 text-emerald-900";
  }
  if (
    ["lost", "revoked", "needs_review", "assigned_gap", "unresolved"].includes(
      status,
    )
  ) {
    return "bg-rose-100 text-rose-900";
  }
  return "bg-amber-100 text-amber-900";
}

function Badge({ value }: { value: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone(value)}`}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h2 className="mb-3 text-lg font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export default function ContinuityReconciliationPage() {
  const [facilityId, setFacilityId] = useState("");
  const [facilityContext, setFacilityContext] = useState("");
  const [authority, setAuthority] =
    useState<ClinicalContinuityFacilityAuthority | null>(null);
  const [workbench, setWorkbench] = useState(EMPTY_WORKBENCH);
  const [incidentId, setIncidentId] = useState("");
  const [closure, setClosure] = useState<ClinicalContinuityClosure | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const incident = useMemo(
    () => workbench.incidents.find((row) => row.id === incidentId) ?? null,
    [incidentId, workbench.incidents],
  );
  const incidentRows = useMemo(
    () => ({
      ranges: workbench.paper_ranges.filter(
        (row) => row.incident_id === incidentId,
      ),
      paper: workbench.paper_items.filter(
        (row) => row.incident_id === incidentId,
      ),
      queue: workbench.reconciliation_items.filter(
        (row) => row.incident_id === incidentId,
      ),
      identities: workbench.temporary_identities.filter(
        (row) => row.incident_id === incidentId,
      ),
      devices: workbench.device_offsets.filter(
        (row) => row.incident_id === incidentId,
      ),
      interfaces: workbench.interfaces.filter(
        (row) => row.incident_id === incidentId,
      ),
    }),
    [incidentId, workbench],
  );
  const closureReadyForAttestation = Boolean(
    closure &&
    closure.blockers.every((blocker) =>
      ATTESTATION_ONLY_BLOCKERS.has(blocker.code),
    ),
  );

  const refresh = useCallback(
    async (
      nextAuthority: ClinicalContinuityFacilityAuthority,
      preferredIncident?: string,
    ) => {
      const data = await loadClinicalContinuityWorkbench(nextAuthority);
      setWorkbench(data);
      setIncidentId((current) => {
        const wanted = preferredIncident ?? current;
        return data.incidents.some((row) => row.id === wanted)
          ? wanted
          : (data.incidents[0]?.id ?? "");
      });
      setClosure(null);
    },
    [],
  );

  async function run(label: string, command: () => Promise<unknown>) {
    if (!authority) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await command();
      await refresh(authority, incidentId);
      setNotice(label);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    const parsedFacilityId = Number(facilityId);
    const context = facilityContext.trim();
    if (
      !Number.isSafeInteger(parsedFacilityId) ||
      parsedFacilityId < 1 ||
      !/^[A-Za-z0-9_-]+$/.test(context)
    ) {
      setError(
        "Enter a positive facility ID and a valid server-issued signed context.",
      );
      return;
    }
    const nextAuthority = {
      facilityId: parsedFacilityId,
      facilityContext: context,
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await refresh(nextAuthority);
      setAuthority(nextAuthority);
      setNotice("Facility-scoped workbench loaded.");
    } catch (cause) {
      setAuthority(null);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadClosure() {
    if (!authority || !incident) return;
    setBusy(true);
    setError("");
    try {
      setClosure(await checkClinicalContinuityClosure(authority, incident.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="space-y-5 p-6" aria-labelledby="continuity-title">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          C5.2 continuity control
        </p>
        <h1
          id="continuity-title"
          className="text-3xl font-bold text-foreground"
        >
          Paper reconciliation workbench
        </h1>
        <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
          Facility-scoped command surface for incident recovery, paper-range
          accounting, HIM identity resolution, interface recovery, and two-key
          closure. Eligibility, roles, versions, and evidence are enforced by
          the server.
        </p>
      </header>

      <div
        role="status"
        className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950"
      >
        <strong>Validation-only lane.</strong> Runtime activation remains
        unavailable until the signed C0.3 governance envelope and C-D14 operator
        runbook are accepted. This workbench does not provide an activation
        control.
      </div>

      <Panel title="Server-issued facility authority">
        <form
          onSubmit={connect}
          className="grid gap-3 md:grid-cols-[12rem_1fr_auto]"
        >
          <label className="text-sm font-medium text-foreground">
            Facility ID
            <input
              inputMode="numeric"
              value={facilityId}
              onChange={(event) => setFacilityId(event.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2"
              aria-describedby="authority-help"
            />
          </label>
          <label className="text-sm font-medium text-foreground">
            Signed facility context
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={facilityContext}
              onChange={(event) => setFacilityContext(event.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono"
              aria-describedby="authority-help"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="self-end rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-50"
          >
            Load workbench
          </button>
        </form>
        <p id="authority-help" className="mt-2 text-xs text-muted-foreground">
          Obtain the short-lived context from an enrolled managed device. It
          stays in this page&apos;s memory only and is never persisted.
        </p>
      </Panel>

      <div aria-live="polite">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
            {notice}
          </p>
        )}
      </div>

      {authority && (
        <>
          <Panel title="Incident">
            {workbench.incidents.length === 0 ? (
              <Empty>No incident is available for this facility.</Empty>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-80 flex-1 text-sm font-medium text-foreground">
                  Incident record
                  <select
                    value={incidentId}
                    onChange={(event) => {
                      setIncidentId(event.target.value);
                      setClosure(null);
                    }}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                  >
                    {workbench.incidents.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.id} · {row.lifecycle_state} · v{row.version}
                      </option>
                    ))}
                  </select>
                </label>
                <ActionButton
                  disabled={busy}
                  onClick={() => refresh(authority, incidentId)}
                >
                  Refresh
                </ActionButton>
                {incident && (
                  <IncidentTransition
                    incident={incident}
                    busy={busy}
                    run={run}
                    authority={authority}
                  />
                )}
              </div>
            )}
          </Panel>

          {incident && (
            <>
              <div className="grid gap-5 xl:grid-cols-2">
                <Panel title="Signed packets and paper ranges">
                  <p className="mb-3 text-sm text-muted-foreground">
                    {workbench.packets.length} packet
                    {workbench.packets.length === 1 ? "" : "s"} registered for
                    the facility.
                  </p>
                  {incidentRows.ranges.length === 0 ? (
                    <Empty>No range is attached to this incident.</Empty>
                  ) : (
                    <div className="space-y-3">
                      {incidentRows.ranges.map((range) => (
                        <RangeRow
                          key={range.id}
                          range={range}
                          authority={authority}
                          busy={busy}
                          run={run}
                        />
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel title="Paper facts">
                  {incidentRows.paper.length === 0 ? (
                    <Empty>No paper item is registered.</Empty>
                  ) : (
                    <ul className="space-y-2">
                      {incidentRows.paper.map((item) => (
                        <li
                          key={item.id}
                          className="rounded-lg border border-border p-3 text-sm"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <code>{item.paper_item_id}</code>
                            <Badge value={item.reconciliation_disposition} />
                          </div>
                          <p className="mt-1 text-muted-foreground">
                            {item.item_kind.replaceAll("_", " ")} · v
                            {item.version}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>

              <Panel title="Typed reconciliation queues">
                {incidentRows.queue.length === 0 ? (
                  <Empty>No queue item is open.</Empty>
                ) : (
                  <div className="grid gap-3 lg:grid-cols-2">
                    {incidentRows.queue.map((item) => (
                      <QueueRow
                        key={item.id}
                        item={item}
                        authority={authority}
                        busy={busy}
                        run={run}
                      />
                    ))}
                  </div>
                )}
              </Panel>

              <div className="grid gap-5 xl:grid-cols-2">
                <Panel title="HIM temporary identities">
                  {incidentRows.identities.length === 0 ? (
                    <Empty>No temporary identity is pending.</Empty>
                  ) : (
                    <div className="space-y-3">
                      {incidentRows.identities.map((identity) => (
                        <IdentityRow
                          key={identity.id}
                          identity={identity}
                          paperRowId={
                            incidentRows.paper.find(
                              (row) =>
                                row.temporary_identity_id === identity.id,
                            )?.id ?? null
                          }
                          packetId={incident.packet_id ?? null}
                          authority={authority}
                          busy={busy}
                          run={run}
                        />
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel title="Device high-water marks">
                  {incidentRows.devices.length === 0 ? (
                    <Empty>No device offset is registered.</Empty>
                  ) : (
                    <div className="space-y-3">
                      {incidentRows.devices.map((device) => (
                        <DeviceRow
                          key={device.id}
                          device={device}
                          authority={authority}
                          busy={busy}
                          run={run}
                        />
                      ))}
                    </div>
                  )}
                </Panel>
              </div>

              <Panel title="Interface recovery requirements">
                {incidentRows.interfaces.length === 0 ? (
                  <Empty>No interface requirement is registered.</Empty>
                ) : (
                  <div className="grid gap-3 lg:grid-cols-2">
                    {incidentRows.interfaces.map((requirement) => (
                      <InterfaceRow
                        key={requirement.id}
                        requirement={requirement}
                        authority={authority}
                        busy={busy}
                        run={run}
                      />
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Two-key closure">
                <div className="flex flex-wrap gap-2">
                  <ActionButton disabled={busy} onClick={loadClosure}>
                    Recompute locked predicate
                  </ActionButton>
                  <ActionButton
                    disabled={busy || !closureReadyForAttestation}
                    onClick={() =>
                      run("Operational attestation recorded.", () =>
                        attestClinicalContinuityClosure(
                          authority,
                          incident.id,
                          {
                            expected_version: incident.version,
                            attestation_kind: "operational",
                          },
                        ),
                      )
                    }
                  >
                    Operational attest
                  </ActionButton>
                  <ActionButton
                    disabled={busy || !closureReadyForAttestation}
                    onClick={() =>
                      run("Clinical attestation recorded.", () =>
                        attestClinicalContinuityClosure(
                          authority,
                          incident.id,
                          {
                            expected_version: incident.version,
                            attestation_kind: "clinical",
                          },
                        ),
                      )
                    }
                  >
                    Clinical attest
                  </ActionButton>
                  <ActionButton
                    disabled={busy || !closure?.eligible}
                    onClick={() =>
                      run("Incident closed against the locked snapshot.", () =>
                        closeClinicalContinuityIncident(
                          authority,
                          incident.id,
                          incident.version,
                        ),
                      )
                    }
                  >
                    Close incident
                  </ActionButton>
                </div>
                {closure && (
                  <div className="mt-3 rounded-lg border border-border p-3 text-sm">
                    <p>
                      <strong>
                        {closure.eligible ? "Eligible" : "Blocked"}
                      </strong>{" "}
                      · {closure.attestations.length}/2 attestations
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      Snapshot {closure.predicate_snapshot_hash}
                    </p>
                    {closure.blockers.length > 0 && (
                      <ul className="mt-2 list-disc pl-5 text-destructive">
                        {closure.blockers.map((blocker, index) => (
                          <li key={`${blocker.code}-${index}`}>
                            {blocker.code}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </Panel>
            </>
          )}
        </>
      )}
    </main>
  );
}

function IncidentTransition({
  incident,
  authority,
  busy,
  run,
}: {
  incident: Incident;
  authority: ClinicalContinuityFacilityAuthority;
  busy: boolean;
  run: (label: string, command: () => Promise<unknown>) => Promise<void>;
}) {
  const next =
    incident.lifecycle_state === "declared"
      ? "restored"
      : incident.lifecycle_state === "restored"
        ? "reconciling"
        : null;
  if (!next) return null;
  return (
    <ActionButton
      disabled={busy}
      onClick={() =>
        run(`Incident moved to ${next}.`, () =>
          transitionClinicalContinuityIncident(authority, incident.id, {
            expected_version: incident.version,
            next_state: next,
          }),
        )
      }
    >
      Move to {next}
    </ActionButton>
  );
}

function RangeRow({
  range,
  authority,
  busy,
  run,
}: {
  range: PaperRange;
  authority: ClinicalContinuityFacilityAuthority;
  busy: boolean;
  run: (label: string, command: () => Promise<unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [last, setLast] = useState(
    String(range.last_accounted_number ?? range.range_last),
  );
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code>
          {range.range_prefix}
          {String(range.range_first)}–{String(range.range_last)}
        </code>
        <Badge value={range.status} />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <input
          aria-label={`Range reason ${range.id}`}
          placeholder="Reason code"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5"
        />
        <input
          aria-label={`Last accounted number ${range.id}`}
          inputMode="numeric"
          value={last}
          onChange={(event) => setLast(event.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {(["accounted", "lost", "revoked", "exhausted"] as const).map(
          (disposition) => (
            <ActionButton
              key={disposition}
              disabled={
                busy || !reason.trim() || !Number.isSafeInteger(Number(last))
              }
              onClick={() =>
                run(`Range marked ${disposition}.`, () =>
                  recordClinicalContinuityRangeDisposition(
                    authority,
                    range.incident_id,
                    {
                      expected_version: range.version,
                      disposition,
                      reason_code: reason.trim(),
                      last_accounted_number: Number(last),
                    },
                  ),
                )
              }
            >
              {disposition}
            </ActionButton>
          ),
        )}
      </div>
    </div>
  );
}

function QueueRow({
  item,
  authority,
  busy,
  run,
}: {
  item: QueueItem;
  authority: ClinicalContinuityFacilityAuthority;
  busy: boolean;
  run: (label: string, command: () => Promise<unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{item.queue_type.replaceAll("_", " ")}</strong>
        <Badge value={item.disposition} />
      </div>
      <p className="mt-1 text-muted-foreground">
        {item.reason_code} · owner {item.owner_principal} · task{" "}
        {item.task_status ?? "not created"}
        {item.safety_critical ? " · safety critical" : ""}
      </p>
      <input
        aria-label={`Decision reason ${item.id}`}
        placeholder="Decision reason code"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1.5"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {(
          [
            "accept",
            "exclude",
            "assign",
            "handoff",
            "reopen",
            "supersede",
          ] as const
        ).map((decision) => (
          <ActionButton
            key={decision}
            disabled={busy || !reason.trim()}
            onClick={() =>
              run(`Queue decision ${decision} recorded.`, () =>
                decideClinicalContinuityReconciliationItem(authority, item.id, {
                  expected_version: item.version,
                  decision,
                  reason_code: reason.trim(),
                }),
              )
            }
          >
            {decision}
          </ActionButton>
        ))}
      </div>
    </div>
  );
}

function IdentityRow({
  identity,
  paperRowId,
  packetId,
  authority,
  busy,
  run,
}: {
  identity: TemporaryIdentity;
  paperRowId: string | null;
  packetId: string | null;
  authority: ClinicalContinuityFacilityAuthority;
  busy: boolean;
  run: (label: string, command: () => Promise<unknown>) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const ready = Boolean(
    packetId && paperRowId && UUID_PATTERN.test(target.trim()),
  );
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code>{identity.display_identifier}</code>
        <Badge value={identity.identity_status} />
      </div>
      {identity.merge_request_id ? (
        <div className="mt-2 flex gap-2">
          <ActionButton
            disabled={busy}
            onClick={() =>
              run("Identity match approved by a distinct reviewer.", () =>
                approveClinicalContinuityIdentityMatch(
                  authority,
                  identity.merge_request_id!,
                ),
              )
            }
          >
            Approve #{identity.merge_request_id}
          </ActionButton>
          <ActionButton
            disabled={busy}
            onClick={() =>
              run("Approved identity match executed.", () =>
                executeClinicalContinuityIdentityMatch(
                  authority,
                  identity.merge_request_id!,
                ),
              )
            }
          >
            Execute
          </ActionButton>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            aria-label={`Target patient for ${identity.display_identifier}`}
            placeholder="Canonical patient UUID"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="min-w-72 flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono"
          />
          <ActionButton
            disabled={busy || !ready}
            onClick={() =>
              run("Identity match proposed for independent approval.", () =>
                proposeClinicalContinuityIdentityMatch(
                  authority,
                  identity.incident_id,
                  {
                    packet_id: packetId!,
                    paper_item_row_id: paperRowId!,
                    temporary_identity_id: identity.id,
                    target_patient_uid: target.trim().toLowerCase(),
                  },
                ),
              )
            }
          >
            Propose match
          </ActionButton>
        </div>
      )}
    </div>
  );
}

function DeviceRow({
  device,
  authority,
  busy,
  run,
}: {
  device: DeviceOffset;
  authority: ClinicalContinuityFacilityAuthority;
  busy: boolean;
  run: (label: string, command: () => Promise<unknown>) => Promise<void>;
}) {
  const [observed, setObserved] = useState(
    String(device.observed_high_water_mark ?? ""),
  );
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code>{device.device_id}</code>
        <Badge value={device.disposition} />
      </div>
      <p className="mt-1 text-muted-foreground">
        Required {String(device.required_high_water_mark)} · observed{" "}
        {String(device.observed_high_water_mark ?? "not supplied")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          aria-label={`Observed high-water mark ${device.device_id}`}
          inputMode="numeric"
          placeholder="Observed high-water mark"
          value={observed}
          onChange={(event) => setObserved(event.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5"
        />
        <ActionButton
          disabled={
            busy ||
            !isSafeProtocolInteger(device.required_high_water_mark) ||
            !Number.isSafeInteger(Number(observed))
          }
          onClick={() =>
            run("Device high-water evidence updated.", () =>
              recordClinicalContinuityDeviceOffset(
                authority,
                device.incident_id,
                device.device_id,
                {
                  expected_version: device.version,
                  required_high_water_mark: toSafeProtocolInteger(
                    device.required_high_water_mark,
                  ),
                  observed_high_water_mark: Number(observed),
                  disposition: "reconciled",
                },
              ),
            )
          }
        >
          Mark reconciled
        </ActionButton>
        <ActionButton
          disabled={
            busy || !isSafeProtocolInteger(device.required_high_water_mark)
          }
          onClick={() =>
            run("Device gap assigned.", () =>
              recordClinicalContinuityDeviceOffset(
                authority,
                device.incident_id,
                device.device_id,
                {
                  expected_version: device.version,
                  required_high_water_mark: toSafeProtocolInteger(
                    device.required_high_water_mark,
                  ),
                  observed_high_water_mark:
                    observed === "" ? null : Number(observed),
                  disposition: "lost_assigned",
                },
              ),
            )
          }
        >
          Assign gap
        </ActionButton>
      </div>
    </div>
  );
}

function InterfaceRow({
  requirement,
  authority,
  busy,
  run,
}: {
  requirement: InterfaceRequirement;
  authority: ClinicalContinuityFacilityAuthority;
  busy: boolean;
  run: (label: string, command: () => Promise<unknown>) => Promise<void>;
}) {
  const highWaterMarkIsSafe =
    requirement.required_high_water_position == null ||
    isSafeProtocolInteger(requirement.required_high_water_position);
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>
          {requirement.interface_family} · {requirement.direction}
        </strong>
        <Badge value={requirement.disposition} />
      </div>
      <p className="mt-1 text-muted-foreground">
        {requirement.source_partition} · owner {requirement.owner_principal}
      </p>
      <div className="mt-2 flex gap-2">
        <ActionButton
          disabled={busy || !requirement.offset_id || !highWaterMarkIsSafe}
          onClick={() =>
            run(
              "Interface requirement reconciled against the observed offset.",
              () =>
                recordClinicalContinuityInterfaceRequirement(
                  authority,
                  requirement.incident_id,
                  {
                    expected_version: requirement.version,
                    offset_id: requirement.offset_id,
                    interface_family: requirement.interface_family,
                    direction: requirement.direction,
                    source_partition: requirement.source_partition,
                    required_generation: requirement.required_generation,
                    required_high_water_position:
                      requirement.required_high_water_position == null
                        ? null
                        : toSafeProtocolInteger(
                            requirement.required_high_water_position,
                          ),
                    required_high_water_token:
                      requirement.required_high_water_token,
                    disposition: "reconciled",
                  },
                ),
            )
          }
        >
          Mark reconciled
        </ActionButton>
        <ActionButton
          disabled={busy || !highWaterMarkIsSafe}
          onClick={() =>
            run("Interface gap assigned.", () =>
              recordClinicalContinuityInterfaceRequirement(
                authority,
                requirement.incident_id,
                {
                  expected_version: requirement.version,
                  offset_id: requirement.offset_id,
                  interface_family: requirement.interface_family,
                  direction: requirement.direction,
                  source_partition: requirement.source_partition,
                  required_generation: requirement.required_generation,
                  required_high_water_position:
                    requirement.required_high_water_position == null
                      ? null
                      : toSafeProtocolInteger(
                          requirement.required_high_water_position,
                        ),
                  required_high_water_token:
                    requirement.required_high_water_token,
                  disposition: "assigned_gap",
                },
              ),
            )
          }
        >
          Assign gap
        </ActionButton>
      </div>
    </div>
  );
}
