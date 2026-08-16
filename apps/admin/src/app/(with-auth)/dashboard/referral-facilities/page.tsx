"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  createReferralFacility,
  listReferralFacilities,
  REFERRAL_FACILITY_TYPES,
  setReferralFacilityActive,
  updateReferralFacility,
  type ReferralFacility,
  type ReferralFacilityType,
  type ReferralFacilityWrite,
} from "@/lib/api/referralFacilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Pencil, Plus, Power, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-hot-toast";

const QUERY_KEY = ["referral-facilities"];

const TYPE_LABELS: Record<ReferralFacilityType, string> = {
  hospital: "Hospital",
  clinic: "Clinic",
  diagnostic: "Diagnostic Centre",
  specialty_center: "Specialty Centre",
  other: "Other",
};

interface FormState {
  name: string;
  facilityType: ReferralFacilityType;
  specialtiesText: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  contactPerson: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  facilityType: "hospital",
  specialtiesText: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  pincode: "",
  phone: "",
  email: "",
  contactPerson: "",
  notes: "",
};

function toForm(facility: ReferralFacility): FormState {
  return {
    name: facility.name,
    facilityType: facility.facilityType,
    specialtiesText: facility.specialties.join(", "),
    addressLine1: facility.addressLine1 ?? "",
    addressLine2: facility.addressLine2 ?? "",
    city: facility.city ?? "",
    state: facility.state ?? "",
    pincode: facility.pincode ?? "",
    phone: facility.phone ?? "",
    email: facility.email ?? "",
    contactPerson: facility.contactPerson ?? "",
    notes: facility.notes ?? "",
  };
}

function toPayload(form: FormState): ReferralFacilityWrite {
  return {
    name: form.name.trim(),
    facilityType: form.facilityType,
    specialties: form.specialtiesText
      .split(/[,;]+/)
      .map((tag) => tag.trim())
      .filter(Boolean),
    addressLine1: form.addressLine1.trim() || null,
    addressLine2: form.addressLine2.trim() || null,
    city: form.city.trim() || null,
    state: form.state.trim() || null,
    pincode: form.pincode.trim() || null,
    phone: form.phone.trim() || null,
    email: form.email.trim() || null,
    contactPerson: form.contactPerson.trim() || null,
    notes: form.notes.trim() || null,
  };
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
  );
}

function FacilityForm({
  form,
  setForm,
  saving,
  onSubmit,
  onCancel,
  title,
}: {
  form: FormState;
  setForm: (updater: (prev: FormState) => FormState) => void;
  saving: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  title: string;
}) {
  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="rounded border bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-bold">{title}</h3>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-slate-500 hover:bg-slate-100"
          aria-label="Close form"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <TextField
            label="Facility name"
            value={form.name}
            onChange={set("name")}
            placeholder="e.g. Apollo Speciality Hospital"
          />
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Facility type
            </span>
            <select
              value={form.facilityType}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  facilityType: event.target.value as ReferralFacilityType,
                }))
              }
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {REFERRAL_FACILITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Specialties (comma-separated)"
            value={form.specialtiesText}
            onChange={set("specialtiesText")}
            placeholder="cardiology, nephrology"
          />
          <TextField
            label="Contact person"
            value={form.contactPerson}
            onChange={set("contactPerson")}
          />
          <TextField
            label="Phone"
            value={form.phone}
            onChange={set("phone")}
            placeholder="+91 44 2829 3333"
          />
          <TextField
            label="Email"
            value={form.email}
            onChange={set("email")}
            placeholder="referrals@facility.example"
          />
        </div>
        <div className="space-y-3">
          <TextField
            label="Address line 1"
            value={form.addressLine1}
            onChange={set("addressLine1")}
          />
          <TextField
            label="Address line 2"
            value={form.addressLine2}
            onChange={set("addressLine2")}
          />
          <div className="grid grid-cols-3 gap-3">
            <TextField label="City" value={form.city} onChange={set("city")} />
            <TextField
              label="State"
              value={form.state}
              onChange={set("state")}
            />
            <TextField
              label="PIN code"
              value={form.pincode}
              onChange={set("pincode")}
              placeholder="600006"
            />
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Notes
            </span>
            <textarea
              value={form.notes}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, notes: event.target.value }))
              }
              aria-label="Notes"
              rows={3}
              placeholder="e.g. cashless tie-up, ambulance transfer supported"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving || !form.name.trim()}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save facility"}
        </button>
      </div>
    </div>
  );
}

