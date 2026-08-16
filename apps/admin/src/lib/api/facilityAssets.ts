import { fetchAdminAPI } from "./core";

export type FacilityAssetCategory =
  | "furniture"
  | "hvac"
  | "electrical"
  | "plumbing"
  | "it_equipment"
  | "generator"
  | "vehicle"
  | "kitchen"
  | "laundry"
  | "safety"
  | "infrastructure"
  | "other";

export const FACILITY_ASSET_CATEGORIES: FacilityAssetCategory[] = [
  "furniture",
  "hvac",
  "electrical",
  "plumbing",
  "it_equipment",
  "generator",
  "vehicle",
  "kitchen",
  "laundry",
  "safety",
  "infrastructure",
  "other",
];

export type FacilityAssetCondition = "good" | "fair" | "poor";

export const FACILITY_ASSET_CONDITIONS: FacilityAssetCondition[] = [
  "good",
  "fair",
  "poor",
];

export type FacilityAssetStatus =
  | "active"
  | "under_repair"
  | "condemned"
  | "disposed";

export const FACILITY_ASSET_STATUSES: FacilityAssetStatus[] = [
  "active",
  "under_repair",
  "condemned",
  "disposed",
];

export interface FacilityAsset {
  id: number;
  assetTag: string;
  name: string;
  category: FacilityAssetCategory;
  description: string | null;
  locationDepartment: string | null;
  locationRoom: string | null;
  custodianUid: string | null;
  vendor: string | null;
  purchaseDate: string | null;
  purchaseCost: number | null;
  warrantyUntil: string | null;
  condition: FacilityAssetCondition;
  status: FacilityAssetStatus;
  disposalReason: string | null;
  disposedAt: string | null;
  disposedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface FacilityAssetEvent {
  id: number;
  assetId: number | null;
  assetTag: string;
  assetName: string;
  eventType: string;
  fromStatus: FacilityAssetStatus | null;
  toStatus: FacilityAssetStatus | null;
  details: Record<string, unknown>;
  notes: string | null;
  actorUid: string | null;
  actorRole: string | null;
  occurredAt: string | null;
}

export interface FacilityAssetDetail extends FacilityAsset {
  events: FacilityAssetEvent[];
}

export interface FacilityAssetList {
  assets: FacilityAsset[];
  total: number;
  limit: number;
  offset: number;
}

export interface FacilityAssetWrite {
  assetTag?: string;
  name?: string;
  category?: FacilityAssetCategory;
  description?: string | null;
  locationDepartment?: string | null;
  locationRoom?: string | null;
  custodianUid?: string | null;
  vendor?: string | null;
  purchaseDate?: string | null;
  purchaseCost?: number | null;
  warrantyUntil?: string | null;
  condition?: FacilityAssetCondition;
  notes?: string | null;
}

export interface FacilityAssetListFilters {
  status?: FacilityAssetStatus | "";
  category?: FacilityAssetCategory | "";
  q?: string;
}

export async function listFacilityAssets(filters: FacilityAssetListFilters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.category) params.set("category", filters.category);
  if (filters.q) params.set("q", filters.q);
  const query = params.toString();
  return fetchAdminAPI<FacilityAssetList>(
    `/facility/assets${query ? `?${query}` : ""}`,
  );
}

export async function getFacilityAsset(id: number) {
  return fetchAdminAPI<FacilityAssetDetail>(`/facility/assets/${id}`);
}

export async function createFacilityAsset(payload: FacilityAssetWrite) {
  return fetchAdminAPI<FacilityAsset>("/facility/assets", {
    method: "POST",
    body: payload,
  });
}

export async function updateFacilityAsset(
  id: number,
  payload: FacilityAssetWrite,
) {
  return fetchAdminAPI<FacilityAsset>(`/facility/assets/${id}`, {
    method: "PATCH",
    body: payload,
  });
}

export async function transitionFacilityAsset(
  id: number,
  toStatus: FacilityAssetStatus,
  reason?: string,
  notes?: string,
) {
  return fetchAdminAPI<FacilityAsset>(`/facility/assets/${id}/status`, {
    method: "POST",
    body: { toStatus, reason: reason || null, notes: notes || null },
  });
}

export async function recordFacilityAssetMaintenance(
  id: number,
  notes: string,
  cost?: number | null,
  vendor?: string | null,
) {
  return fetchAdminAPI<{ asset: FacilityAsset; event: FacilityAssetEvent }>(
    `/facility/assets/${id}/maintenance`,
    {
      method: "POST",
      body: { notes, cost: cost ?? null, vendor: vendor ?? null },
    },
  );
}
