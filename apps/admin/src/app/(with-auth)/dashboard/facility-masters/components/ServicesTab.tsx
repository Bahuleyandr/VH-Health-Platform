"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  SERVICE_KINDS,
  SERVICE_STATUSES,
  listFacilityServices,
  saveFacilityService,
  type Facility,
  type ServiceCatalogItem,
  type ServiceCatalogPayload,
} from "@/lib/api/facilityMasters";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Stethoscope } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import {
  CheckboxInput,
  FormDialog,
  SelectInput,
  StatusPill,
  TextInput,
  optionalNumber,
  optionalText,
  toEnumOptions,
} from "./shared";

interface ServiceForm {
  id: number | null;
  service_code: string;
  display_name: string;
  service_kind: string;
  specialty: string;
  facility_id: string;
  description: string;
  default_duration_minutes: string;
  requires_appointment: boolean;
  is_telehealth_eligible: boolean;
  default_tariff_item_code: string;
  status: string;
}

const blankService: ServiceForm = {
  id: null,
  service_code: "",
  display_name: "",
  service_kind: "consultation",
  specialty: "",
  facility_id: "",
  description: "",
  default_duration_minutes: "",
  requires_appointment: true,
  is_telehealth_eligible: false,
  default_tariff_item_code: "",
  status: "draft",
};

export function ServicesTab({ facilities }: { facilities: Facility[] }) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [form, setForm] = useState<ServiceForm | null>(null);

  const servicesQuery = useQuery({
    queryKey: ["facility-masters", "services", statusFilter, kindFilter],
    queryFn: () =>
      listFacilityServices({
        status: statusFilter || undefined,
        service_kind: kindFilter || undefined,
        limit: 200,
      }),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: ServiceCatalogPayload) => saveFacilityService(payload),
    onSuccess: () => {
      toast.success("Service saved");
      setForm(null);
      void queryClient.invalidateQueries({ queryKey: ["facility-masters"] });
    },
    onError: (err: Error) => toast.error(err.message || "Service save failed"),
  });

  const submit = () => {
    if (!form) return;
    if (!form.service_code.trim() || !form.display_name.trim()) {
      toast.error("Service code and display name are required");
      return;
    }
    saveMutation.mutate({
      ...(form.id != null ? { id: form.id } : {}),
      facility_id: optionalNumber(form.facility_id),
      service_code: form.service_code.trim(),
      display_name: form.display_name.trim(),
      description: optionalText(form.description),
      service_kind: form.service_kind as ServiceCatalogPayload["service_kind"],
      specialty: optionalText(form.specialty),
      default_duration_minutes: optionalNumber(form.default_duration_minutes),
      requires_appointment: form.requires_appointment,
      is_telehealth_eligible: form.is_telehealth_eligible,
      default_tariff_item_code: optionalText(form.default_tariff_item_code),
      status: form.status as ServiceCatalogPayload["status"],
    });
  };

  const services = servicesQuery.data?.services ?? [];
  const facilityLabel = (id: number | null) => {
    if (id == null) return "All facilities";
    const match = facilities.find((facility) => facility.id === id);
    return match ? match.display_name : `#${id}`;
  };

  const set = (patch: Partial<ServiceForm>) =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="w-44">
            <SelectInput
              label="Status filter"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[{ value: "", label: "All statuses" }, ...toEnumOptions(SERVICE_STATUSES)]}
            />
          </div>
          <div className="w-44">
            <SelectInput
              label="Kind filter"
              value={kindFilter}
              onChange={setKindFilter}
              options={[{ value: "", label: "All kinds" }, ...toEnumOptions(SERVICE_KINDS)]}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => setForm({ ...blankService })}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          New service
        </button>
      </div>

      {servicesQuery.isLoading ? (
        <LoadingSpinner label="Loading service catalog..." />
      ) : servicesQuery.error instanceof Error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {servicesQuery.error.message}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Specialty</th>
                <th className="px-3 py-2">Facility</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Telehealth</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {services.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState
                      compact
                      icon={<Stethoscope className="h-8 w-8 text-muted-foreground" />}
                      title="No services in catalog"
                      description="Define consultations, procedures, packages, and other billable services."
                    />
                  </td>
                </tr>
              ) : (
                services.map((service: ServiceCatalogItem) => (
                  <tr key={service.id}>
                    <td className="px-3 py-3 font-mono text-xs">{service.service_code}</td>
                    <td className="px-3 py-3 font-medium text-foreground">{service.display_name}</td>
                    <td className="px-3 py-3 text-xs">{service.service_kind.replace(/_/g, " ")}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{service.specialty ?? "-"}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{facilityLabel(service.facility_id)}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {service.default_duration_minutes != null ? `${service.default_duration_minutes} min` : "-"}
                    </td>
                    <td className="px-3 py-3 text-xs">{service.is_telehealth_eligible ? "Yes" : "No"}</td>
                    <td className="px-3 py-3">
                      <StatusPill value={service.status} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          setForm({
                            id: service.id,
                            service_code: service.service_code,
                            display_name: service.display_name,
                            service_kind: service.service_kind,
                            specialty: service.specialty ?? "",
                            facility_id: service.facility_id != null ? String(service.facility_id) : "",
                            description: service.description ?? "",
                            default_duration_minutes:
                              service.default_duration_minutes != null
                                ? String(service.default_duration_minutes)
                                : "",
                            requires_appointment: service.requires_appointment,
                            is_telehealth_eligible: service.is_telehealth_eligible,
                            default_tariff_item_code: service.default_tariff_item_code ?? "",
                            status: service.status,
                          })
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <FormDialog
          title={form.id != null ? "Edit service" : "New service"}
          onClose={() => setForm(null)}
          onSubmit={submit}
          pending={saveMutation.isPending}
        >
          <TextInput label="Service code" value={form.service_code} onChange={(v) => set({ service_code: v })} />
          <TextInput label="Service name" value={form.display_name} onChange={(v) => set({ display_name: v })} />
          <SelectInput label="Service kind" value={form.service_kind} onChange={(v) => set({ service_kind: v })} options={toEnumOptions(SERVICE_KINDS)} />
          <TextInput label="Specialty" value={form.specialty} onChange={(v) => set({ specialty: v })} />
          <SelectInput
            label="Facility scope"
            value={form.facility_id}
            onChange={(v) => set({ facility_id: v })}
            options={[
              { value: "", label: "All facilities" },
              ...facilities.map((facility) => ({ value: String(facility.id), label: facility.display_name })),
            ]}
          />
          <TextInput label="Default duration (minutes)" value={form.default_duration_minutes} onChange={(v) => set({ default_duration_minutes: v })} />
          <TextInput label="Default tariff item code" value={form.default_tariff_item_code} onChange={(v) => set({ default_tariff_item_code: v })} />
          <SelectInput label="Service status" value={form.status} onChange={(v) => set({ status: v })} options={toEnumOptions(SERVICE_STATUSES)} />
          <TextInput label="Description" value={form.description} onChange={(v) => set({ description: v })} />
          <CheckboxInput label="Requires appointment" checked={form.requires_appointment} onChange={(v) => set({ requires_appointment: v })} />
          <CheckboxInput label="Telehealth eligible" checked={form.is_telehealth_eligible} onChange={(v) => set({ is_telehealth_eligible: v })} />
        </FormDialog>
      )}
    </div>
  );
}
