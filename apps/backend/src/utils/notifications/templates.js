// src/utils/notifications/templates.js

export const NotificationTemplates = {
  appointmentReminder: ({ name, date, time, department, doctor }) =>
    `Dear ${name}, this is a reminder for your appointment on ${date} at ${time} in ${department} department with Dr. ${doctor}. Please be on time.`,

  investigationReady: ({ name, testName }) =>
    `Hello ${name}, your investigation report for "${testName}" is now ready. You can view or download it from the VH Health app.`,

  pharmacyReady: ({ name }) =>
    `Hi ${name}, your pharmacy prescription has been processed. Please check the VH Health app to review or collect.`,

  customBroadcast: ({ title, body }) =>
    `${title}: ${body}`,
};
