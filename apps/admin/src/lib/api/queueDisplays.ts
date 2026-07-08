import { fetchAdminAPI } from "./core";

export interface QueueDisplaySettings {
  enabled: boolean;
  pollIntervalSeconds: number;
  maxItems: number;
  etaBucketsEnabled: boolean;
  defaultLanguageCode: string;
  defaultAccessibilitySize: "standard" | "large" | "extra_large";
  enabledAt?: string | null;
  updatedAt?: string | null;
}

export interface QueueDisplayProfile {
  id: number;
  profileKey: string;
  displayName: string;
  locationLabel: string | null;
  facilityId: number | null;
  departmentId: number | null;
  doctorId: number | null;
  queueKind: string | null;
  queueLabelOverride: string | null;
  counterLabel: string | null;
  displayMode: "token_board" | "counter_board" | "department_board";
  languageCode: string;
  accessibilitySize: "standard" | "large" | "extra_large";
  contrastMode: "standard" | "high";
  motionMode: "standard" | "reduced";
  audioAnnouncementsEnabled: boolean;
  maskedNamePolicy: "token_only";
  isActive: boolean;
}

export interface QueueDisplayBoardItem {
  appointmentId: number;
  queueLabel: string;
  tokenDisplay: string;
  roomOrCounter: string | null;
  displayStatus: "scheduled" | "waiting" | "serving";
  appointmentTime: string | null;
  appointmentDate: string;
  lastUpdatedAt: string | null;
}

export interface QueueDisplayBoard {
  profile: QueueDisplayProfile;
  settings: QueueDisplaySettings;
  items: QueueDisplayBoardItem[];
  generatedAt: string;
  realtime: {
    channel: string;
    pollFallbackSeconds: number;
  };
  phiPolicy: {
    identity: "token_only";
    safeFieldsOnly: boolean;
  };
}

export async function getQueueDisplaySettings() {
  return fetchAdminAPI<QueueDisplaySettings>("/appointments/queue-displays/settings");
}

export async function listQueueDisplayProfiles(activeOnly = false) {
  const suffix = activeOnly ? "?active_only=true" : "";
  const result = await fetchAdminAPI<{ profiles: QueueDisplayProfile[]; count: number }>(
    `/appointments/queue-displays/profiles${suffix}`,
  );
  return result.profiles;
}

export async function getQueueDisplayBoard(profileId: number) {
  return fetchAdminAPI<QueueDisplayBoard>(`/appointments/queue-displays/profiles/${profileId}/board`);
}
