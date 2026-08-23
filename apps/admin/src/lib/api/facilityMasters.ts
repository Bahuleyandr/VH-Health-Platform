// src/lib/api/facilityMasters.ts
// Typed client for /api/v1/admin/facilities (facility / location / room /
// service-catalog masters, backend Phase C1). The generated OpenAPI types
// only expose the generic Success envelope for these routes, so the row
// shapes below are hand-written against
// apps/backend/src/services/facility/facilityService.js RETURNING lists.

import { getJSON, postJSON, putJSON } from "./core";

/* =========================
 * Enums (mirrors backend facilityService constants)
 * ========================= */

export const FACILITY_KINDS = [
  "hospital",
  "clinic",
  "diagnostic_center",
  "pharmacy",
  "tele_hub",
  "corporate_office",
  "satellite_unit",
  "other",
] as const;
export type FacilityKind = (typeof FACILITY_KINDS)[number];

export const FACILITY_STATUSES = ["active", "paused", "archived"] as const;
export type FacilityStatus = (typeof FACILITY_STATUSES)[number];

export const LOCATION_KINDS = [
  "general",
  "opd",
  "ipd",
  "icu",
  "hdu",
  "er",
  "ot_block",
  "lab",
  "radiology",
  "pharmacy",
  "reception",
  "admin",
  "pacu",
  "ward",
  "isolation",
  "bay",
  "cabin",
  "corridor",
  "other",
] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const LOCATION_STATUSES = ["active", "paused", "archived"] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

export const ROOM_KINDS = [
  "general",
  "private",
  "semi_private",
  "shared",
  "icu",
  "isolation",
  "ot",
  "consulting",
  "examination",
  "procedure",
  "recovery",
  "storage",
  "other",
] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export const ROOM_STATUSES = [
  "active",
  "closed_for_cleaning",
  "maintenance",
  "archived",
] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const SERVICE_KINDS = [
  "consultation",
  "procedure",
  "investigation",
  "imaging",
  "pharmacy_dispense",
  "package",
  "room",
  "admission",
  "home_visit",
  "teleconsult",
  "service",
  "other",
] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const SERVICE_STATUSES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/* =========================
 * Row shapes
 * ========================= */

