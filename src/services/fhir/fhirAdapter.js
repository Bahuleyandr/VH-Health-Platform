// src/services/fhir/fhirAdapter.js
// HL7 FHIR R4 interoperability adapter
// Transforms VH Health internal data to/from FHIR R4 JSON resources

import logger from '../../logging/logger.js';

/**
 * Map VH Health gender values to FHIR administrative-gender codes.
 * @see https://hl7.org/fhir/R4/valueset-administrative-gender.html
 */
function toFhirGender(gender) {
  if (!gender) return 'unknown';
  const g = gender.toLowerCase().trim();
  if (g === 'male' || g === 'm') return 'male';
  if (g === 'female' || g === 'f') return 'female';
  if (g === 'other' || g === 'non-binary') return 'other';
  return 'unknown';
}

/**
 * Reverse-map FHIR gender to VH Health internal representation.
 */
function fromFhirGender(fhirGender) {
  if (!fhirGender) return null;
  const map = { male: 'Male', female: 'Female', other: 'Other', unknown: null };
  return map[fhirGender] ?? null;
}

/**
 * Format a JS Date or ISO string to FHIR date (YYYY-MM-DD).
 */
function toFhirDate(dateValue) {
  if (!dateValue) return undefined;
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

/**
 * Format a JS Date or ISO string to FHIR instant (YYYY-MM-DDThh:mm:ss+zz:zz).
 */
function toFhirInstant(dateValue) {
  if (!dateValue) return undefined;
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// =============================================================================
// TO FHIR CONVERTERS
// =============================================================================

/**
 * Convert VH Health user to FHIR R4 Patient resource.
 * @param {Object} user - Internal user record (from users table)
 * @returns {Object} FHIR Patient resource
 */
export function toFhirPatient(user) {
  if (!user) return null;

  const resource = {
    resourceType: 'Patient',
    id: user.uid || String(user.id),
    identifier: [
      {
        system: 'urn:vhhealth:uid',
        value: user.uid || String(user.id),
      },
    ],
    active: user.is_active !== false,
    name: [],
    telecom: [],
    gender: toFhirGender(user.gender),
  };

  // Name
  if (user.name) {
    resource.name.push({
      use: 'official',
      text: user.name,
    });
  }

  // Phone
  if (user.phone) {
    resource.telecom.push({
      system: 'phone',
      value: user.phone,
      use: 'mobile',
    });
  }

  // Email
  if (user.email) {
    resource.telecom.push({
      system: 'email',
      value: user.email,
    });
  }

  // Birth date
  const bd = toFhirDate(user.birthday);
  if (bd) {
    resource.birthDate = bd;
  }

  // Address
  if (user.address) {
    resource.address = [
      {
        use: 'home',
        text: user.address,
      },
    ];
  }

  // Profile picture as photo attachment
  if (user.profile_picture) {
    resource.photo = [
      {
        url: user.profile_picture,
      },
    ];
  }

  return resource;
}

/**
 * Convert VH Health appointment to FHIR R4 Appointment resource.
 * @param {Object} appointment - Internal appointment record
 * @returns {Object} FHIR Appointment resource
 */
export function toFhirAppointment(appointment) {
  if (!appointment) return null;

  // Map VH Health status to FHIR appointment-status
  const statusMap = {
    SCHEDULED: 'booked',
    CONFIRMED: 'booked',
    CHECKED_IN: 'arrived',
    IN_PROGRESS: 'arrived',
    COMPLETED: 'fulfilled',
    CANCELLED: 'cancelled',
    NO_SHOW: 'noshow',
    RESCHEDULED: 'pending',
  };

  const fhirStatus = statusMap[appointment.status] || 'proposed';

  const resource = {
    resourceType: 'Appointment',
    id: String(appointment.id),
    identifier: [
      {
        system: 'urn:vhhealth:appointment',
        value: String(appointment.id),
      },
    ],
    status: fhirStatus,
    description: appointment.reason || undefined,
    comment: appointment.notes || undefined,
    participant: [],
  };

  // Start time (combine date + time)
  if (appointment.appointment_date) {
    const dateStr = toFhirDate(appointment.appointment_date);
    const timeStr = appointment.appointment_time || '00:00';
    resource.start = `${dateStr}T${timeStr}:00.000Z`;
  }

  // Patient participant
  if (appointment.uid || appointment.phone) {
    resource.participant.push({
      actor: {
        reference: appointment.uid ? `Patient/${appointment.uid}` : undefined,
        display: appointment.patient_name || undefined,
        identifier: appointment.phone
          ? { system: 'urn:vhhealth:phone', value: appointment.phone }
          : undefined,
      },
      status: 'accepted',
    });
  }

  // Practitioner participant
  if (appointment.doctor_id || appointment.doctor_name) {
    resource.participant.push({
      actor: {
        reference: appointment.doctor_id ? `Practitioner/${appointment.doctor_id}` : undefined,
        display: appointment.doctor_name || undefined,
      },
      status: 'accepted',
    });
  }

  // Created timestamp
  if (appointment.created_at) {
    resource.created = toFhirInstant(appointment.created_at);
  }

  return resource;
}

/**
 * Convert vital sign data to FHIR R4 Observation resource.
 * @param {Object} vitalSign - Object with patient info and vital data
 *   Expected shape: { id, patient_uid, type, value, unit, recorded_date, recorded_by }
 * @returns {Object} FHIR Observation resource
 */
export function toFhirObservation(vitalSign) {
  if (!vitalSign) return null;

  // LOINC code mapping for common vital sign types
  const loincMap = {
    blood_pressure: { code: '85354-9', display: 'Blood pressure panel' },
    systolic: { code: '8480-6', display: 'Systolic blood pressure' },
    diastolic: { code: '8462-4', display: 'Diastolic blood pressure' },
    heart_rate: { code: '8867-4', display: 'Heart rate' },
    pulse: { code: '8867-4', display: 'Heart rate' },
    temperature: { code: '8310-5', display: 'Body temperature' },
    respiratory_rate: { code: '9279-1', display: 'Respiratory rate' },
    oxygen_saturation: { code: '2708-6', display: 'Oxygen saturation' },
    spo2: { code: '2708-6', display: 'Oxygen saturation' },
    weight: { code: '29463-7', display: 'Body weight' },
    height: { code: '8302-2', display: 'Body height' },
    bmi: { code: '39156-5', display: 'Body mass index' },
    blood_glucose: { code: '2339-0', display: 'Glucose [Mass/volume] in Blood' },
  };

  const type = (vitalSign.type || 'unknown').toLowerCase().replace(/\s+/g, '_');
  const loinc = loincMap[type] || { code: type, display: vitalSign.type || type };

  const resource = {
    resourceType: 'Observation',
    id: vitalSign.id ? String(vitalSign.id) : undefined,
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'vital-signs',
            display: 'Vital Signs',
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: loinc.code,
          display: loinc.display,
        },
      ],
      text: loinc.display,
    },
  };

  // Subject (patient reference)
  if (vitalSign.patient_uid) {
    resource.subject = {
      reference: `Patient/${vitalSign.patient_uid}`,
    };
  }

  // Effective date
  if (vitalSign.recorded_date) {
    resource.effectiveDateTime = toFhirInstant(vitalSign.recorded_date);
  }

  // Value — can be numeric or string
  if (vitalSign.value !== undefined && vitalSign.value !== null) {
    const numVal = Number(vitalSign.value);
    if (!isNaN(numVal)) {
      resource.valueQuantity = {
        value: numVal,
        unit: vitalSign.unit || '',
        system: 'http://unitsofmeasure.org',
      };
    } else {
      resource.valueString = String(vitalSign.value);
    }
  }

  // Performer (who recorded)
  if (vitalSign.recorded_by) {
    resource.performer = [
      {
        reference: `Practitioner/${vitalSign.recorded_by}`,
      },
    ];
  }

  return resource;
}

