export const DEFAULT_APPOINTMENT_REAPER_GRACE_MINUTES = 60;

export function normalizeAppointmentReaperGraceMinutes(value) {
  return Math.max(
    15,
    Math.min(
      720,
      Number(value) || DEFAULT_APPOINTMENT_REAPER_GRACE_MINUTES,
    ),
  );
}
