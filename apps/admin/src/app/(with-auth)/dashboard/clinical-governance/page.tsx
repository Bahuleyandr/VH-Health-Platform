"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Beaker,
  CheckCircle2,
  FlaskConical,
  Microscope,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { toast } from "react-hot-toast";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  addCareTeamMember,
  createCareTeam,
  createLabSpecimen,
  listCareTeamMembers,
  listCareTeams,
  listLabAnalyzers,
  listLabQcRuns,
  listLabSpecimens,
  listPatientAccessAudit,
  recordLabQcRun,
  saveLabAnalyzer,
  startPatientBreakGlass,
  transitionCareTeam,
  transitionCareTeamMember,
  transitionLabSpecimen,
  type AnalyzerStatus,
  type CareTeam,
  type CareTeamKind,
  type CareTeamMember,
  type CareTeamMemberStatus,
  type CareTeamStatus,
  type LabAnalyzer,
  type LabQcRun,
  type LabSpecimen,
  type PatientAccessAuditEvent,
  type QcResultStatus,
  type SpecimenStatus,
} from "@/lib/api/clinicalGovernance";

type Tab = "access" | "lab" | "audit";

const CARE_TEAM_KINDS: CareTeamKind[] = [
  "op",
  "ip",
  "er",
  "icu",
  "day_care",
  "dialysis",
  "perioperative",
  "longitudinal",
  "other",
];
const CARE_TEAM_STATUSES: CareTeamStatus[] = ["active", "paused", "closed", "archived"];
const MEMBER_STATUSES: CareTeamMemberStatus[] = ["active", "inactive", "suspended", "ended"];
const SPECIMEN_STATUSES: SpecimenStatus[] = [
  "ordered",
  "collected",
  "in_transit",
  "received",
  "processing",
  "rejected",
  "disposed",
  "cancelled",
];
const ANALYZER_STATUSES: AnalyzerStatus[] = ["active", "maintenance", "offline", "retired"];
const QC_STATUSES: QcResultStatus[] = ["pending", "passed", "failed", "warning"];
const RELATIONSHIP_KINDS = [
  "primary_consultant",
  "attending_doctor",
  "covering_doctor",
  "resident",
  "nurse",
  "pharmacist",
  "physiotherapist",
  "billing_counsellor",
  "care_coordinator",
  "diagnostics",
  "housekeeping",
  "care_team",
  "other",
];