/**
 * Convert VH Health pharmacy order / prescription to FHIR R4 MedicationRequest.
 * @param {Object} prescription - Internal pharmacy_orders or prescription record
 * @returns {Object} FHIR MedicationRequest resource
 */
export function toFhirMedicationRequest(prescription) {
  if (!prescription) return null;

  // Map VH Health status to FHIR medicationrequest-status
  const statusMap = {
    PENDING: 'active',
    APPROVED: 'active',
    DISPENSED: 'completed',
    DELIVERED: 'completed',
    CANCELLED: 'cancelled',
    REJECTED: 'stopped',
    ON_HOLD: 'on-hold',
  };

  const fhirStatus = statusMap[prescription.status] || 'unknown';

  const resource = {
    resourceType: 'MedicationRequest',
    id: String(prescription.id),
    identifier: [
      {
        system: 'urn:vhhealth:pharmacy-order',
        value: String(prescription.id),
      },
    ],
    status: fhirStatus,
    intent: 'order',
  };

  // Medication — text-based since we may not have structured medication codes
  if (prescription.medication || prescription.order_note) {
    resource.medicationCodeableConcept = {
      text: prescription.medication || prescription.order_note,
    };
  }

  // Subject (patient)
  if (prescription.uid) {
    resource.subject = {
      reference: `Patient/${prescription.uid}`,
    };
  } else if (prescription.phone) {
    resource.subject = {
      identifier: { system: 'urn:vhhealth:phone', value: prescription.phone },
    };
  }

  // Requester (prescriber)
  if (prescription.prescribed_by) {
    resource.requester = {
      reference: `Practitioner/${prescription.prescribed_by}`,
    };
  }

  // Priority
  if (prescription.priority || prescription.urgent) {
    resource.priority = prescription.urgent ? 'urgent' : (prescription.priority || 'routine').toLowerCase();
  }

  // Authored on
  if (prescription.ordered_at || prescription.created_at) {
    resource.authoredOn = toFhirInstant(prescription.ordered_at || prescription.created_at);
  }

  // Note
  if (prescription.order_note) {
    resource.note = [{ text: prescription.order_note }];
  }

  return resource;
}

