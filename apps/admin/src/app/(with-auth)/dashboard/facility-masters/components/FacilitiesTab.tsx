"use client";

import { EmptyState } from "@/components/EmptyState";
import {
  FACILITY_KINDS,
  FACILITY_STATUSES,
  saveFacility,
  seedDefaultFacility,
  type Facility,
  type FacilityPayload,
} from "@/lib/api/facilityMasters";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Pencil, Plus, Sprout } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import {
  CheckboxInput,
  ConfirmDialog,
  FormDialog,
  SelectInput,
  StatusPill,
  TextInput,
  formatDateTime,
  optionalNumber,
  optionalText,
  toEnumOptions,
} from "./shared";

interface FacilityForm {
  id: number | null;
  facility_code: string;
  display_name: string;
  facility_kind: string;
  status: string;
  is_default: boolean;
  legal_entity_name: string;
  registration_number: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
  timezone: string;
  phone: string;
  email: string;
  geo_lat: string;
  geo_lng: string;
}

const blankForm: FacilityForm = {
  id: null,
  facility_code: "",
  display_name: "",
  facility_kind: "hospital",
  status: "active",
  is_default: false,
  legal_entity_name: "",
  registration_number: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  country: "IN",
  postal_code: "",
  timezone: "Asia/Kolkata",
  phone: "",
  email: "",
  geo_lat: "",
  geo_lng: "",
};

function formFromFacility(facility: Facility): FacilityForm {
  return {
    id: facility.id,
    facility_code: facility.facility_code,
    display_name: facility.display_name,
    facility_kind: facility.facility_kind,
    status: facility.status,
    is_default: facility.is_default,
    legal_entity_name: facility.legal_entity_name ?? "",
    registration_number: facility.registration_number ?? "",
    address_line1: facility.address_line1 ?? "",
    address_line2: facility.address_line2 ?? "",
    city: facility.city ?? "",
    state: facility.state ?? "",
    country: facility.country ?? "",
    postal_code: facility.postal_code ?? "",
    timezone: facility.timezone ?? "",
    phone: facility.phone ?? "",
    email: facility.email ?? "",
    geo_lat: facility.geo_lat != null ? String(facility.geo_lat) : "",
    geo_lng: facility.geo_lng != null ? String(facility.geo_lng) : "",
  };
}

function payloadFromForm(form: FacilityForm): FacilityPayload {
  return {
    ...(form.id != null ? { id: form.id } : {}),
    facility_code: form.facility_code.trim(),
    display_name: form.display_name.trim(),
    facility_kind: form.facility_kind as FacilityPayload["facility_kind"],
    status: form.status as FacilityPayload["status"],
    is_default: form.is_default,
    legal_entity_name: optionalText(form.legal_entity_name),
    registration_number: optionalText(form.registration_number),
    address_line1: optionalText(form.address_line1),
    address_line2: optionalText(form.address_line2),
    city: optionalText(form.city),
    state: optionalText(form.state),
    country: optionalText(form.country),
    postal_code: optionalText(form.postal_code),
    timezone: optionalText(form.timezone),
    phone: optionalText(form.phone),
    email: optionalText(form.email),
    geo_lat: optionalNumber(form.geo_lat),
    geo_lng: optionalNumber(form.geo_lng),
  };
}

