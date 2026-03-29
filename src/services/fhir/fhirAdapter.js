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
  fromFhirPatient,
};