// =============================================================================
// CONDITION STATUS MAPPING
// =============================================================================

function mapConditionStatus(status) {
  if (!status) return 'active';
  const s = status.toLowerCase().trim();
  if (s === 'resolved') return 'resolved';
  if (s === 'recurrent') return 'recurrence';
  // active, chronic, and anything else → active
  return 'active';
}

/**
 * Convert VH Health diagnosis to FHIR R4 Condition resource.
 * @param {Object} diagnosis - Internal diagnosis record
 * @returns {Object} FHIR Condition resource
 */
export function toFhirCondition(diagnosis) {
  if (!diagnosis) return null;

  return {
    resourceType: 'Condition',
    id: String(diagnosis.id),
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          code: mapConditionStatus(diagnosis.status),
        },
      ],
    },
    code: {
      coding: diagnosis.icd10_code
        ? [
            {
              system: 'http://hl7.org/fhir/sid/icd-10-cm',
              code: diagnosis.icd10_code,
              display: diagnosis.icd10_description || diagnosis.description,
            },
          ]
        : [],
      text: diagnosis.description,
    },
    subject: { reference: `Patient/${diagnosis.patient_uid}` },
    onsetDateTime: diagnosis.onset_date || undefined,
    abatementDateTime: diagnosis.resolved_date || undefined,
    recordedDate: diagnosis.created_at,
    recorder: { reference: `Practitioner/${diagnosis.diagnosed_by}` },
    note: diagnosis.notes ? [{ text: diagnosis.notes }] : [],
  };
}

/**
 * Convert VH Health procedure note to FHIR R4 Procedure resource.
 * @param {Object} procedureNote - Internal procedure note record
 * @returns {Object} FHIR Procedure resource
 */
