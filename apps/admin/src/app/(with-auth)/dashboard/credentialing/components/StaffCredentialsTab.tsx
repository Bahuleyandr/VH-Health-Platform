"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { getStaffList, type StaffListResponse, type StaffMember } from "@/lib/api/staff";
import {
  addCredential,
  decideApproval,
  listApprovals,
  listCatalog,
  listCredentials,
  requestPrivilegeGrant,
  updateCredentialStatus,
  uploadCredentialDocument,
} from "./api";
import { formatDate, humanize, StatusBadge, TypeBadge } from "./shared";
import type { CredentialStatus, CredentialType, StaffCredential } from "./types";

const CREDENTIAL_TYPES: CredentialType[] = [
  "registration",
  "qualification",
  "training",
  "immunization",
];

function staffLabel(staff: StaffMember) {
  const role = staff.role ? ` - ${staff.role}` : "";
  const emp = staff.employee_id ? ` (${staff.employee_id})` : "";
  return `${staff.name}${emp}${role}`;
}

function blankCredentialForm() {
  return {
    credential_type: "registration" as CredentialType,
    name: "",
    issuing_body: "",
    registration_number: "",
    valid_until: "",
    notes: "",
  };
}

export function StaffCredentialsTab() {
  const qc = useQueryClient();
  const [selectedStaffUid, setSelectedStaffUid] = useState("");
  const [credentialForm, setCredentialForm] = useState(blankCredentialForm);
  const [privilegeCatalogId, setPrivilegeCatalogId] = useState("");

  const staffQuery = useQuery<StaffListResponse>({
    queryKey: ["credentialing", "staff"],
    queryFn: () => getStaffList({ limit: 250 }),
  });
  const staffRows = useMemo(() => staffQuery.data?.staff ?? [], [staffQuery.data?.staff]);

  useEffect(() => {
    if (!selectedStaffUid && staffRows[0]?.uid) {
      setSelectedStaffUid(staffRows[0].uid);
    }
  }, [selectedStaffUid, staffRows]);

  const selectedStaff = staffRows.find((row) => row.uid === selectedStaffUid) ?? null;

  const catalogQuery = useQuery({
    queryKey: ["credentialing", "catalog"],
    queryFn: listCatalog,
  });
  const catalog = catalogQuery.data?.catalog ?? [];

  const credentialsQuery = useQuery({
    queryKey: ["credentialing", "credentials", selectedStaffUid],
    queryFn: () => listCredentials(selectedStaffUid),
    enabled: Boolean(selectedStaffUid),
  });
  const credentials = credentialsQuery.data?.credentials ?? [];

  const approvalsQuery = useQuery({
    queryKey: ["credentialing", "approvals", "pending"],
    queryFn: () => listApprovals("pending"),
  });
  const approvals = approvalsQuery.data?.approvals ?? [];

  const addMut = useMutation({
    mutationFn: () =>
      addCredential({
        staff_uid: selectedStaffUid,
        credential_type: credentialForm.credential_type,
        name: credentialForm.name,
        issuing_body: credentialForm.issuing_body || null,
        registration_number: credentialForm.registration_number || null,
        valid_until: credentialForm.valid_until || null,
        notes: credentialForm.notes || null,
      }),
    onSuccess: () => {
      setCredentialForm(blankCredentialForm());
      void qc.invalidateQueries({ queryKey: ["credentialing", "credentials", selectedStaffUid] });
    },
  });

  const requestMut = useMutation({
    mutationFn: () =>
      requestPrivilegeGrant({
        staff_uid: selectedStaffUid,
        privilege_catalog_id: Number(privilegeCatalogId),
      }),
    onSuccess: () => {
      setPrivilegeCatalogId("");
      void qc.invalidateQueries({ queryKey: ["credentialing", "credentials", selectedStaffUid] });
      void qc.invalidateQueries({ queryKey: ["credentialing", "approvals"] });
    },
  });

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: number; status: CredentialStatus }) =>
      updateCredentialStatus(id, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["credentialing", "credentials", selectedStaffUid] });
      void qc.invalidateQueries({ queryKey: ["credentialing", "expiry-alerts"] });
    },
  });

  const approvalMut = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "approved" | "rejected" }) =>
      decideApproval(id, decision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["credentialing", "approvals"] });
      void qc.invalidateQueries({ queryKey: ["credentialing", "credentials", selectedStaffUid] });
    },
  });

  const uploadMut = useMutation({
    mutationFn: ({ credentialId, file }: { credentialId: number; file: File }) =>
      uploadCredentialDocument(credentialId, file),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["credentialing", "credentials", selectedStaffUid] }),
  });

  const errMsg =
    (
      staffQuery.error ??
      credentialsQuery.error ??
      catalogQuery.error ??
      approvalsQuery.error ??
      addMut.error ??
      requestMut.error ??
      statusMut.error ??
      approvalMut.error ??
      uploadMut.error
    )?.toString() ?? null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Staff credentials</h2>
                <p className="text-sm text-muted-foreground">
                  {selectedStaff ? staffLabel(selectedStaff) : "Select staff"}
                </p>
              </div>
              <select
                value={selectedStaffUid}
                onChange={(event) => setSelectedStaffUid(event.target.value)}
                className="min-w-64 rounded-md border bg-background px-3 py-2 text-sm"
              >
                {staffRows.map((staff) => (
                  <option key={staff.uid ?? staff.id} value={staff.uid ?? ""}>
                    {staffLabel(staff)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {errMsg && (
            <div className="m-4 rounded border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
              {errMsg}
            </div>
          )}

          {staffQuery.isLoading || credentialsQuery.isLoading ? (
            <LoadingSpinner label="Loading credentials" />
          ) : !selectedStaffUid ? (
            <EmptyState title="No staff selected" compact />
          ) : credentials.length === 0 ? (
            <EmptyState title="No credentials recorded" compact />
          ) : (
            <CredentialTable
              credentials={credentials}
              statusPending={statusMut.isPending}
              uploadPending={uploadMut.isPending}
              onStatus={(id, status) => statusMut.mutate({ id, status })}
              onUpload={(credentialId, file) => uploadMut.mutate({ credentialId, file })}
            />
          )}
        </div>

        <div className="space-y-4">
          <form
            className="rounded-lg border bg-card p-4 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              addMut.mutate();
            }}
          >
            <h2 className="mb-3 text-lg font-semibold">Record credential</h2>
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="text-xs font-medium text-muted-foreground">Type</span>
                <select
                  value={credentialForm.credential_type}
                  onChange={(event) =>
                    setCredentialForm({
                      ...credentialForm,
                      credential_type: event.target.value as CredentialType,
                    })
                  }
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                >
                  {CREDENTIAL_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {humanize(type)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-xs font-medium text-muted-foreground">Name</span>
                <input
                  value={credentialForm.name}
                  onChange={(event) =>
                    setCredentialForm({ ...credentialForm, name: event.target.value })
                  }
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                  required
                />
              </label>
              <label className="block text-sm">
                <span className="text-xs font-medium text-muted-foreground">Issuing body</span>
                <input
                  value={credentialForm.issuing_body}
                  onChange={(event) =>
                    setCredentialForm({ ...credentialForm, issuing_body: event.target.value })
                  }
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="text-xs font-medium text-muted-foreground">Registration</span>
                  <input
                    value={credentialForm.registration_number}
                    onChange={(event) =>
                      setCredentialForm({
                        ...credentialForm,
                        registration_number: event.target.value,
                      })
                    }
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-xs font-medium text-muted-foreground">Valid until</span>
                  <input
                    type="date"
                    value={credentialForm.valid_until}
                    onChange={(event) =>
                      setCredentialForm({ ...credentialForm, valid_until: event.target.value })
                    }
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={!selectedStaffUid || addMut.isPending}
                className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {addMut.isPending ? "Saving..." : "Save credential"}
              </button>
            </div>
          </form>

          <form
            className="rounded-lg border bg-card p-4 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              requestMut.mutate();
            }}
          >
            <h2 className="mb-3 text-lg font-semibold">Request privilege</h2>
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="text-xs font-medium text-muted-foreground">Privilege</span>
                <select
                  value={privilegeCatalogId}
                  onChange={(event) => setPrivilegeCatalogId(event.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                  required
                >
                  <option value="">Select privilege</option>
                  {catalog
                    .filter((row) => row.status === "active")
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.display_name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={!selectedStaffUid || !privilegeCatalogId || requestMut.isPending}
                className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {requestMut.isPending ? "Requesting..." : "Request grant"}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="rounded-lg border bg-card shadow-sm">
        <div className="border-b px-4 py-3">
          <h2 className="text-lg font-semibold">Pending privilege approvals</h2>
        </div>
        {approvalsQuery.isLoading ? (
          <LoadingSpinner label="Loading approvals" />
        ) : approvals.length === 0 ? (
          <EmptyState title="No pending approvals" compact />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Staff</th>
                  <th className="px-3 py-2">Privilege</th>
                  <th className="px-3 py-2">Required role</th>
                  <th className="px-3 py-2">Requested</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {approvals.map((approval) => (
                  <tr key={approval.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{approval.staff_name ?? approval.staff_uid}</div>
                      <div className="text-xs text-muted-foreground">{approval.staff_role ?? "-"}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {approval.privilege_key ?? "-"}
                    </td>
                    <td className="px-3 py-2">{humanize(approval.required_role)}</td>
                    <td className="px-3 py-2">{formatDate(approval.created_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={approvalMut.isPending}
                          onClick={() => approvalMut.mutate({ id: approval.id, decision: "approved" })}
                          className="rounded border border-emerald-200 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={approvalMut.isPending}
                          onClick={() => approvalMut.mutate({ id: approval.id, decision: "rejected" })}
                          className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CredentialTable({
  credentials,
  statusPending,
  uploadPending,
  onStatus,
  onUpload,
}: {
  credentials: StaffCredential[];
  statusPending: boolean;
  uploadPending: boolean;
  onStatus: (id: number, status: CredentialStatus) => void;
  onUpload: (credentialId: number, file: File) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="border-b text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Credential</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Valid until</th>
            <th className="px-3 py-2">Renewal</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Document</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {credentials.map((credential) => (
            <tr key={credential.id} className="border-b last:border-0">
              <td className="px-3 py-2">
                <div className="font-medium">
                  {credential.privilege_display_name ?? credential.name}
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {credential.registration_number || credential.privilege_key || credential.name}
                </div>
              </td>
              <td className="px-3 py-2">
                <TypeBadge type={credential.credential_type} />
              </td>
              <td className={credential.expired ? "px-3 py-2 text-rose-700" : "px-3 py-2"}>
                {formatDate(credential.valid_until)}
              </td>
              <td className="px-3 py-2">
                <div>{humanize(credential.renewal_status)}</div>
                <div className="text-xs text-muted-foreground">
                  {formatDate(credential.renewal_due_at)}
                </div>
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={credential.status} />
              </td>
              <td className="px-3 py-2">
                <label className="inline-flex cursor-pointer items-center rounded border px-2 py-1 text-xs hover:bg-muted">
                  {credential.document_uploaded_at ? "Replace" : "Upload"}
                  <input
                    type="file"
                    className="sr-only"
                    disabled={uploadPending}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) onUpload(credential.id, file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              </td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-2">
                  {credential.status !== "active" && (
                    <button
                      type="button"
                      disabled={statusPending}
                      onClick={() => onStatus(credential.id, "active")}
                      className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      Activate
                    </button>
                  )}
                  {credential.status !== "suspended" && (
                    <button
                      type="button"
                      disabled={statusPending}
                      onClick={() => onStatus(credential.id, "suspended")}
                      className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      Suspend
                    </button>
                  )}
                  {credential.status !== "revoked" && (
                    <button
                      type="button"
                      disabled={statusPending}
                      onClick={() => onStatus(credential.id, "revoked")}
                      className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
