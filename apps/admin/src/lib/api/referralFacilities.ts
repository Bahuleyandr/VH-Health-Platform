import { fetchAdminAPI } from "./core";

export type ReferralFacilityType =
  | "hospital"
  | "clinic"
  | "diagnostic"
  | "specialty_center"
  | "other";

export const REFERRAL_FACILITY_TYPES: ReferralFacilityType[] = [
  "hospital",
  "clinic",
  "diagnostic",
  "specialty_center",
  "other",
];

export interface ReferralFacility {
  id: number;
  name: string;
  facilityType: ReferralFacilityType;
  specialties: string[];
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  contactPerson: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReferralFacilityList {
  facilities: ReferralFacility[];
  count: number;
}

export interface ReferralFacilityWrite {
  name?: string;
  facilityType?: ReferralFacilityType;
  specialties?: string[];
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
  contactPerson?: string | null;
  notes?: string | null;
}

export async function listReferralFacilities(includeInactive = true) {
  const query = includeInactive ? "?include_inactive=true" : "";
  return fetchAdminAPI<ReferralFacilityList>(`/referrals/facilities${query}`);
}

export async function createReferralFacility(payload: ReferralFacilityWrite) {
  return fetchAdminAPI<ReferralFacility>("/referrals/facilities", {
    method: "POST",
    body: payload,
  });
}

export async function updateReferralFacility(id: number, payload: ReferralFacilityWrite) {
  return fetchAdminAPI<ReferralFacility>(`/referrals/facilities/${id}`, {
    method: "PUT",
    body: payload,
  });
}

export async function setReferralFacilityActive(id: number, active: boolean) {
  return fetchAdminAPI<ReferralFacility>(`/referrals/facilities/${id}/active`, {
    method: "PUT",
    body: { active },
  });
}