export function toFhirProcedure(procedureNote) {
  if (!procedureNote) return null;

  const statusMap = {
    COMPLETED: 'completed',
    IN_PROGRESS: 'in-progress',
    SCHEDULED: 'preparation',
    CANCELLED: 'not-done',
  };

  const resource = {
    resourceType: 'Procedure',
    id: String(procedureNote.id),
    status: statusMap[procedureNote.status] || 'completed',
    code: {
      text: procedureNote.procedure_name || procedureNote.title || procedureNote.content,
    },
    subject: { reference: `Patient/${procedureNote.patient_uid}` },
  };

  if (procedureNote.performed_at || procedureNote.created_at) {
    resource.performedDateTime = toFhirInstant(procedureNote.performed_at || procedureNote.created_at);
  }

  if (procedureNote.performed_by || procedureNote.author_id) {
    resource.performer = [
      {
        actor: {
          reference: `Practitioner/${procedureNote.performed_by || procedureNote.author_id}`,
        },
      },
    ];
  }

  if (procedureNote.outcome) {
    resource.outcome = { text: procedureNote.outcome };
  }

  if (procedureNote.complications) {
    resource.complication = [{ text: procedureNote.complications }];
  }

  if (procedureNote.notes || procedureNote.content) {
    resource.note = [{ text: procedureNote.notes || procedureNote.content }];
  }

  return resource;
}

/**
 * Convert VH Health investigation to FHIR R4 DiagnosticReport resource.
 * @param {Object} investigation - Internal investigation record
 * @returns {Object} FHIR DiagnosticReport resource
 */
export function toFhirDiagnosticReport(investigation) {
  if (!investigation) return null;

  const statusMap = {
    PENDING: 'registered',
    COLLECTED: 'preliminary',
    IN_PROGRESS: 'preliminary',
    COMPLETED: 'final',
    CANCELLED: 'cancelled',
  };

  const resource = {
    resourceType: 'DiagnosticReport',
    id: String(investigation.id),
    status: statusMap[investigation.status] || 'unknown',
    code: {
      text: investigation.test_name || investigation.investigation_type,
    },
    subject: { reference: `Patient/${investigation.patient_uid || investigation.uid}` },
  };

  if (investigation.ordered_at || investigation.created_at) {
    resource.effectiveDateTime = toFhirInstant(investigation.ordered_at || investigation.created_at);
  }

  if (investigation.completed_at) {
    resource.issued = toFhirInstant(investigation.completed_at);
  }

  if (investigation.results) {
    resource.result = Array.isArray(investigation.results)
      ? investigation.results.map((r, i) => ({
          reference: `Observation/${investigation.id}-${i}`,
          display: typeof r === 'string' ? r : r.name || r.test,
        }))
      : [{ display: String(investigation.results) }];
  }

  if (investigation.conclusion || investigation.interpretation) {
    resource.conclusion = investigation.conclusion || investigation.interpretation;
  }

  return resource;
}

/**
 * Convert VH Health allergy to FHIR R4 AllergyIntolerance resource.
 * @param {Object} allergy - Internal allergy record (may be string or object)
 * @returns {Object} FHIR AllergyIntolerance resource
 */
export function toFhirAllergyIntolerance(allergy) {
  if (!allergy) return null;

  // Handle both string-based and object-based allergy records
  const isString = typeof allergy === 'string';
  const allergyText = isString ? allergy : (allergy.allergen || allergy.description || allergy.name);
  const patientRef = isString ? undefined : allergy.patient_uid;
  const allergyId = isString ? undefined : String(allergy.id);

  const resource = {
    resourceType: 'AllergyIntolerance',
    id: allergyId || undefined,
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
          code: 'active',
        },
      ],
    },
    type: 'allergy',
    code: {
      text: allergyText,
    },
  };

  if (patientRef) {
    resource.patient = { reference: `Patient/${patientRef}` };
  }

  if (!isString && allergy.severity) {
    const severityMap = { mild: 'low', moderate: 'low', severe: 'high', critical: 'high' };
    resource.criticality = severityMap[allergy.severity.toLowerCase()] || 'unable-to-assess';
  }

  if (!isString && allergy.recorded_at) {
    resource.recordedDate = toFhirInstant(allergy.recorded_at);
  }

  if (!isString && allergy.reaction) {
    resource.reaction = [{ description: allergy.reaction }];
  }

  return resource;
}

