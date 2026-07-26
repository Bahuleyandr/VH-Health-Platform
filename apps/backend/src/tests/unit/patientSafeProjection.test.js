import {
  serializePatientPendingResult,
  serializePatientPendingResults,
  serializePatientNextStep,
  serializePatientNextSteps,
} from '../../services/portal/patientSafeProjection.js';

describe('patient-safe portal projection', () => {
  test('next steps ignore authored identity/contact and expose only the patient allowlist', () => {
    const projected = serializePatientNextStep({
      label: 'Book your follow-up visit',
      explanation: 'Choose a suitable appointment with the clinic.',
      due_date: '2026-08-04',
      status: 'SCHEDULED',
      patient_action: 'Open appointments to review the booking.',
      responsible_clinician_display_name: 'Injected clinician',
      responsible_clinician_role: 'Internal role',
      safe_contact: 'Internal staff phone: +91 90000 00000',
      route_token: 'appointments',
      raw_task_label: 'D3 BLOCKER: transfer not accepted',
      blocker_text: 'Internal discharge blocker',
      handoff_evidence: { id: 'secret' },
      staff_comments: 'Do not show this',
      ward_note: 'Bed 4B',
      preliminary_result: 'Unverified value',
      unknown_injected_field: 'must be ignored',
    });

    expect(projected).toEqual({
      label: 'Book your follow-up visit',
      explanation: 'Choose a suitable appointment with the clinic.',
      due_date: '2026-08-04',
      status: 'scheduled',
      patient_action: 'Open appointments to review the booking.',
      responsible_clinician_display_name: null,
      responsible_clinician_role: null,
      safe_contact: null,
      route_token: 'appointments',
    });
  });

  test('next steps reject untyped entries and neutralize invalid optional fields', () => {
    expect(serializePatientNextSteps([
      'raw task label',
      null,
      {
        label: 'Review your care instructions',
        due_date: '2026-02-31',
        status: 'internal_blocked',
        route_token: '/admin/tasks/42',
      },
      { explanation: 'Missing its safe label' },
    ])).toEqual([{
      label: 'Review your care instructions',
      explanation: null,
      due_date: null,
      status: null,
      patient_action: null,
      responsible_clinician_display_name: null,
      responsible_clinician_role: null,
      safe_contact: null,
      route_token: null,
    }]);
  });

  test('next steps ignore accessor-backed injected fields', () => {
    const candidate = Object.create(null);
    Object.defineProperty(candidate, 'label', {
      enumerable: true,
      get() {
        throw new Error('accessor must never run');
      },
    });

    expect(serializePatientNextStep(candidate)).toBeNull();
  });

  test('pending results expose signed-summary-safe fields without result content', () => {
    const projected = serializePatientPendingResult({
      discharge_summary_id: 42,
      summary_included_at: '2026-07-23T10:00:00.000Z',
      summary_inclusion_timeline_event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      summary_status: 'signed',
      patient_safe_label: 'Blood culture report',
      handoff_state: 'result_available',
      resolved_clinician_display_name: 'Dr Rao',
      resolved_clinician_role: 'DOCTOR',
      responsible_clinician_display_name: 'Injected clinician',
      responsible_clinician_role: 'Internal role',
      safe_contact: 'Internal staff phone: +91 90000 00000',
      result_status: 'preliminary',
      result_value: 'Internal unverified result',
      source_type: 'investigation',
      source_id: '991',
      named_physician_uid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      linked_task_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      staff_comments: 'Internal comment',
      blocker_text: 'Internal blocker',
    }, { summaryId: 42 });

    expect(projected).toEqual({
      label: 'Blood culture report',
      status: 'ready',
      responsible_clinician_display_name: 'Dr Rao',
      responsible_clinician_role: 'Doctor',
    });
  });

  test('pending results require matching signed or delivered inclusion evidence', () => {
    const base = {
      discharge_summary_id: 42,
      summary_included_at: '2026-07-23T10:00:00.000Z',
      summary_inclusion_timeline_event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      summary_status: 'signed',
      patient_safe_label: 'Pathology report',
      handoff_state: 'pending',
      resolved_clinician_role: 'DOCTOR',
    };

    expect(serializePatientPendingResults([
      base,
      { ...base, discharge_summary_id: 43 },
      { ...base, summary_status: 'draft' },
      { ...base, summary_included_at: null },
      { ...base, summary_inclusion_timeline_event_id: null },
      { ...base, handoff_state: 'superseded' },
      { ...base, patient_safe_label: '' },
    ], { summaryId: 42 })).toEqual([{
      label: 'Pathology report',
      status: 'pending',
      responsible_clinician_display_name: null,
      responsible_clinician_role: 'Doctor',
    }]);
  });
});