export interface Facility {
  id: number;
  tenant_id: string;
  facility_code: string;
  display_name: string;
  facility_kind: FacilityKind;
  legal_entity_name: string | null;
  registration_number: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  timezone: string | null;
  phone: string | null;
  email: string | null;
  status: FacilityStatus;
  is_default: boolean;
  geo_lat: string | number | null;
  geo_lng: string | number | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FacilityLocation {
  id: number;
  tenant_id: string;
  facility_id: number;
  parent_id: number | null;
  location_code: string;
  display_name: string;
  location_kind: LocationKind;
  floor: string | null;
  building: string | null;
  status: LocationStatus;
  capacity_hint: number | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FacilityRoom {
  id: number;
  tenant_id: string;
  facility_id: number;
  location_id: number;
  room_code: string;
  display_name: string;
  room_kind: RoomKind;
  bed_capacity: number | null;
  floor: string | null;
  status: RoomStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ServiceCatalogItem {
  id: number;
  tenant_id: string;
  facility_id: number | null;
  service_code: string;
  display_name: string;
  description: string | null;
  service_kind: ServiceKind;
  specialty: string | null;
  department_id: number | null;
  default_duration_minutes: number | null;
  requires_appointment: boolean;
  is_telehealth_eligible: boolean;
  default_tariff_item_code: string | null;
  status: ServiceStatus;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/* =========================
 * Upsert payloads (PUT routes are id-optional upserts; there is no DELETE —
 * retirement is status='archived')
 * ========================= */

export interface FacilityPayload {
  id?: number;
  facility_code: string;
  display_name: string;
  facility_kind?: FacilityKind | null;
  legal_entity_name?: string | null;
  registration_number?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postal_code?: string | null;
  timezone?: string | null;
  phone?: string | null;
  email?: string | null;
  status?: FacilityStatus | null;
  is_default?: boolean | null;
  geo_lat?: number | null;
  geo_lng?: number | null;
  metadata?: Record<string, unknown>;
}

export interface FacilityLocationPayload {
  id?: number;
  facility_id: number;
  parent_id?: number | null;
  location_code: string;
  display_name: string;
  location_kind?: LocationKind | null;
  floor?: string | null;
  building?: string | null;
  status?: LocationStatus | null;
  capacity_hint?: number | null;
  metadata?: Record<string, unknown>;
}

export interface FacilityRoomPayload {
  id?: number;
  facility_id: number;
  location_id: number;
  room_code: string;
  display_name: string;
  room_kind?: RoomKind | null;
  bed_capacity?: number | null;
  floor?: string | null;
  status?: RoomStatus | null;
  metadata?: Record<string, unknown>;
}

export interface ServiceCatalogPayload {
  id?: number;
  facility_id?: number | null;
  service_code: string;
  display_name: string;
  description?: string | null;
  service_kind?: ServiceKind | null;
  specialty?: string | null;
  department_id?: number | null;
  default_duration_minutes?: number | null;
  requires_appointment?: boolean | null;
  is_telehealth_eligible?: boolean | null;
  default_tariff_item_code?: string | null;
  status?: ServiceStatus | null;
  metadata?: Record<string, unknown>;
}

/* =========================
 * Calls
 * ========================= */

export async function listFacilities(
  params: { status?: string; facility_kind?: string; limit?: number } = {},
) {
  return getJSON<{ facilities: Facility[]; count: number }>(
    "/admin/facilities",
    {
      status: params.status,
      facility_kind: params.facility_kind,
      limit: params.limit,
    },
  );
}

export async function getDefaultFacility() {
  return getJSON<Facility | null>("/admin/facilities/default");
}

export async function saveFacility(payload: FacilityPayload) {
  return putJSON<Facility>("/admin/facilities", payload);
}

/** Idempotent: returns the existing default facility if one already exists. */
export async function seedDefaultFacility(fallbackName?: string) {
  return postJSON<Facility>(
    "/admin/facilities/seed-default",
    fallbackName ? { fallback_name: fallbackName } : {},
  );
}

export async function listFacilityLocations(
  params: {
    facility_id?: number;
    location_kind?: string;
    status?: string;
    /** Pass "null" to list only root locations (backend maps '' / 'null' to IS NULL). */
    parent_id?: number | "null";
    limit?: number;
  } = {},
) {
  return getJSON<{ locations: FacilityLocation[]; count: number }>(
    "/admin/facilities/locations",
    {
      facility_id: params.facility_id,
      location_kind: params.location_kind,
      status: params.status,
      parent_id: params.parent_id,
      limit: params.limit,
    },
  );
}

export async function saveFacilityLocation(payload: FacilityLocationPayload) {
  return putJSON<FacilityLocation>("/admin/facilities/locations", payload);
}

export async function listFacilityRooms(
  params: {
    facility_id?: number;
    location_id?: number;
    room_kind?: string;
    status?: string;
    limit?: number;
  } = {},
) {
  return getJSON<{ rooms: FacilityRoom[]; count: number }>(
    "/admin/facilities/rooms",
    {
      facility_id: params.facility_id,
      location_id: params.location_id,
      room_kind: params.room_kind,
      status: params.status,
      limit: params.limit,
    },
  );
}

export async function saveFacilityRoom(payload: FacilityRoomPayload) {
  return putJSON<FacilityRoom>("/admin/facilities/rooms", payload);
}

export async function listFacilityServices(
  params: {
    facility_id?: number;
    service_kind?: string;
    specialty?: string;
    status?: string;
    telehealth_eligible?: boolean;
    limit?: number;
  } = {},
) {
  return getJSON<{ services: ServiceCatalogItem[]; count: number }>(
    "/admin/facilities/services",
    {
      facility_id: params.facility_id,
      service_kind: params.service_kind,
      specialty: params.specialty,
      status: params.status,
      telehealth_eligible: params.telehealth_eligible,
      limit: params.limit,
    },
  );
}

export async function saveFacilityService(payload: ServiceCatalogPayload) {
  return putJSON<ServiceCatalogItem>("/admin/facilities/services", payload);
}