/**
 * Convert VH Health admission to FHIR R4 Encounter resource.
 * @param {Object} admission - Internal admission record
 * @returns {Object} FHIR Encounter resource
 */
export function toFhirEncounter(admission) {
  if (!admission) return null;

  const statusMap = {
    ADMITTED: 'in-progress',
    DISCHARGED: 'finished',
    TRANSFERRED: 'in-progress',
    PENDING: 'planned',
    CANCELLED: 'cancelled',
  };

  const resource = {
    resourceType: 'Encounter',
    id: String(admission.id),
    status: statusMap[admission.status] || 'in-progress',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: admission.priority === 'emergent' || admission.admission_type === 'EMERGENCY' ? 'EMER' : 'IMP',
      display: admission.priority === 'emergent' || admission.admission_type === 'EMERGENCY' ? 'emergency' : 'inpatient encounter',
    },
    subject: { reference: `Patient/${admission.patient_uid}` },
  };

  if (admission.admission_type || admission.reason) {
    resource.type = [
      {
        text: admission.admission_type || admission.reason,
      },
    ];
  }

  if (admission.admitting_doctor || admission.attending_doctor) {
    resource.participant = [
      {
        individual: {
          reference: `Practitioner/${admission.admitting_doctor || admission.attending_doctor}`,
        },
      },
    ];
  }

  resource.period = {};
  if (admission.admitted_at) {
    resource.period.start = toFhirInstant(admission.admitted_at);
  }
  if (admission.discharged_at) {
    resource.period.end = toFhirInstant(admission.discharged_at);
  }

  if (admission.reason || admission.reason_for_admission) {
    resource.reasonCode = [
      {
        text: admission.reason || admission.reason_for_admission,
      },
    ];
  }

  if (admission.discharge_disposition || admission.discharge_type) {
    resource.hospitalization = {
      dischargeDisposition: {
        text: admission.discharge_disposition || admission.discharge_type,
      },
    };
  }

  return resource;
}

/**
 * Convert VH Health clinical note to FHIR R4 DocumentReference resource.
 * @param {Object} note - Internal clinical note record
 * @returns {Object} FHIR DocumentReference resource
 */
export function toFhirDocumentReference(note) {
  if (!note) return null;

  const resource = {
    resourceType: 'DocumentReference',
    id: String(note.id),
    status: 'current',
    type: {
      text: note.note_type || note.type || 'Clinical Note',
    },
    subject: { reference: `Patient/${note.patient_uid}` },
  };

  if (note.created_at) {
    resource.date = toFhirInstant(note.created_at);
  }

  if (note.author_id || note.created_by) {
    resource.author = [
      {
        reference: `Practitioner/${note.author_id || note.created_by}`,
      },
    ];
  }

  resource.content = [
    {
      attachment: {
        contentType: 'text/plain',
        data: note.content
          ? Buffer.from(note.content).toString('base64')
          : undefined,
        title: note.title || note.note_type || 'Clinical Note',
      },
    },
  ];

  return resource;
}

/**
 * Convert VH Health referral to FHIR R4 ServiceRequest resource.
 * @param {Object} referral - Internal referral record
 * @returns {Object} FHIR ServiceRequest resource
 */
