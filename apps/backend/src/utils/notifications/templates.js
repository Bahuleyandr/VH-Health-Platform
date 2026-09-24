// src/utils/notifications/templates.js

// Non-English entries are technical placeholders pending human linguistic review.
const INVESTIGATION_READY_TECHNICAL_PRESENTATION = Object.freeze({
  pushTitle: 'Investigation Report Ready',
  smsTitle: 'Investigation report ready',
  body: 'Hello {name}, your investigation report for "{testName}" is now ready. You can view or download it from the VH Health app.',
});

export const INVESTIGATION_READY_PRESENTATIONS = Object.freeze({
  en: INVESTIGATION_READY_TECHNICAL_PRESENTATION,
  hi: INVESTIGATION_READY_TECHNICAL_PRESENTATION,
  ta: INVESTIGATION_READY_TECHNICAL_PRESENTATION,
  te: INVESTIGATION_READY_TECHNICAL_PRESENTATION,
  ml: INVESTIGATION_READY_TECHNICAL_PRESENTATION,
});

const APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION = Object.freeze({
  push24Title: 'Appointment Tomorrow 📅',
  push24Body: 'Reminder: Your appointment is tomorrow at {time} with Dr. {doctorName}. Token #{tokenNumber}',
  push1Title: 'Appointment in 1 Hour ⏰',
  push1Body: 'Your appointment at {time} with Dr. {doctorName} is in ~1 hour. Token #{tokenNumber}',
  smsTitle: 'Appointment reminder',
  smsBody: 'Reminder: Dear {patientName}, you have an appointment at Venkataeswara Hospitals in {hoursLabel}.\nTime: {time} | Dr. {doctorName} | Token #{tokenNumber}',
});

export const APPOINTMENT_REMINDER_PRESENTATIONS = Object.freeze({
  en: APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION,
  hi: APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION,
  ta: APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION,
  te: APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION,
  ml: APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION,
});

function fiveLocaleKey(language) {
  const locale = String(language ?? '').trim().toLowerCase().replaceAll('_', '-').split('-')[0];
  return Object.hasOwn(INVESTIGATION_READY_PRESENTATIONS, locale) ? locale : 'en';
}

export function investigationReadyLocaleKey(language) {
  return fiveLocaleKey(language);
}

export function investigationReadyPresentation(language) {
  return INVESTIGATION_READY_PRESENTATIONS[investigationReadyLocaleKey(language)];
}

export function appointmentReminderPresentation(language) {
  return APPOINTMENT_REMINDER_PRESENTATIONS[fiveLocaleKey(language)];
}

function renderFields(template, values) {
  return template.replace(
    /\{(name|testName|time|doctorName|tokenNumber|patientName|hoursLabel)\}/g,
    (_, field) => String(values[field]),
  );
}

export function renderAppointmentReminderPush({ time, doctorName, tokenNumber, hoursAhead, language }) {
  const presentation = appointmentReminderPresentation(language);
  return hoursAhead === 24
    ? {
      title: presentation.push24Title,
      body: renderFields(presentation.push24Body, { time, doctorName, tokenNumber }),
    }
    : {
      title: presentation.push1Title,
      body: renderFields(presentation.push1Body, { time, doctorName, tokenNumber }),
    };
}

export function renderAppointmentReminderSms({
  patientName, doctorName, time, hoursAhead, tokenNumber, language,
}) {
  const hoursLabel = hoursAhead > 1 ? `${hoursAhead} hours` : '1 hour';
  return renderFields(appointmentReminderPresentation(language).smsBody, {
    patientName, doctorName, time, hoursLabel, tokenNumber,
  });
}

export const NotificationTemplates = {
  investigationReady: ({ name, testName, language }) => {
    return renderFields(investigationReadyPresentation(language).body, { name, testName });
  },
};
