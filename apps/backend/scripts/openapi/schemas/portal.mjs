const PATIENT_VISIBLE_NOTE_TYPES = [
  'op_consultation',
  'consultation',
  'consultation_note',
  'follow_up',
  'follow-up',
  'progress',
  'soap',
];

const clinicalNoteDemarcation =
  'Patient portal clinical-note reads return only signed outpatient notes with a first-class clinical_notes.appointment_id link. Inpatient, ward, case-sheet, procedure, discharge-source, and legacy JSON/time-window-linked notes are intentionally excluded.';

export const schemas = {};

export const operations = {
  'GET /api/v1/portal/clinical-notes': {
    summary: 'List patient-visible OP consultation notes',
    description: `${clinicalNoteDemarcation} The optional note_type filter is intersected with the patient-visible vocabulary; unsupported values return an empty list.`,
    responseDescription: 'Signed outpatient appointment-bound notes visible to the authenticated patient.',
    parameters: [
      {
        name: 'note_type',
        in: 'query',
        required: false,
        description: 'Optional patient-visible note type filter. Unsupported values intentionally return an empty data array.',
        schema: {
          type: 'string',
          enum: PATIENT_VISIBLE_NOTE_TYPES,
        },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'Maximum number of notes to return.',
        schema: {
          type: 'integer',
          minimum: 1,
          default: 100,
        },
      },
    ],
  },
  'GET /api/v1/portal/clinical-notes/appointment/{appointmentId}': {
    summary: 'List OP notes for one appointment',
    description: `${clinicalNoteDemarcation} Appointment-scoped reads require clinical_notes.appointment_id to equal the path appointmentId; embedded JSON appointment ids and date-window fallbacks are not used.`,
    responseDescription: 'Signed outpatient notes linked to the requested appointment.',
  },
  'GET /api/v1/portal/clinical-notes/{id}': {
    summary: 'Get one patient-visible OP consultation note',
    description: `${clinicalNoteDemarcation} In-hospital notes return 404 even when the numeric note id exists for the patient.`,
    responseDescription: 'A signed outpatient appointment-bound note visible to the authenticated patient.',
  },
};
