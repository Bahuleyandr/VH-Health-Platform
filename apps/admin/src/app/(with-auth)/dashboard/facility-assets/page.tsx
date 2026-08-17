"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { APIError } from "@/lib/api/core";
import {
  createFacilityAsset,
  FACILITY_ASSET_CATEGORIES,
  FACILITY_ASSET_CONDITIONS,
  FACILITY_ASSET_STATUSES,
  getFacilityAsset,
  listFacilityAssetCustodians,
  listFacilityAssets,
  recordFacilityAssetMaintenance,
  transitionFacilityAsset,
  updateFacilityAsset,
  type FacilityAsset,
  type FacilityAssetCategory,
  type FacilityAssetCondition,
  type FacilityAssetCustodian,
  type FacilityAssetStatus,
  type FacilityAssetWrite,
} from "@/lib/api/facilityAssets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Pencil, Plus, Wrench, X } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

const QUERY_KEY = ["facility-assets"];
const PAGE_SIZE = 50;

const CATEGORY_LABELS: Record<FacilityAssetCategory, string> = {
  furniture: "Furniture",
  hvac: "HVAC",
  electrical: "Electrical",
  plumbing: "Plumbing",
  it_equipment: "IT Equipment",
  generator: "Generator",
  vehicle: "Vehicle",
  kitchen: "Kitchen",
  laundry: "Laundry",
  safety: "Safety",
  infrastructure: "Infrastructure",
  other: "Other",
};

const STATUS_LABELS: Record<FacilityAssetStatus, string> = {
  active: "Active",
  under_repair: "Under repair",
  condemned: "Condemned",
  disposed: "Disposed",
};

const STATUS_STYLES: Record<FacilityAssetStatus, string> = {
  active: "bg-emerald-100 text-emerald-800",
  under_repair: "bg-amber-100 text-amber-800",
  condemned: "bg-orange-100 text-orange-800",
  disposed: "bg-slate-200 text-slate-600",
};

// Mirrors the service state machine: active ⇄ under_repair → condemned →
// disposed; direct disposal allowed; disposed is terminal.
const ALLOWED_TRANSITIONS: Record<FacilityAssetStatus, FacilityAssetStatus[]> =
  {
    active: ["under_repair", "condemned", "disposed"],
    under_repair: ["active", "condemned", "disposed"],
    condemned: ["disposed"],
    disposed: [],
  };

interface FormState {
  assetTag: string;
  name: string;
  category: FacilityAssetCategory;
  description: string;
  locationDepartment: string;
  locationRoom: string;
  custodianUid: string;
  vendor: string;
  purchaseDate: string;
  purchaseCost: string;
  warrantyUntil: string;
  condition: FacilityAssetCondition;
}

const EMPTY_FORM: FormState = {
  assetTag: "",
  name: "",
  category: "furniture",
  description: "",
  locationDepartment: "",
  locationRoom: "",
  custodianUid: "",
  vendor: "",
  purchaseDate: "",
  purchaseCost: "",
  warrantyUntil: "",
  condition: "good",
};
const FORM_FIELDS = Object.keys(EMPTY_FORM) as Array<keyof FormState>;

function toForm(asset: FacilityAsset): FormState {
  return {
    assetTag: asset.assetTag,
    name: asset.name,
    category: asset.category,
    description: asset.description ?? "",
    locationDepartment: asset.locationDepartment ?? "",
    locationRoom: asset.locationRoom ?? "",
    custodianUid: asset.custodianUid ?? "",
    vendor: asset.vendor ?? "",
    purchaseDate: asset.purchaseDate ?? "",
    purchaseCost: asset.purchaseCost == null ? "" : String(asset.purchaseCost),
    warrantyUntil: asset.warrantyUntil ?? "",
    condition: asset.condition,
  };
}

function toPayload(form: FormState): FacilityAssetWrite {
  return {
    assetTag: form.assetTag.trim(),
    name: form.name.trim(),
    category: form.category,
    description: form.description.trim() || null,
    locationDepartment: form.locationDepartment.trim() || null,
    locationRoom: form.locationRoom.trim() || null,
    custodianUid: form.custodianUid || null,
    vendor: form.vendor.trim() || null,
    purchaseDate: form.purchaseDate || null,
    purchaseCost: form.purchaseCost.trim() ? Number(form.purchaseCost) : null,
    warrantyUntil: form.warrantyUntil || null,
    condition: form.condition,
  };
}

