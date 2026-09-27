// src/utils/notifications/templates.js

// Non-English entries are technical placeholders pending human linguistic review.
const INVESTIGATION_READY_TECHNICAL_PRESENTATION = Object.freeze({
  pushTitle: 'Investigation Report Ready',
  smsTitle: 'Investigation report ready',
  body: 'Hello {name}, your investigation report for "{testName}" is now ready. You can view or download it from the VH Health app.',
});

export const INVESTIGATION_READY_PRESENTATIONS = Object.freeze({
  en: Object.freeze({ ...INVESTIGATION_READY_TECHNICAL_PRESENTATION }),
  hi: Object.freeze({ ...INVESTIGATION_READY_TECHNICAL_PRESENTATION }),
  ta: Object.freeze({ ...INVESTIGATION_READY_TECHNICAL_PRESENTATION }),
  te: Object.freeze({ ...INVESTIGATION_READY_TECHNICAL_PRESENTATION }),
  ml: Object.freeze({ ...INVESTIGATION_READY_TECHNICAL_PRESENTATION }),
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
  en: Object.freeze({ ...APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION }),
  hi: Object.freeze({ ...APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION }),
  ta: Object.freeze({ ...APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION }),
  te: Object.freeze({ ...APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION }),
  ml: Object.freeze({ ...APPOINTMENT_REMINDER_TECHNICAL_PRESENTATION }),
});

const APPOINTMENT_CONFIRMATION_TECHNICAL_PRESENTATION = Object.freeze({
  pushTitle: 'Appointment Confirmed ✓',
  pushBody: 'Your appointment on {shortDate} at {time} is confirmed. Token #{tokenNumber}',
  smsTitle: 'Appointment confirmed',
  smsBody: 'Dear {patientName}, your appointment at Venkataeswara Hospitals is confirmed.\nDate: {longDate}\nTime: {time}\nDoctor: Dr. {doctorName}{deptPart}\nToken: #{tokenNumber}\n\nPlease arrive 15 min early. For queries call: {hospitalPhone}',
});

export const APPOINTMENT_CONFIRMATION_PRESENTATIONS = Object.freeze({
  en: Object.freeze({ ...APPOINTMENT_CONFIRMATION_TECHNICAL_PRESENTATION }),
  hi: Object.freeze({ ...APPOINTMENT_CONFIRMATION_TECHNICAL_PRESENTATION }),
  ta: Object.freeze({ ...APPOINTMENT_CONFIRMATION_TECHNICAL_PRESENTATION }),
  te: Object.freeze({ ...APPOINTMENT_CONFIRMATION_TECHNICAL_PRESENTATION }),
  ml: Object.freeze({ ...APPOINTMENT_CONFIRMATION_TECHNICAL_PRESENTATION }),
});

const APPOINTMENT_RESCHEDULE_TECHNICAL_PRESENTATION = Object.freeze({
  pushTitle: 'Appointment Rescheduled',
  pushBody: 'Your appointment has been moved to {newDate} at {newTime}{doctorPart}.{previousPart} Please do not attend at the earlier time.',
  smsTitle: 'Appointment rescheduled',
  smsBody: 'Dear {patientName}, your appointment at Venkataeswara Hospitals has been RESCHEDULED.\nNew date: {newDate}\nNew time: {newTime}\nDoctor: Dr. {doctorName}{deptPart}\n{previousPart}\nPlease do not attend at the earlier time. For queries call: {hospitalPhone}',
});

export const APPOINTMENT_RESCHEDULE_PRESENTATIONS = Object.freeze({
  en: Object.freeze({ ...APPOINTMENT_RESCHEDULE_TECHNICAL_PRESENTATION }),
  hi: Object.freeze({ ...APPOINTMENT_RESCHEDULE_TECHNICAL_PRESENTATION }),
  ta: Object.freeze({ ...APPOINTMENT_RESCHEDULE_TECHNICAL_PRESENTATION }),
  te: Object.freeze({ ...APPOINTMENT_RESCHEDULE_TECHNICAL_PRESENTATION }),
  ml: Object.freeze({ ...APPOINTMENT_RESCHEDULE_TECHNICAL_PRESENTATION }),
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

export function appointmentConfirmationPresentation(language) {
  return APPOINTMENT_CONFIRMATION_PRESENTATIONS[fiveLocaleKey(language)];
}

export function appointmentReschedulePresentation(language) {
  return APPOINTMENT_RESCHEDULE_PRESENTATIONS[fiveLocaleKey(language)];
}

function renderFields(template, values) {
  return template.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (_, field) => {
      if (!Object.hasOwn(values, field)) throw new Error(`Unknown presentation field: ${field}`);
      return String(values[field]);
    },
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

export function renderAppointmentConfirmationPush({ date, time, tokenNumber, language }) {
  const presentation = appointmentConfirmationPresentation(language);
  return {
    title: presentation.pushTitle,
    body: renderFields(presentation.pushBody, {
      shortDate: new Date(date).toLocaleDateString('en-IN'), time, tokenNumber,
    }),
  };
}

export function renderAppointmentConfirmationSms({
  patientName, doctorName, date, time, tokenNumber, department, hospitalPhone, language,
}) {
  const presentation = appointmentConfirmationPresentation(language);
  return renderFields(presentation.smsBody, {
    patientName,
    longDate: new Date(date).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    }),
    time,
    doctorName,
    deptPart: department ? ` (${department})` : '',
    tokenNumber,
    hospitalPhone,
  });
}

function formatRescheduleDate(value, options) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? String(value ?? '')
    : parsed.toLocaleDateString('en-IN', options);
}

export function renderAppointmentReschedulePush({
  newDate, newTime, doctorName, previousDate, previousTime, language,
}) {
  const presentation = appointmentReschedulePresentation(language);
  const doctorPart = doctorName ? ` with Dr. ${doctorName}` : '';
  const previousPart = previousDate || previousTime
    ? ` It was previously ${formatRescheduleDate(previousDate)}${previousTime ? ` at ${previousTime}` : ''}.`
    : '';
  return {
    title: presentation.pushTitle,
    body: renderFields(presentation.pushBody, {
      newDate: formatRescheduleDate(newDate), newTime, doctorPart, previousPart,
    }),
  };
}

export function renderAppointmentRescheduleSms({
  patientName, doctorName, date, time, previousDate, previousTime,
  department, hospitalPhone, language,
}) {
  const presentation = appointmentReschedulePresentation(language);
  const dateOptions = { day: 'numeric', month: 'long', year: 'numeric' };
  const previousPart = previousDate || previousTime
    ? `Previously: ${formatRescheduleDate(previousDate, dateOptions)}`
      + `${previousTime ? ` at ${previousTime}` : ''}\n`
    : '';
  return renderFields(presentation.smsBody, {
    patientName,
    newDate: formatRescheduleDate(date, dateOptions),
    newTime: time,
    doctorName,
    deptPart: department ? ` (${department})` : '',
    previousPart,
    hospitalPhone,
  });
}

export const NotificationTemplates = {
  investigationReady: ({ name, testName, language }) => {
    return renderFields(investigationReadyPresentation(language).body, { name, testName });
  },
};
