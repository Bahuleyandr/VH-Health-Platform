import fs from 'node:fs';

describe('appointment reminder scheduler contract', () => {
  const scheduler = fs.readFileSync(
    new URL('../../utils/scheduler.js', import.meta.url),
    'utf8'
  );
  const reminderJob = fs.readFileSync(
    new URL('../../utils/notifications/appointmentReminderJob.js', import.meta.url),
    'utf8'
  );

  it('registers only the authoritative hourly reminder engine', () => {
    expect(scheduler).toContain("withJobLock('timed-reminders'");
    expect(scheduler).not.toContain('sendAppointmentReminders');
    expect(scheduler).not.toContain("'send-appointment-reminders'");
    expect(reminderJob).not.toContain('sendAppointmentReminders');
  });
});