export function FacilitiesTab({
  facilities,
  onDrill,
}: {
  facilities: Facility[];
  onDrill: (facilityId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FacilityForm | null>(null);
  const [seedConfirmOpen, setSeedConfirmOpen] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["facility-masters"] });

  const saveMutation = useMutation({
    mutationFn: (payload: FacilityPayload) => saveFacility(payload),
    onSuccess: () => {
      toast.success("Facility saved");
      setForm(null);
      void refresh();
    },
    onError: (err: Error) => toast.error(err.message || "Facility save failed"),
  });

  const seedMutation = useMutation({
    mutationFn: () => seedDefaultFacility(),
    onSuccess: (row) => {
      toast.success(`Default facility ensured: ${row.display_name}`);
      setSeedConfirmOpen(false);
      void refresh();
    },
    onError: (err: Error) => {
      toast.error(err.message || "Seed default facility failed");
      setSeedConfirmOpen(false);
    },
  });

  const submit = () => {
    if (!form) return;
    if (!form.facility_code.trim() || !form.display_name.trim()) {
      toast.error("Facility code and display name are required");
      return;
    }
    saveMutation.mutate(payloadFromForm(form));
  };

  const set = (patch: Partial<FacilityForm>) =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => setSeedConfirmOpen(true)}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          <Sprout className="h-4 w-4" />
          Seed default facility
        </button>
        <button
          type="button"
          onClick={() => setForm({ ...blankForm })}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          New facility
        </button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {facilities.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    compact
                    icon={
                      <Building2 className="h-8 w-8 text-muted-foreground" />
                    }
                    title="No facilities yet"
                    description="Create one, or seed the tenant's default facility."
                  />
                </td>
              </tr>
            ) : (
              facilities.map((facility) => (
                <tr key={facility.id}>
                  <td className="px-3 py-3 font-mono text-xs">
                    {facility.facility_code}
                  </td>
                  <td className="px-3 py-3 font-medium text-foreground">
                    {facility.display_name}
                    {facility.is_default && (
                      <span className="ml-2 rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs text-teal-800">
                        default
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {facility.facility_kind.replace(/_/g, " ")}
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">
                    {facility.city ?? "-"}
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill value={facility.status} />
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">
                    {formatDateTime(facility.updated_at)}
                  </td>
                  <td
                    className="px-3 py-3 text-right"
                    aria-label={`Actions for ${facility.display_name}`}
                  >
                    <div className="inline-flex gap-2">
                      <button
                        type="button"
                        onClick={() => setForm(formFromFacility(facility))}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onDrill(facility.id)}
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Locations & rooms
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <FormDialog
          title={form.id != null ? "Edit facility" : "New facility"}
          onClose={() => setForm(null)}
          onSubmit={submit}
          pending={saveMutation.isPending}
        >
          <TextInput
            label="Facility code"
            value={form.facility_code}
            onChange={(v) => set({ facility_code: v })}
          />
          <TextInput
            label="Display name"
            value={form.display_name}
            onChange={(v) => set({ display_name: v })}
          />
          <SelectInput
            label="Facility kind"
            value={form.facility_kind}
            onChange={(v) => set({ facility_kind: v })}
            options={toEnumOptions(FACILITY_KINDS)}
          />
          <SelectInput
            label="Status"
            value={form.status}
            onChange={(v) => set({ status: v })}
            options={toEnumOptions(FACILITY_STATUSES)}
          />
          <TextInput
            label="Legal entity name"
            value={form.legal_entity_name}
            onChange={(v) => set({ legal_entity_name: v })}
          />
          <TextInput
            label="Registration number"
            value={form.registration_number}
            onChange={(v) => set({ registration_number: v })}
          />
          <TextInput
            label="Address line 1"
            value={form.address_line1}
            onChange={(v) => set({ address_line1: v })}
          />
          <TextInput
            label="Address line 2"
            value={form.address_line2}
            onChange={(v) => set({ address_line2: v })}
          />
          <TextInput
            label="City"
            value={form.city}
            onChange={(v) => set({ city: v })}
          />
          <TextInput
            label="State"
            value={form.state}
            onChange={(v) => set({ state: v })}
          />
          <TextInput
            label="Country"
            value={form.country}
            onChange={(v) => set({ country: v })}
          />
          <TextInput
            label="Postal code"
            value={form.postal_code}
            onChange={(v) => set({ postal_code: v })}
          />
          <TextInput
            label="Timezone"
            value={form.timezone}
            onChange={(v) => set({ timezone: v })}
          />
          <TextInput
            label="Phone"
            value={form.phone}
            onChange={(v) => set({ phone: v })}
          />
          <TextInput
            label="Email"
            value={form.email}
            onChange={(v) => set({ email: v })}
          />
          <TextInput
            label="Latitude"
            value={form.geo_lat}
            onChange={(v) => set({ geo_lat: v })}
          />
          <TextInput
            label="Longitude"
            value={form.geo_lng}
            onChange={(v) => set({ geo_lng: v })}
          />
          <CheckboxInput
            label="Default facility for tenant"
            checked={form.is_default}
            onChange={(v) => set({ is_default: v })}
          />
        </FormDialog>
      )}

      {seedConfirmOpen && (
        <ConfirmDialog
          title="Seed default facility?"
          body="Creates one default facility for this tenant from the tenant name. Idempotent: if a default facility already exists, nothing is created and the existing row is returned."
          confirmLabel="Seed facility"
          pending={seedMutation.isPending}
          onConfirm={() => seedMutation.mutate()}
          onCancel={() => setSeedConfirmOpen(false)}
        />
      )}
    </div>
  );
}