function fmt(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortUid(value?: string | null) {
  if (!value) return "-";
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function statusPillClass(status: string) {
  switch (status) {
    case "active":
    case "passed":
    case "allow":
    case "received":
      return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "warning":
    case "paused":
    case "processing":
    case "collected":
    case "in_transit":
    case "pending":
    case "maintenance":
      return "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200";
    case "failed":
    case "denied":
    case "rejected":
    case "revoked":
      return "border-rose-300 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200";
    case "closed":
    case "ended":
    case "archived":
    case "disposed":
    case "cancelled":
    case "retired":
      return "border-slate-300 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      {message}
    </div>
  );
}

function Pill({ value }: { value: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusPillClass(value)}`}>
      {value}
    </span>
  );
}

function SectionCard({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function ClinicalGovernancePage() {
  const [tab, setTab] = useState<Tab>("access");

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <header className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Clinical Governance</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Admin control point for patient-access relationships, break-glass review, lab specimen traceability, analyzer QC, and PHI audit events.
          </p>
        </div>
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Route: /api/v1/admin/clinical-governance
        </p>
      </header>

      <div className="flex flex-wrap gap-1 rounded-md border border-border bg-muted/30 p-1">
        {([
          { key: "access", label: "Patient access", icon: Users },
          { key: "lab", label: "Lab governance", icon: FlaskConical },
          { key: "audit", label: "Access audit", icon: Activity },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === key
                ? "border border-primary/30 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === "access" ? <PatientAccessTab /> : null}
      {tab === "lab" ? <LabGovernanceTab /> : null}
      {tab === "audit" ? <AccessAuditTab /> : null}
    </div>
  );
}

function PatientAccessTab() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState({ patient_uid: "", status: "active" as CareTeamStatus | "" });
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [teamDraft, setTeamDraft] = useState({
    patient_uid: "",
    display_name: "",
    primary_department: "",
    team_kind: "longitudinal" as CareTeamKind,
  });
  const [memberDraft, setMemberDraft] = useState({
    staff_uid: "",
    staff_id: "",
    member_name: "",
    staff_role: "",
    relationship_kind: "care_team",
    break_glass_allowed: false,
  });
  const [breakGlassDraft, setBreakGlassDraft] = useState({
    patient_uid: "",
    actor_uid: "",
    actor_role: "",
    reason: "",
    expires_at: "",
  });

  const teamsQuery = useQuery({
    queryKey: ["clinical-governance", "care-teams", filter],
    queryFn: () =>
      listCareTeams({
        patient_uid: filter.patient_uid.trim() || undefined,
        status: filter.status || undefined,
        limit: 100,
      }),
  });
  const teams = useMemo(() => teamsQuery.data?.care_teams ?? [], [teamsQuery.data?.care_teams]);

  useEffect(() => {
    if (teams.length === 0) {
      setSelectedTeamId(null);
      return;
    }
    if (selectedTeamId == null || !teams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(teams[0].id);
    }
  }, [selectedTeamId, teams]);

  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? null;

  const membersQuery = useQuery({
    queryKey: ["clinical-governance", "care-team-members", selectedTeamId],
    queryFn: () => listCareTeamMembers(selectedTeamId as number, { limit: 100 }),
    enabled: selectedTeamId != null,
  });

  const createTeamMutation = useMutation({
    mutationFn: () =>
      createCareTeam({
        patient_uid: teamDraft.patient_uid.trim(),
        display_name: teamDraft.display_name.trim() || null,
        primary_department: teamDraft.primary_department.trim() || null,
        team_kind: teamDraft.team_kind,
      }),
    onSuccess: (team) => {
      toast.success("Care team created");
      setSelectedTeamId(team.id);
      setTeamDraft({ patient_uid: "", display_name: "", primary_department: "", team_kind: "longitudinal" });
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "care-teams"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not create care team"),
  });

  const transitionTeamMutation = useMutation({
    mutationFn: ({ id, next_status }: { id: number; next_status: CareTeamStatus }) =>
      transitionCareTeam(id, { next_status, reason: `Admin governance transition to ${next_status}` }),
    onSuccess: () => {
      toast.success("Care team updated");
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "care-teams"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not update care team"),
  });

  const addMemberMutation = useMutation({
    mutationFn: () => {
      if (!selectedTeamId) throw new Error("Select a care team first");
      const staffId = memberDraft.staff_id.trim() ? Number(memberDraft.staff_id) : null;
      return addCareTeamMember(selectedTeamId, {
        staff_uid: memberDraft.staff_uid.trim() || null,
        staff_id: staffId,
        member_name: memberDraft.member_name.trim() || null,
        staff_role: memberDraft.staff_role.trim() || null,
        relationship_kind: memberDraft.relationship_kind,
        break_glass_allowed: memberDraft.break_glass_allowed,
      });
    },
    onSuccess: () => {
      toast.success("Care-team member added");
      setMemberDraft({
        staff_uid: "",
        staff_id: "",
        member_name: "",
        staff_role: "",
        relationship_kind: "care_team",
        break_glass_allowed: false,
      });
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "care-team-members", selectedTeamId] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not add member"),
  });

  const transitionMemberMutation = useMutation({
    mutationFn: ({ member, next_status }: { member: CareTeamMember; next_status: CareTeamMemberStatus }) => {
      if (!selectedTeamId) throw new Error("Select a care team first");
      return transitionCareTeamMember(selectedTeamId, member.id, {
        next_status,
        reason: `Admin governance transition to ${next_status}`,
      });
    },
    onSuccess: () => {
      toast.success("Care-team member updated");
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "care-team-members", selectedTeamId] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not update member"),
  });

  const startBreakGlassMutation = useMutation({
    mutationFn: () =>
      startPatientBreakGlass({
        patient_uid: breakGlassDraft.patient_uid.trim(),
        actor_uid: breakGlassDraft.actor_uid.trim(),
        actor_role: breakGlassDraft.actor_role.trim() || null,
        reason: breakGlassDraft.reason.trim(),
        expires_at: breakGlassDraft.expires_at.trim() || null,
      }),
    onSuccess: () => {
      toast.success("Break-glass session started");
      setBreakGlassDraft({ patient_uid: "", actor_uid: "", actor_role: "", reason: "", expires_at: "" });
    },
    onError: (error: Error) => toast.error(error.message || "Could not start break-glass"),
  });

  const busy =
    createTeamMutation.isPending ||
    transitionTeamMutation.isPending ||
    addMemberMutation.isPending ||
    transitionMemberMutation.isPending ||
    startBreakGlassMutation.isPending;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(420px,0.85fr)]">
      <div className="space-y-4">
        <SectionCard
          title="Care teams"
          icon={Users}
          action={
            <button
              type="button"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["clinical-governance", "care-teams"] })}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          }
        >
          <div className="mb-3 grid gap-2 lg:grid-cols-[minmax(240px,1fr)_180px]">
            <input
              value={filter.patient_uid}
              onChange={(event) => setFilter((current) => ({ ...current, patient_uid: event.target.value }))}
              placeholder="Filter by patient UID"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            />
            <select
              value={filter.status}
              onChange={(event) => setFilter((current) => ({ ...current, status: event.target.value as CareTeamStatus | "" }))}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              {CARE_TEAM_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <ErrorBanner error={teamsQuery.error} />

          {teamsQuery.isLoading ? (
            <LoadingSpinner label="Loading care teams" />
          ) : teams.length === 0 ? (
            <EmptyState
              icon={<UserRound className="h-8 w-8 text-muted-foreground" />}
              title="No care teams"
              description="Create a care team to grant patient access by relationship instead of role alone."
              compact
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">patient</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">team</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">kind</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">status</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">updated</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">transition</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {teams.map((team) => (
                    <tr
                      key={team.id}
                      className={`cursor-pointer hover:bg-muted/30 ${team.id === selectedTeamId ? "bg-primary/10" : ""}`}
                      onClick={() => setSelectedTeamId(team.id)}
                    >
                      <td className="px-3 py-2 font-mono">{shortUid(team.patient_uid)}</td>
                      <td className="px-3 py-2">
                        <p className="font-medium">{team.display_name || `Care team #${team.id}`}</p>
                        <p className="text-muted-foreground">{team.primary_department || "No department"}</p>
                      </td>
                      <td className="px-3 py-2">{team.team_kind}</td>
                      <td className="px-3 py-2"><Pill value={team.status} /></td>
                      <td className="px-3 py-2 text-muted-foreground">{fmt(team.updated_at)}</td>
                      <td className="px-3 py-2 text-right">
                        <select
                          value={team.status}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => transitionTeamMutation.mutate({
                            id: team.id,
                            next_status: event.target.value as CareTeamStatus,
                          })}
                          disabled={busy}
                          className="rounded border border-border bg-background px-2 py-1 text-xs"
                        >
                          {CARE_TEAM_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Create care team" icon={Plus}>
          <div className="grid gap-2 lg:grid-cols-12">
            <input
              value={teamDraft.patient_uid}
              onChange={(event) => setTeamDraft({ ...teamDraft, patient_uid: event.target.value })}
              placeholder="patient_uid"
              className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            />
            <input
              value={teamDraft.display_name}
              onChange={(event) => setTeamDraft({ ...teamDraft, display_name: event.target.value })}
              placeholder="Display name"
              className="lg:col-span-3 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <input
              value={teamDraft.primary_department}
              onChange={(event) => setTeamDraft({ ...teamDraft, primary_department: event.target.value })}
              placeholder="Department"
              className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <select
              value={teamDraft.team_kind}
              onChange={(event) => setTeamDraft({ ...teamDraft, team_kind: event.target.value as CareTeamKind })}
              className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {CARE_TEAM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => createTeamMutation.mutate()}
              disabled={busy || !teamDraft.patient_uid.trim()}
              className="lg:col-span-1 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
        </SectionCard>
      </div>

      <div className="space-y-4">
        <CareTeamMembersPanel
          selectedTeam={selectedTeam}
          members={membersQuery.data?.members ?? []}
          loading={membersQuery.isLoading}
          error={membersQuery.error}
          draft={memberDraft}
          setDraft={setMemberDraft}
          busy={busy}
          onAdd={() => addMemberMutation.mutate()}
          onTransition={(member, next_status) => transitionMemberMutation.mutate({ member, next_status })}
        />
        <SectionCard title="Break-glass access" icon={AlertTriangle}>
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={breakGlassDraft.patient_uid}
                onChange={(event) => setBreakGlassDraft({ ...breakGlassDraft, patient_uid: event.target.value })}
                placeholder="patient_uid"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
              />
              <input
                value={breakGlassDraft.actor_uid}
                onChange={(event) => setBreakGlassDraft({ ...breakGlassDraft, actor_uid: event.target.value })}
                placeholder="actor_uid"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
              />
              <input
                value={breakGlassDraft.actor_role}
                onChange={(event) => setBreakGlassDraft({ ...breakGlassDraft, actor_role: event.target.value })}
                placeholder="Actor role"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={breakGlassDraft.expires_at}
                onChange={(event) => setBreakGlassDraft({ ...breakGlassDraft, expires_at: event.target.value })}
                placeholder="Expires at ISO timestamp (optional)"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <textarea
              value={breakGlassDraft.reason}
              onChange={(event) => setBreakGlassDraft({ ...breakGlassDraft, reason: event.target.value })}
              rows={3}
              placeholder="Break-glass reason. Minimum 8 characters."
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => startBreakGlassMutation.mutate()}
              disabled={
                busy ||
                !breakGlassDraft.patient_uid.trim() ||
                !breakGlassDraft.actor_uid.trim() ||
                breakGlassDraft.reason.trim().length < 8
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:bg-amber-950/40 dark:text-amber-100"
            >
              <AlertTriangle className="h-4 w-4" />
              Start break-glass
            </button>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function CareTeamMembersPanel({
  selectedTeam,
  members,
  loading,
  error,
  draft,
  setDraft,
  busy,
  onAdd,
  onTransition,
}: {
  selectedTeam: CareTeam | null;
  members: CareTeamMember[];
  loading: boolean;
  error: unknown;
  draft: {
    staff_uid: string;
    staff_id: string;
    member_name: string;
    staff_role: string;
    relationship_kind: string;
    break_glass_allowed: boolean;
  };
  setDraft: (draft: {
    staff_uid: string;
    staff_id: string;
    member_name: string;
    staff_role: string;
    relationship_kind: string;
    break_glass_allowed: boolean;
  }) => void;
  busy: boolean;
  onAdd: () => void;
  onTransition: (member: CareTeamMember, nextStatus: CareTeamMemberStatus) => void;
}) {
  return (
    <SectionCard title="Team members" icon={UserRound}>
      {!selectedTeam ? (
        <EmptyState title="Select a care team" description="Members and patient-access scope appear here." compact />
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-muted/30 p-2 text-xs">
            <p className="font-medium">{selectedTeam.display_name || `Care team #${selectedTeam.id}`}</p>
            <p className="font-mono text-muted-foreground">Patient {shortUid(selectedTeam.patient_uid)}</p>
          </div>
          <ErrorBanner error={error} />
          <div className="grid gap-2">
            <input
              value={draft.member_name}
              onChange={(event) => setDraft({ ...draft, member_name: event.target.value })}
              placeholder="Member name"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={draft.staff_uid}
                onChange={(event) => setDraft({ ...draft, staff_uid: event.target.value })}
                placeholder="staff_uid"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
              />
              <input
                value={draft.staff_id}
                onChange={(event) => setDraft({ ...draft, staff_id: event.target.value })}
                placeholder="staff_id"
                inputMode="numeric"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={draft.staff_role}
                onChange={(event) => setDraft({ ...draft, staff_role: event.target.value })}
                placeholder="Role code"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <select
                value={draft.relationship_kind}
                onChange={(event) => setDraft({ ...draft, relationship_kind: event.target.value })}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                {RELATIONSHIP_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.break_glass_allowed}
                onChange={(event) => setDraft({ ...draft, break_glass_allowed: event.target.checked })}
              />
              Member can be used as a break-glass reviewer
            </label>
            <button
              type="button"
              onClick={onAdd}
              disabled={busy || (!draft.staff_uid.trim() && !draft.staff_id.trim())}
              className="inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add member
            </button>
          </div>
          {loading ? (
            <LoadingSpinner label="Loading members" />
          ) : members.length === 0 ? (
            <EmptyState title="No members yet" description="Add doctors, nurses, or other staff to this patient's care team." compact />
          ) : (
            <div className="space-y-2">
              {members.map((member) => (
                <div key={member.id} className="rounded-md border border-border p-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{member.member_name || member.staff_role || `Member #${member.id}`}</p>
                      <p className="font-mono text-muted-foreground">
                        {member.staff_uid ? shortUid(member.staff_uid) : `staff_id ${member.staff_id ?? "-"}`}
                      </p>
                      <p className="text-muted-foreground">
                        {member.relationship_kind}
                        {member.break_glass_allowed ? " - break-glass reviewer" : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <Pill value={member.status} />
                      <select
                        value={member.status}
                        onChange={(event) => onTransition(member, event.target.value as CareTeamMemberStatus)}
                        disabled={busy}
                        className="mt-2 block rounded border border-border bg-background px-2 py-1 text-xs"
                      >
                        {MEMBER_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function LabGovernanceTab() {
  const queryClient = useQueryClient();
  const [specimenFilter, setSpecimenFilter] = useState({ patient_uid: "", status: "" as SpecimenStatus | "" });
  const [specimenDraft, setSpecimenDraft] = useState({
    patient_uid: "",
    accession_number: "",
    specimen_type: "blood",
    priority: "routine",
    container_type: "",
    collection_site: "",
  });
  const [analyzerStatus, setAnalyzerStatus] = useState<AnalyzerStatus | "">("active");
  const [selectedAnalyzerId, setSelectedAnalyzerId] = useState<number | null>(null);
  const [analyzerDraft, setAnalyzerDraft] = useState({
    analyzer_code: "",
    display_name: "",
    manufacturer: "",
    model: "",
    serial_number: "",
    interface_kind: "manual",
    status: "active" as AnalyzerStatus,
  });
  const [qcDraft, setQcDraft] = useState({
    qc_level: "normal",
    qc_lot_number: "",
    result_status: "passed" as QcResultStatus,
    measured_values: "{}",
    notes: "",
  });

  const specimensQuery = useQuery({
    queryKey: ["clinical-governance", "lab-specimens", specimenFilter],
    queryFn: () =>
      listLabSpecimens({
        patient_uid: specimenFilter.patient_uid.trim() || undefined,
        status: specimenFilter.status || undefined,
        limit: 100,
      }),
  });

  const analyzersQuery = useQuery({
    queryKey: ["clinical-governance", "lab-analyzers", analyzerStatus],
    queryFn: () => listLabAnalyzers({ status: analyzerStatus || undefined, limit: 100 }),
  });
  const analyzers = useMemo(() => analyzersQuery.data?.analyzers ?? [], [analyzersQuery.data?.analyzers]);

  useEffect(() => {
    if (analyzers.length === 0) {
      setSelectedAnalyzerId(null);
      return;
    }
    if (selectedAnalyzerId == null || !analyzers.some((analyzer) => analyzer.id === selectedAnalyzerId)) {
      setSelectedAnalyzerId(analyzers[0].id);
    }
  }, [analyzers, selectedAnalyzerId]);

  const selectedAnalyzer = analyzers.find((analyzer) => analyzer.id === selectedAnalyzerId) ?? null;
  const qcQuery = useQuery({
    queryKey: ["clinical-governance", "lab-qc-runs", selectedAnalyzerId],
    queryFn: () => listLabQcRuns(selectedAnalyzerId as number, { limit: 50 }),
    enabled: selectedAnalyzerId != null,
  });

  const createSpecimenMutation = useMutation({
    mutationFn: () =>
      createLabSpecimen({
        patient_uid: specimenDraft.patient_uid.trim(),
        accession_number: specimenDraft.accession_number.trim(),
        specimen_type: specimenDraft.specimen_type.trim() || "blood",
        priority: specimenDraft.priority.trim() || "routine",
        container_type: specimenDraft.container_type.trim() || null,
        collection_site: specimenDraft.collection_site.trim() || null,
      }),
    onSuccess: () => {
      toast.success("Specimen created");
      setSpecimenDraft({
        patient_uid: "",
        accession_number: "",
        specimen_type: "blood",
        priority: "routine",
        container_type: "",
        collection_site: "",
      });
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-specimens"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not create specimen"),
  });

  const transitionSpecimenMutation = useMutation({
    mutationFn: ({ specimen, next_status }: { specimen: LabSpecimen; next_status: SpecimenStatus }) =>
      transitionLabSpecimen(specimen.id, {
        next_status,
        reason: `Admin governance transition to ${next_status}`,
      }),
    onSuccess: () => {
      toast.success("Specimen updated");
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-specimens"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not update specimen"),
  });

  const saveAnalyzerMutation = useMutation({
    mutationFn: () =>
      saveLabAnalyzer({
        analyzer_code: analyzerDraft.analyzer_code.trim(),
        display_name: analyzerDraft.display_name.trim(),
        manufacturer: analyzerDraft.manufacturer.trim() || null,
        model: analyzerDraft.model.trim() || null,
        serial_number: analyzerDraft.serial_number.trim() || null,
        interface_kind: analyzerDraft.interface_kind.trim() || "manual",
        status: analyzerDraft.status,
      }),
    onSuccess: (analyzer) => {
      toast.success("Analyzer saved");
      setSelectedAnalyzerId(analyzer.id);
      setAnalyzerDraft({
        analyzer_code: "",
        display_name: "",
        manufacturer: "",
        model: "",
        serial_number: "",
        interface_kind: "manual",
        status: "active",
      });
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-analyzers"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not save analyzer"),
  });

  const recordQcMutation = useMutation({
    mutationFn: () => {
      if (!selectedAnalyzerId) throw new Error("Select an analyzer first");
      let measuredValues: Record<string, unknown> = {};
      const raw = qcDraft.measured_values.trim();
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Measured values must be a JSON object");
        }
        measuredValues = parsed as Record<string, unknown>;
      }
      return recordLabQcRun(selectedAnalyzerId, {
        qc_level: qcDraft.qc_level,
        qc_lot_number: qcDraft.qc_lot_number.trim() || null,
        result_status: qcDraft.result_status,
        measured_values: measuredValues,
        notes: qcDraft.notes.trim() || null,
      });
    },
    onSuccess: () => {
      toast.success("QC run recorded");
      setQcDraft({ qc_level: "normal", qc_lot_number: "", result_status: "passed", measured_values: "{}", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-qc-runs", selectedAnalyzerId] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not record QC run"),
  });

  const busy =
    createSpecimenMutation.isPending ||
    transitionSpecimenMutation.isPending ||
    saveAnalyzerMutation.isPending ||
    recordQcMutation.isPending;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <SectionCard
        title="Specimen registry"
        icon={Beaker}
        action={
          <button
            type="button"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-specimens"] })}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_180px]">
            <input
              value={specimenFilter.patient_uid}
              onChange={(event) => setSpecimenFilter((current) => ({ ...current, patient_uid: event.target.value }))}
              placeholder="Filter by patient UID"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            />
            <select
              value={specimenFilter.status}
              onChange={(event) => setSpecimenFilter((current) => ({ ...current, status: event.target.value as SpecimenStatus | "" }))}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              {SPECIMEN_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <ErrorBanner error={specimensQuery.error} />
          <CreateSpecimenForm
            draft={specimenDraft}
            setDraft={setSpecimenDraft}
            busy={busy}
            onSubmit={() => createSpecimenMutation.mutate()}
          />
          <SpecimenTable
            specimens={specimensQuery.data?.specimens ?? []}
            loading={specimensQuery.isLoading}
            busy={busy}
            onTransition={(specimen, next_status) => transitionSpecimenMutation.mutate({ specimen, next_status })}
          />
        </div>
      </SectionCard>

      <SectionCard title="Analyzers and QC" icon={Microscope}>
        <div className="space-y-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_170px]">
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Analyzer master, interface type, and QC runs are kept tenant-scoped and auditable.
            </p>
            <select
              value={analyzerStatus}
              onChange={(event) => setAnalyzerStatus(event.target.value as AnalyzerStatus | "")}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">All analyzers</option>
              {ANALYZER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <ErrorBanner error={analyzersQuery.error ?? qcQuery.error} />
          <AnalyzerForm
            draft={analyzerDraft}
            setDraft={setAnalyzerDraft}
            busy={busy}
            onSubmit={() => saveAnalyzerMutation.mutate()}
          />
          <AnalyzerList
            analyzers={analyzers}
            selectedId={selectedAnalyzerId}
            loading={analyzersQuery.isLoading}
            onSelect={setSelectedAnalyzerId}
          />
          <QcPanel
            analyzer={selectedAnalyzer}
            qcRuns={qcQuery.data?.qc_runs ?? []}
            loading={qcQuery.isLoading}
            draft={qcDraft}
            setDraft={setQcDraft}
            busy={busy}
            onSubmit={() => recordQcMutation.mutate()}
          />
        </div>
      </SectionCard>
    </div>
  );
}

function CreateSpecimenForm({
  draft,
  setDraft,
  busy,
  onSubmit,
}: {
  draft: {
    patient_uid: string;
    accession_number: string;
    specimen_type: string;
    priority: string;
    container_type: string;
    collection_site: string;
  };
  setDraft: (draft: {
    patient_uid: string;
    accession_number: string;
    specimen_type: string;
    priority: string;
    container_type: string;
    collection_site: string;
  }) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs font-semibold text-muted-foreground">Create specimen</p>
      <div className="grid gap-2 lg:grid-cols-12">
        <input
          value={draft.patient_uid}
          onChange={(event) => setDraft({ ...draft, patient_uid: event.target.value })}
          placeholder="patient_uid"
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
        />
        <input
          value={draft.accession_number}
          onChange={(event) => setDraft({ ...draft, accession_number: event.target.value })}
          placeholder="Accession number"
          className="lg:col-span-3 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.specimen_type}
          onChange={(event) => setDraft({ ...draft, specimen_type: event.target.value })}
          placeholder="Type"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.priority}
          onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
          placeholder="Priority"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !draft.patient_uid.trim() || !draft.accession_number.trim()}
          className="lg:col-span-1 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-2 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
        <input
          value={draft.container_type}
          onChange={(event) => setDraft({ ...draft, container_type: event.target.value })}
          placeholder="Container (optional)"
          className="lg:col-span-6 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.collection_site}
          onChange={(event) => setDraft({ ...draft, collection_site: event.target.value })}
          placeholder="Collection site (optional)"
          className="lg:col-span-6 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
      </div>
    </div>
  );
}

function SpecimenTable({
  specimens,
  loading,
  busy,
  onTransition,
}: {
  specimens: LabSpecimen[];
  loading: boolean;
  busy: boolean;
  onTransition: (specimen: LabSpecimen, nextStatus: SpecimenStatus) => void;
}) {
  if (loading) return <LoadingSpinner label="Loading specimens" />;
  if (specimens.length === 0) {
    return <EmptyState title="No specimens" description="Specimens matching the current filters will appear here." compact />;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">accession</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">patient</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">type</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">status</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">created</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">transition</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {specimens.map((specimen) => (
            <tr key={specimen.id}>
              <td className="px-3 py-2 font-mono">{specimen.accession_number}</td>
              <td className="px-3 py-2 font-mono">{shortUid(specimen.patient_uid)}</td>
              <td className="px-3 py-2">
                {specimen.specimen_type}
                <span className="ml-1 text-muted-foreground">{specimen.priority}</span>
              </td>
              <td className="px-3 py-2"><Pill value={specimen.status} /></td>
              <td className="px-3 py-2 text-muted-foreground">{fmt(specimen.created_at)}</td>
              <td className="px-3 py-2 text-right">
                <select
                  value={specimen.status}
                  onChange={(event) => onTransition(specimen, event.target.value as SpecimenStatus)}
                  disabled={busy}
                  className="rounded border border-border bg-background px-2 py-1 text-xs"
                >
                  {SPECIMEN_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalyzerForm({
  draft,
  setDraft,
  busy,
  onSubmit,
}: {
  draft: {
    analyzer_code: string;
    display_name: string;
    manufacturer: string;
    model: string;
    serial_number: string;
    interface_kind: string;
    status: AnalyzerStatus;
  };
  setDraft: (draft: {
    analyzer_code: string;
    display_name: string;
    manufacturer: string;
    model: string;
    serial_number: string;
    interface_kind: string;
    status: AnalyzerStatus;
  }) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs font-semibold text-muted-foreground">Add analyzer</p>
      <div className="grid gap-2 lg:grid-cols-12">
        <input
          value={draft.analyzer_code}
          onChange={(event) => setDraft({ ...draft, analyzer_code: event.target.value })}
          placeholder="Code"
          className="lg:col-span-3 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
        />
        <input
          value={draft.display_name}
          onChange={(event) => setDraft({ ...draft, display_name: event.target.value })}
          placeholder="Display name"
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.manufacturer}
          onChange={(event) => setDraft({ ...draft, manufacturer: event.target.value })}
          placeholder="Manufacturer"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.model}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          placeholder="Model"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !draft.analyzer_code.trim() || !draft.display_name.trim()}
          className="lg:col-span-1 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-2 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Save
        </button>
        <input
          value={draft.serial_number}
          onChange={(event) => setDraft({ ...draft, serial_number: event.target.value })}
          placeholder="Serial number"
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.interface_kind}
          onChange={(event) => setDraft({ ...draft, interface_kind: event.target.value })}
          placeholder="Interface kind"
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <select
          value={draft.status}
          onChange={(event) => setDraft({ ...draft, status: event.target.value as AnalyzerStatus })}
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
        >
          {ANALYZER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function AnalyzerList({
  analyzers,
  selectedId,
  loading,
  onSelect,
}: {
  analyzers: LabAnalyzer[];
  selectedId: number | null;
  loading: boolean;
  onSelect: (id: number) => void;
}) {
  if (loading) return <LoadingSpinner label="Loading analyzers" />;
  if (analyzers.length === 0) {
    return <EmptyState title="No analyzers" description="Create an analyzer before recording QC." compact />;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {analyzers.map((analyzer) => (
        <button
          key={analyzer.id}
          type="button"
          onClick={() => onSelect(analyzer.id)}
          className={`rounded-md border p-3 text-left text-xs ${
            analyzer.id === selectedId ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted/30"
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{analyzer.display_name}</p>
              <p className="font-mono text-muted-foreground">{analyzer.analyzer_code}</p>
            </div>
            <Pill value={analyzer.status} />
          </div>
          <p className="mt-1 text-muted-foreground">
            {[analyzer.manufacturer, analyzer.model, analyzer.interface_kind].filter(Boolean).join(" - ") || "No hardware details"}
          </p>
        </button>
      ))}
    </div>
  );
}

function QcPanel({
  analyzer,
  qcRuns,
  loading,
  draft,
  setDraft,
  busy,
  onSubmit,
}: {
  analyzer: LabAnalyzer | null;
  qcRuns: LabQcRun[];
  loading: boolean;
  draft: {
    qc_level: string;
    qc_lot_number: string;
    result_status: QcResultStatus;
    measured_values: string;
    notes: string;
  };
  setDraft: (draft: {
    qc_level: string;
    qc_lot_number: string;
    result_status: QcResultStatus;
    measured_values: string;
    notes: string;
  }) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  if (!analyzer) {
    return <EmptyState title="Select an analyzer" description="QC recording appears once an analyzer is selected." compact />;
  }
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <p className="text-sm font-semibold">QC for {analyzer.display_name}</p>
        <p className="font-mono text-xs text-muted-foreground">{analyzer.analyzer_code}</p>
      </div>
      <div className="grid gap-2 lg:grid-cols-12">
        <input
          value={draft.qc_level}
          onChange={(event) => setDraft({ ...draft, qc_level: event.target.value })}
          placeholder="qc_level"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.qc_lot_number}
          onChange={(event) => setDraft({ ...draft, qc_lot_number: event.target.value })}
          placeholder="Lot"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <select
          value={draft.result_status}
          onChange={(event) => setDraft({ ...draft, result_status: event.target.value as QcResultStatus })}
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        >
          {QC_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <input
          value={draft.measured_values}
          onChange={(event) => setDraft({ ...draft, measured_values: event.target.value })}
          placeholder='{"control": 1.23}'
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="lg:col-span-2 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-2 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Record QC
        </button>
        <input
          value={draft.notes}
          onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
          placeholder="Notes"
          className="lg:col-span-12 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
      </div>
      {loading ? (
        <LoadingSpinner label="Loading QC runs" />
      ) : qcRuns.length === 0 ? (
        <EmptyState title="No QC runs" description="Record the first QC result for this analyzer." compact />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">time</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">level</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">result</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">lot</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {qcRuns.map((run) => (
                <tr key={run.id}>
                  <td className="px-3 py-2 text-muted-foreground">{fmt(run.performed_at)}</td>
                  <td className="px-3 py-2">{run.qc_level}</td>
                  <td className="px-3 py-2"><Pill value={run.result_status} /></td>
                  <td className="px-3 py-2 font-mono">{run.qc_lot_number ?? "-"}</td>
                  <td className="px-3 py-2">{run.notes ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AccessAuditTab() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState({ patient_uid: "", actor_uid: "" });
  const auditQuery = useQuery({
    queryKey: ["clinical-governance", "patient-access-audit", filter],
    queryFn: () =>
      listPatientAccessAudit({
        patient_uid: filter.patient_uid.trim() || undefined,
        actor_uid: filter.actor_uid.trim() || undefined,
        limit: 150,
      }),
  });
  const rows = auditQuery.data?.access_events ?? [];
  const allowed = rows.filter((row) => String(row.access_decision ?? "").toLowerCase() === "allow").length;
  const denied = rows.filter((row) => String(row.access_decision ?? "").toLowerCase() === "denied").length;

  return (
    <SectionCard
      title="Patient access audit"
      icon={Activity}
      action={
        <button
          type="button"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["clinical-governance", "patient-access-audit"] })}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)_160px_160px]">
          <input
            value={filter.patient_uid}
            onChange={(event) => setFilter((current) => ({ ...current, patient_uid: event.target.value }))}
            placeholder="patient_uid"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          />
          <input
            value={filter.actor_uid}
            onChange={(event) => setFilter((current) => ({ ...current, actor_uid: event.target.value }))}
            placeholder="actor_uid"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          />
          <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
            {allowed} allowed
          </div>
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
            {denied} denied
          </div>
        </div>
        <ErrorBanner error={auditQuery.error} />
        {auditQuery.isLoading ? (
          <LoadingSpinner label="Loading audit events" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Activity className="h-8 w-8 text-muted-foreground" />}
            title="No audit events"
            description="Patient-access allow, deny, and break-glass events will appear here."
            compact
          />
        ) : (
          <AuditTable rows={rows} />
        )}
      </div>
    </SectionCard>
  );
}

function AuditTable({ rows }: { rows: PatientAccessAuditEvent[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">time</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">decision</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">patient</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">actor</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">record</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">route</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2 text-muted-foreground">{fmt(row.created_at)}</td>
              <td className="px-3 py-2"><Pill value={row.access_decision ?? "unknown"} /></td>
              <td className="px-3 py-2 font-mono">{shortUid(row.patient_uid)}</td>
              <td className="px-3 py-2">
                <p className="font-mono">{shortUid(row.actor_uid)}</p>
                <p className="text-muted-foreground">{row.actor_role ?? "-"}</p>
              </td>
              <td className="px-3 py-2">{row.record_type ?? "-"}</td>
              <td className="px-3 py-2 font-mono">
                {row.action ?? "VIEW"} {row.route ?? "-"}
              </td>
              <td className="px-3 py-2">{row.access_reason ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
