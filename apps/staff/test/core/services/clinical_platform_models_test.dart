import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/models/clinical_platform_models.dart';

void main() {
  test('canonical timeline event converts to legacy map shape', () {
    final event = ClinicalTimelineEvent.fromJson({
      'id': 'evt-1',
      'canonical': true,
      'event_type': 'note.signed',
      'event_subtype': 'op_consultation',
      'event_status': 'signed',
      'source_table': 'clinical_notes',
      'source_id': '44',
      'resource_type': 'clinical_note',
      'resource_id': '44',
      'encounter_id': '11111111-1111-4111-8111-111111111111',
      'occurred_at': '2026-06-07T10:30:00.000Z',
      'title': 'OP note signed',
      'clinical_summary': 'Signed OP consultation',
      'actor_uid': '22222222-2222-4222-8222-222222222222',
      'actor_role': 'DOCTOR',
      'payload': {'note_type': 'op_consultation', 'appointment_id': 7},
      'tags': ['op'],
    });

    final legacy = event.toLegacyMap();

    expect(event.canonical, isTrue);
    expect(event.eventType, 'note.signed');
    expect(legacy['id'], '44');
    expect(legacy['canonical_id'], 'evt-1');
    expect(legacy['type'], 'op_consultation');
    expect(legacy['appointment_id'], 7);
    expect(legacy['timestamp'], '2026-06-07T10:30:00.000Z');
  });

  test('canonical patient timeline parses counts and events', () {
    final timeline = CanonicalPatientTimeline.fromJson({
      'patient_uid': '33333333-3333-4333-8333-333333333333',
      'counts': {'canonical': 1, 'legacy': 2, 'returned': 3},
      'generated_at': '2026-06-07T10:31:00.000Z',
      'events': [
        {
          'id': 'evt-2',
          'event_type': 'prescription.created',
          'timestamp': '2026-06-07T10:29:00.000Z',
        },
      ],
    });

    expect(timeline.patientUid, '33333333-3333-4333-8333-333333333333');
    expect(timeline.counts['canonical'], 1);
    expect(timeline.events.single.eventType, 'prescription.created');
  });
}