export default function ReferralFacilitiesPage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ReferralFacility | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [search, setSearch] = useState("");

  const facilitiesQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => listReferralFacilities(true),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (payload: ReferralFacilityWrite) =>
      createReferralFacility(payload),
    onSuccess: () => {
      toast.success("Facility created");
      setShowCreate(false);
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(
        err instanceof Error ? err.message : "Could not create facility",
      ),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: ReferralFacilityWrite;
    }) => updateReferralFacility(id, payload),
    onSuccess: () => {
      toast.success("Facility updated");
      setEditing(null);
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(
        err instanceof Error ? err.message : "Could not update facility",
      ),
  });

  const activeMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      setReferralFacilityActive(id, active),
    onSuccess: (facility) => {
      toast.success(
        facility.active ? "Facility reactivated" : "Facility deactivated",
      );
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(
        err instanceof Error ? err.message : "Could not change facility status",
      ),
  });

  const facilities = useMemo(() => {
    const rows = facilitiesQuery.data?.facilities ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((facility) =>
      [facility.name, facility.city ?? "", ...facility.specialties]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [facilitiesQuery.data, search]);

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Building2 className="h-7 w-7 text-blue-600" aria-hidden="true" />
            Referral Facilities
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Master list of external destination facilities. External referrals
            link a facility from this list so outbound care is trackable and
            reportable; deactivating a facility stops new referrals without
            touching historical ones.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setForm(EMPTY_FORM);
            setShowCreate(true);
          }}
          className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add facility
        </button>
      </div>

      {showCreate && !editing && (
        <FacilityForm
          form={form}
          setForm={setForm}
          saving={saving}
          title="Add destination facility"
          onCancel={() => setShowCreate(false)}
          onSubmit={() => createMutation.mutate(toPayload(form))}
        />
      )}
      {editing && (
        <FacilityForm
          form={form}
          setForm={setForm}
          saving={saving}
          title={`Edit ${editing.name}`}
          onCancel={() => {
            setEditing(null);
            setForm(EMPTY_FORM);
          }}
          onSubmit={() =>
            updateMutation.mutate({ id: editing.id, payload: toPayload(form) })
          }
        />
      )}

      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label="Search facilities"
        placeholder="Search by name, city, or specialty…"
        className="w-full max-w-md rounded border border-slate-300 px-3 py-2 text-sm"
      />

      {facilitiesQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : facilitiesQuery.isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {facilitiesQuery.error instanceof Error
            ? facilitiesQuery.error.message
            : "Could not load referral facilities."}
        </div>
      ) : facilities.length === 0 ? (
        <div className="rounded border bg-white p-10 text-center text-sm text-muted-foreground">
          No destination facilities yet. Add the hospitals and centres you refer
          patients to.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Facility</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Specialties</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {facilities.map((facility) => (
                <tr
                  key={facility.id}
                  className="border-b last:border-0 hover:bg-slate-50/60"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{facility.name}</div>
                    {facility.notes && (
                      <div className="max-w-72 truncate text-xs text-muted-foreground">
                        {facility.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {TYPE_LABELS[facility.facilityType] ??
                      facility.facilityType}
                  </td>
                  <td className="px-4 py-3">
                    {facility.specialties.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex max-w-64 flex-wrap gap-1">
                        {facility.specialties.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-slate-100 px-2 py-0.5 text-xs"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      {[facility.city, facility.state]
                        .filter(Boolean)
                        .join(", ") || "—"}
                    </div>
                    {facility.pincode && (
                      <div className="text-xs text-muted-foreground">
                        {facility.pincode}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div>{facility.contactPerson || "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {[facility.phone, facility.email]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        facility.active
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {facility.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setShowCreate(false);
                          setEditing(facility);
                          setForm(toForm(facility));
                        }}
                        className="rounded p-2 text-slate-500 hover:bg-slate-100"
                        aria-label={`Edit ${facility.name}`}
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          activeMutation.mutate({
                            id: facility.id,
                            active: !facility.active,
                          })
                        }
                        disabled={activeMutation.isPending}
                        className={`rounded p-2 hover:bg-slate-100 disabled:opacity-50 ${
                          facility.active ? "text-red-500" : "text-emerald-600"
                        }`}
                        aria-label={
                          facility.active
                            ? `Deactivate ${facility.name}`
                            : `Reactivate ${facility.name}`
                        }
                        title={facility.active ? "Deactivate" : "Reactivate"}
                      >
                        <Power className="h-4 w-4" aria-hidden="true" />
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
  );
}
