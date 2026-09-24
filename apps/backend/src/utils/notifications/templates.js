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

export function investigationReadyLocaleKey(language) {
  const locale = String(language ?? '').trim().toLowerCase().replaceAll('_', '-').split('-')[0];
  return Object.hasOwn(INVESTIGATION_READY_PRESENTATIONS, locale) ? locale : 'en';
}

export function investigationReadyPresentation(language) {
  return INVESTIGATION_READY_PRESENTATIONS[investigationReadyLocaleKey(language)];
}

export const NotificationTemplates = {
  investigationReady: ({ name, testName, language }) => {
    const values = { name, testName };
    return investigationReadyPresentation(language).body.replace(
      /\{(name|testName)\}/g,
      (_, field) => String(values[field]),
    );
  },
};