export function toFhirServiceRequest(referral) {
  if (!referral) return null;

  const statusMap = {
    PENDING: 'active',
    ACCEPTED: 'active',
    IN_PROGRESS: 'active',
    COMPLETED: 'completed',
    CANCELLED: 'revoked',
    REJECTED: 'revoked',
  };

  const priorityMap = {
    ROUTINE: 'routine',
    URGENT: 'urgent',
    EMERGENT: 'asap',
    STAT: 'stat',
  };

  const resource = {
    resourceType: 'ServiceRequest',
    id: String(referral.id),
    status: statusMap[referral.status] || 'active',
    intent: 'order',
    priority: priorityMap[(referral.priority || '').toUpperCase()] || 'routine',
    subject: { reference: `Patient/${referral.patient_uid}` },
  };

  if (referral.referring_doctor || referral.requester_id) {
    resource.requester = {
      reference: `Practitioner/${referral.referring_doctor || referral.requester_id}`,
    };
  }

  if (referral.referred_to_doctor || referral.performer_id || referral.referred_to_department) {
    resource.performer = [
      {
        reference: referral.referred_to_doctor || referral.performer_id
          ? `Practitioner/${referral.referred_to_doctor || referral.performer_id}`
          : undefined,
        display: referral.referred_to_department || undefined,
      },
    ];
  }

  if (referral.reason || referral.clinical_notes) {
    resource.reasonCode = [
      {
        text: referral.reason || referral.clinical_notes,
      },
    ];
  }

  if (referral.created_at) {
    resource.authoredOn = toFhirInstant(referral.created_at);
  }

  if (referral.notes) {
    resource.note = [{ text: referral.notes }];
  }

  return resource;
}

// =============================================================================
// FROM FHIR CONVERTERS
// =============================================================================

/**
 * Convert FHIR R4 Patient resource to VH Health internal user format.
 * @param {Object} fhirPatient - FHIR Patient resource
 * @returns {Object} VH Health user object suitable for DB insert/update
 */
export function fromFhirPatient(fhirPatient) {
  if (!fhirPatient || fhirPatient.resourceType !== 'Patient') return null;

  const user = {};

  // UID from identifier
  const vhIdentifier = (fhirPatient.identifier || []).find(
    (id) => id.system === 'urn:vhhealth:uid'
  );
  if (vhIdentifier) {
    user.uid = vhIdentifier.value;
  } else if (fhirPatient.id) {
    user.uid = fhirPatient.id;
  }

  // Name — use first official name or any name
  const officialName = (fhirPatient.name || []).find((n) => n.use === 'official');
  const anyName = (fhirPatient.name || [])[0];
  const nameEntry = officialName || anyName;
  if (nameEntry) {
    if (nameEntry.text) {
      user.name = nameEntry.text;
    } else {
      // Build from given + family
      const parts = [...(nameEntry.given || []), nameEntry.family].filter(Boolean);
      user.name = parts.join(' ') || null;
    }
  }

  // Telecom
  for (const tc of fhirPatient.telecom || []) {
    if (tc.system === 'phone' && !user.phone) {
      user.phone = tc.value;
    }
    if (tc.system === 'email' && !user.email) {
      user.email = tc.value;
    }
  }

  // Gender
  user.gender = fromFhirGender(fhirPatient.gender);

  // Birth date
  if (fhirPatient.birthDate) {
    user.birthday = fhirPatient.birthDate; // Already YYYY-MM-DD
  }

  // Address
  if (fhirPatient.address && fhirPatient.address.length > 0) {
    const addr = fhirPatient.address[0];
    user.address = addr.text || [addr.line, addr.city, addr.state, addr.postalCode, addr.country]
      .flat()
      .filter(Boolean)
      .join(', ') || null;
  }

  // Active
  if (fhirPatient.active !== undefined) {
    user.is_active = fhirPatient.active;
  }

  return user;
}

export default {
  toFhirPatient,
  toFhirAppointment,
  toFhirObservation,
  toFhirMedicationRequest,
  toFhirCondition,
  toFhirProcedure,
  toFhirDiagnosticReport,
  toFhirAllergyIntolerance,
  toFhirEncounter,
  toFhirDocumentReference,
  toFhirServiceRequest,
  fromFhirPatient,
};
