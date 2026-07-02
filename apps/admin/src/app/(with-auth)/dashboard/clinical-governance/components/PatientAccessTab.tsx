"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, RefreshCw, UserRound, Users } from "lucide-react";
import { toast } from "react-hot-toast";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  addCareTeamMember,
  createCareTeam,
  listCareTeamMembers,
  listCareTeams,
  startPatientBreakGlass,
  transitionCareTeam,
  transitionCareTeamMember,
  type CareTeam,
  type CareTeamKind,
  type CareTeamMember,
  type CareTeamMemberStatus,
  type CareTeamStatus,
} from "@/lib/api/clinicalGovernance";
import {
  CARE_TEAM_KINDS,
  CARE_TEAM_STATUSES,
  ErrorBanner,
  fmt,
  MEMBER_STATUSES,
  Pill,
  RELATIONSHIP_KINDS,
  SectionCard,
  shortUid,
} from "./shared";

export function PatientAccessTab() {
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
