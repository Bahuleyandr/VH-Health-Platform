import { API_ENDPOINTS } from "@/lib/api-config";

export type ComposerNotificationType = "info" | "warning" | "critical" | "success";
export type ComposerTargetType = "all" | "department" | "role" | "user";

type Priority = "HIGH" | "MEDIUM" | "LOW";
type BackendNotificationType = "INFO" | "ALERT" | "EMERGENCY" | "SYSTEM";

export interface NotificationComposerInput {
  title: string;
  message: string;
  type: ComposerNotificationType;
  target: ComposerTargetType;
  targetValue: string;
  scheduledDate?: string;
  scheduledTime?: string;
}

export interface NotificationComposerRequest {
  endpoint: string;
  payload: Record<string, unknown>;
}

const TYPE_CONTRACT: Record<
  ComposerNotificationType,
  { type: BackendNotificationType; priority: Priority }
> = {
  info: { type: "INFO", priority: "LOW" },
  success: { type: "SYSTEM", priority: "LOW" },
  warning: { type: "ALERT", priority: "MEDIUM" },
  critical: { type: "EMERGENCY", priority: "HIGH" },
};

function scheduledFor(input: NotificationComposerInput): string | undefined {
  const hasDate = Boolean(input.scheduledDate);
  const hasTime = Boolean(input.scheduledTime);
  if (!hasDate && !hasTime) return undefined;
  if (!hasDate || !hasTime) {
    throw new Error("Choose both a date and time for a scheduled notification");
  }
  const value = new Date(`${input.scheduledDate}T${input.scheduledTime}`);
  if (Number.isNaN(value.getTime())) {
    throw new Error("Choose a valid date and time");
  }
  return value.toISOString();
}

function parseUserIds(value: string): number[] {
  const tokens = value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const userIds = tokens.map(Number);
  if (
    userIds.length === 0 ||
    tokens.some((token) => !/^\d+$/.test(token)) ||
    userIds.some((id) => !Number.isSafeInteger(id) || id < 1)
  ) {
    throw new Error("Enter one or more numeric user IDs separated by commas");
  }
  return [...new Set(userIds)];
}

export function buildNotificationComposerRequest(
  input: NotificationComposerInput,
): NotificationComposerRequest {
  const title = input.title.trim();
  const message = input.message.trim();
  if (!title || !message) throw new Error("Title and message are required");

  const schedule = scheduledFor(input);
  const contract = TYPE_CONTRACT[input.type];

  if (input.target === "user") {
    return {
      endpoint: API_ENDPOINTS.notifications.targeted,
      payload: {
        title,
        message,
        type: contract.type,
        priority: contract.priority,
        user_ids: parseUserIds(input.targetValue),
        criteria: {},
        ...(schedule ? { scheduled_for: schedule } : {}),
      },
    };
  }

  const targetValue = input.targetValue.trim();
  if (input.target !== "all" && !targetValue) {
    throw new Error(`Enter a ${input.target} target`);
  }

  return {
    endpoint: API_ENDPOINTS.notifications.announcement,
    payload: {
      title,
      message,
      priority: contract.priority,
      target_roles: input.target === "role" ? [targetValue.toUpperCase()] : [],
      target_departments: input.target === "department" ? [targetValue] : [],
      ...(schedule ? { scheduled_for: schedule } : {}),
    },
  };
}