function changedFormFields(form: FormState, asset: FacilityAsset) {
  const baseline = toForm(asset);
  return FORM_FIELDS.filter((field) => form[field] !== baseline[field]);
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <input
        value={value}
        type={type}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        aria-label={label}
        className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

function AssetForm({
  form,
  setForm,
  saving,
  onSubmit,
  onCancel,
  title,
  custodians,
}: {
  form: FormState;
  setForm: (updater: (prev: FormState) => FormState) => void;
  saving: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  title: string;
  custodians: FacilityAssetCustodian[];
}) {
  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const purchaseCost = form.purchaseCost.trim()
    ? Number(form.purchaseCost)
    : null;
  const purchaseCostInvalid =
    purchaseCost != null &&
    (!Number.isFinite(purchaseCost) || purchaseCost < 0);
  const availableCustodians =
    form.custodianUid &&
    !custodians.some((custodian) => custodian.uid === form.custodianUid)
      ? [
          {
            uid: form.custodianUid,
            name: "Current custodian",
            role: "inactive or unavailable",
          },
          ...custodians,
        ]
      : custodians;

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
            label="Asset tag"
            value={form.assetTag}
            onChange={set("assetTag")}
            placeholder="e.g. GEN-02"
          />
          <TextField
            label="Asset name"
            value={form.name}
            onChange={set("name")}
            placeholder="e.g. Diesel generator 125 kVA"
          />
          <SelectField
            label="Category"
            value={form.category}
            options={FACILITY_ASSET_CATEGORIES}
            labels={CATEGORY_LABELS}
            onChange={(category) => set("category")(category)}
          />
          <SelectField
            label="Condition"
            value={form.condition}
            options={FACILITY_ASSET_CONDITIONS}
            labels={{ good: "Good", fair: "Fair", poor: "Poor" }}
            onChange={(condition) => set("condition")(condition)}
          />
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Custodian
            </span>
            <select
              value={form.custodianUid}
              onChange={(event) => set("custodianUid")(event.target.value)}
              aria-label="Custodian"
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Unassigned</option>
              {availableCustodians.map((custodian) => (
                <option key={custodian.uid} value={custodian.uid}>
                  {custodian.name} ({custodian.role.replaceAll("_", " ")})
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Vendor"
            value={form.vendor}
            onChange={set("vendor")}
          />
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Department / area"
              value={form.locationDepartment}
              onChange={set("locationDepartment")}
              placeholder="Plant room"
            />
            <TextField
              label="Room"
              value={form.locationRoom}
              onChange={set("locationRoom")}
              placeholder="B-04"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <TextField
              label="Purchased"
              value={form.purchaseDate}
              onChange={set("purchaseDate")}
              type="date"
            />
            <TextField
              label="Cost (₹)"
              value={form.purchaseCost}
              onChange={set("purchaseCost")}
              type="number"
            />
            <TextField
              label="Warranty until"
              value={form.warrantyUntil}
              onChange={set("warrantyUntil")}
              type="date"
            />
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Description
            </span>
            <textarea
              value={form.description}
              onChange={(event) => set("description")(event.target.value)}
              aria-label="Description"
              rows={3}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          {purchaseCostInvalid && (
            <p className="text-xs text-red-600">
              Cost must be a non-negative number.
            </p>
          )}
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
          disabled={
            saving ||
            !form.assetTag.trim() ||
            !form.name.trim() ||
            purchaseCostInvalid
          }
          className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save asset"}
        </button>
      </div>
    </div>
  );
}

function AssetDrawer({
  assetId,
  onClose,
}: {
  assetId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [toStatus, setToStatus] = useState<FacilityAssetStatus | "">("");
  const [reason, setReason] = useState("");
  const [maintenanceNotes, setMaintenanceNotes] = useState("");
  const [maintenanceVendor, setMaintenanceVendor] = useState("");
  const [maintenanceCost, setMaintenanceCost] = useState("");

  const detailQuery = useQuery({
    queryKey: ["facility-asset", assetId],
    queryFn: () => getFacilityAsset(assetId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ["facility-asset", assetId] });
  };

  const transitionMutation = useMutation({
    mutationFn: () =>
      transitionFacilityAsset(
        assetId,
        toStatus as FacilityAssetStatus,
        reason.trim() || undefined,
      ),
    onSuccess: (asset) => {
      toast.success(`Asset marked ${STATUS_LABELS[asset.status]}`);
      setToStatus("");
      setReason("");
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(
        err instanceof Error ? err.message : "Could not change asset status",
      ),
  });

  const maintenanceMutation = useMutation({
    mutationFn: () =>
      recordFacilityAssetMaintenance(
        assetId,
        maintenanceNotes.trim(),
        maintenanceCost.trim() ? Number(maintenanceCost) : null,
        maintenanceVendor.trim() || null,
      ),
    onSuccess: () => {
      toast.success("Maintenance recorded");
      setMaintenanceNotes("");
      setMaintenanceVendor("");
      setMaintenanceCost("");
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(
        err instanceof Error ? err.message : "Could not record maintenance",
      ),
  });

  const asset = detailQuery.data;
  const disposalReasonMissing = toStatus === "disposed" && !reason.trim();
  const parsedMaintenanceCost = maintenanceCost.trim()
    ? Number(maintenanceCost)
    : null;
  const maintenanceCostInvalid =
    parsedMaintenanceCost != null &&
    (!Number.isFinite(parsedMaintenanceCost) || parsedMaintenanceCost < 0);

  return (
    <div className="rounded border bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-bold">
          {asset ? `${asset.assetTag} — ${asset.name}` : "Asset history"}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-500 hover:bg-slate-100"
          aria-label="Close asset details"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {detailQuery.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : !asset ? (
        <div className="text-sm text-muted-foreground">
          Could not load asset details.
        </div>
      ) : (
        <div className="space-y-4">
          {asset.status === "disposed" ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              Disposed{" "}
              {asset.disposedAt
                ? `on ${new Date(asset.disposedAt).toLocaleDateString()}`
                : ""}
              {asset.disposalReason ? ` — ${asset.disposalReason}` : ""}
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-2 rounded border p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Change status
                </div>
                <select
                  value={toStatus}
                  onChange={(event) =>
                    setToStatus(event.target.value as FacilityAssetStatus | "")
                  }
                  aria-label="New status"
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Select new status…</option>
                  {ALLOWED_TRANSITIONS[asset.status].map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  aria-label="Reason"
                  placeholder={
                    toStatus === "disposed"
                      ? "Disposal reason (required)"
                      : "Reason (optional)"
                  }
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => transitionMutation.mutate()}
                  disabled={
                    !toStatus ||
                    transitionMutation.isPending ||
                    (toStatus === "disposed" && !reason.trim())
                  }
                  className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {transitionMutation.isPending ? "Updating…" : "Update status"}
                </button>
                {disposalReasonMissing && (
                  <p className="text-xs text-red-600">
                    A reason is required to dispose an asset — it becomes the
                    durable disposal evidence.
                  </p>
                )}
              </div>
              <div className="space-y-2 rounded border p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Record maintenance
                </div>
                <textarea
                  value={maintenanceNotes}
                  onChange={(event) => setMaintenanceNotes(event.target.value)}
                  aria-label="Maintenance notes"
                  rows={3}
                  placeholder="What was serviced / repaired?"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={maintenanceVendor}
                    onChange={(event) =>
                      setMaintenanceVendor(event.target.value)
                    }
                    aria-label="Maintenance vendor"
                    placeholder="Vendor (optional)"
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={maintenanceCost}
                    type="number"
                    min="0"
                    step="0.01"
                    onChange={(event) => setMaintenanceCost(event.target.value)}
                    aria-label="Maintenance cost"
                    placeholder="Cost (optional)"
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                {maintenanceCostInvalid && (
                  <p className="text-xs text-red-600">
                    Maintenance cost must be a non-negative number.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => maintenanceMutation.mutate()}
                  disabled={
                    !maintenanceNotes.trim() ||
                    maintenanceCostInvalid ||
                    maintenanceMutation.isPending
                  }
                  className="inline-flex items-center gap-2 rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                >
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                  {maintenanceMutation.isPending
                    ? "Recording…"
                    : "Record maintenance"}
                </button>
              </div>
            </div>
          )}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              History
            </div>
            {asset.events.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No events recorded yet.
              </div>
            ) : (
              <ul className="space-y-1 text-sm">
                {asset.events.map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-wrap items-baseline gap-2 border-b py-1 last:border-0"
                  >
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium">
                      {event.eventType.replaceAll("_", " ")}
                    </span>
                    {event.toStatus && (
                      <span className="text-xs text-muted-foreground">
                        {event.fromStatus
                          ? `${STATUS_LABELS[event.fromStatus]} → `
                          : ""}
                        {STATUS_LABELS[event.toStatus]}
                      </span>
                    )}
                    {event.notes && <span>{event.notes}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {event.occurredAt
                        ? new Date(event.occurredAt).toLocaleString()
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function FacilityAssetsPage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<FacilityAsset | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<FacilityAssetStatus | "">(
    "",
  );
  const [categoryFilter, setCategoryFilter] = useState<
    FacilityAssetCategory | ""
  >("");
  const [custodianFilter, setCustodianFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [openAssetId, setOpenAssetId] = useState<number | null>(null);

  const custodiansQuery = useQuery({
    queryKey: ["facility-asset-custodians"],
    queryFn: () => listFacilityAssetCustodians(),
  });
  const custodians = custodiansQuery.data?.custodians ?? [];

  const assetsQuery = useQuery({
    queryKey: [
      ...QUERY_KEY,
      {
        status: statusFilter,
        category: categoryFilter,
        custodianUid: custodianFilter,
        q: search.trim(),
        limit: PAGE_SIZE,
        offset,
      },
    ],
    queryFn: () =>
      listFacilityAssets({
        status: statusFilter,
        category: categoryFilter,
        custodianUid: custodianFilter,
        q: search.trim() || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (payload: FacilityAssetWrite) => createFacilityAsset(payload),
    onSuccess: () => {
      toast.success("Asset registered");
      setShowCreate(false);
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: (err: unknown) =>
      toast.error(
        err instanceof Error ? err.message : "Could not register asset",
      ),
  });

  const updateMutation = useMutation({
    mutationFn: (variables: {
      id: number;
      payload: FacilityAssetWrite;
      expectedVersion: number;
      draft: FormState;
      dirty: Array<keyof FormState>;
    }) =>
      updateFacilityAsset(
        variables.id,
        variables.payload,
        variables.expectedVersion,
      ),
    onSuccess: () => {
      toast.success("Asset updated");
      setEditing(null);
      setForm(EMPTY_FORM);
      invalidate();
      if (openAssetId != null) {
        queryClient.invalidateQueries({
          queryKey: ["facility-asset", openAssetId],
        });
      }
    },
    onError: async (err: unknown, variables) => {
      const payload =
        err instanceof APIError && typeof err.data === "object"
          ? (err.data as { code?: unknown })
          : null;
      if (
        err instanceof APIError &&
        err.status === 409 &&
        payload?.code === "FACILITY_ASSET_STALE_WRITE"
      ) {
        invalidate();
        try {
          const latest = await getFacilityAsset(variables.id);
          const latestForm = toForm(latest);
          const preserved = {} as Partial<Record<keyof FormState, string>>;
          for (const field of variables.dirty) {
            preserved[field] = variables.draft[field];
          }
          setEditing(latest);
          setForm({ ...latestForm, ...preserved } as FormState);
          toast.error(
            "This asset changed after you opened it. Latest values were loaded and your edited fields were preserved; review and save again.",
          );
        } catch {
          toast.error(
            "This asset changed and the latest values could not be loaded. Close and reopen the editor before retrying.",
          );
        }
        return;
      }
      toast.error(
        err instanceof Error ? err.message : "Could not update asset",
      );
    },
  });

  const assets = assetsQuery.data?.assets ?? [];
  const total = assetsQuery.data?.total ?? 0;

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Boxes className="h-7 w-7 text-blue-600" aria-hidden="true" />
            Facility Assets
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Register of general (non-biomedical) facility assets — furniture,
            plant, IT, generators, vehicles and more. Every move, repair,
            condemnation and disposal is recorded as an append-only history
            event; biomedical devices live in the biomed CMMS.
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
          Register asset
        </button>
      </div>

      {showCreate && !editing && (
        <AssetForm
          form={form}
          setForm={setForm}
          saving={saving}
          title="Register facility asset"
          custodians={custodians}
          onCancel={() => setShowCreate(false)}
          onSubmit={() => createMutation.mutate(toPayload(form))}
        />
      )}
      {editing && (
        <AssetForm
          form={form}
          setForm={setForm}
          saving={saving}
          title={`Edit ${editing.assetTag}`}
          custodians={custodians}
          onCancel={() => {
            setEditing(null);
            setForm(EMPTY_FORM);
          }}
          onSubmit={() =>
            updateMutation.mutate({
              id: editing.id,
              payload: toPayload(form),
              expectedVersion: editing.version,
              draft: form,
              dirty: changedFormFields(form, editing),
            })
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
          aria-label="Search assets"
          placeholder="Search by tag, name, or location…"
          className="w-full max-w-md rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value as FacilityAssetStatus | "");
            setOffset(0);
          }}
          aria-label="Filter by status"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          {FACILITY_ASSET_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(event) => {
            setCategoryFilter(event.target.value as FacilityAssetCategory | "");
            setOffset(0);
          }}
          aria-label="Filter by category"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">All categories</option>
          {FACILITY_ASSET_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
        <select
          value={custodianFilter}
          onChange={(event) => {
            setCustodianFilter(event.target.value);
            setOffset(0);
          }}
          aria-label="Filter by custodian"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">All custodians</option>
          {custodians.map((custodian) => (
            <option key={custodian.uid} value={custodian.uid}>
              {custodian.name}
            </option>
          ))}
        </select>
      </div>

      {openAssetId != null && (
        <AssetDrawer
          assetId={openAssetId}
          onClose={() => setOpenAssetId(null)}
        />
      )}

      {assetsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : assetsQuery.isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {assetsQuery.error instanceof Error
            ? assetsQuery.error.message
            : "Could not load facility assets."}
        </div>
      ) : assets.length === 0 ? (
        <div className="rounded border bg-white p-10 text-center text-sm text-muted-foreground">
          No facility assets yet. Register furniture, plant and equipment so
          location, custody and disposal stay trackable.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Tag</th>
                <th className="px-4 py-3">Asset</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Condition</th>
                <th className="px-4 py-3">Warranty</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr
                  key={asset.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-slate-50/60"
                  onClick={() => setOpenAssetId(asset.id)}
                >
                  <td className="px-4 py-3 font-mono text-xs">
                    {asset.assetTag}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{asset.name}</div>
                    {asset.vendor && (
                      <div className="text-xs text-muted-foreground">
                        {asset.vendor}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {CATEGORY_LABELS[asset.category] ?? asset.category}
                  </td>
                  <td className="px-4 py-3">
                    {[asset.locationDepartment, asset.locationRoom]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                  <td className="px-4 py-3 capitalize">{asset.condition}</td>
                  <td className="px-4 py-3">
                    {asset.warrantyUntil
                      ? new Date(asset.warrantyUntil).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[asset.status]}`}
                    >
                      {STATUS_LABELS[asset.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (asset.status === "disposed") {
                            toast.error("Disposed assets are immutable");
                            return;
                          }
                          setShowCreate(false);
                          setEditing(asset);
                          setForm(toForm(asset));
                        }}
                        className="rounded p-2 text-slate-500 hover:bg-slate-100"
                        aria-label={`Edit ${asset.assetTag}`}
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Showing {offset + 1}–{Math.min(offset + assets.length, total)} of{" "}
              {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setOffset((current) => Math.max(0, current - PAGE_SIZE))
                }
                disabled={offset === 0}
                className="rounded border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
                disabled={offset + assets.length >= total}
                className="rounded border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
