import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/clinical_inbox_api_service.dart';

ClinicalInboxTask _task({
  String status = 'open',
  String deepLink =
      '/pharmacy/cath-inventory-reconciliation?case_id=7'
      '&consumable_usage_id=73',
}) {
  return ClinicalInboxTask.fromJson({
    'id': '91',
    'task_kind': 'review',
    'title': 'Cath inventory shortfall',
    'description': 'Reconcile the documented usage',
    'patient_uid': '11111111-1111-4111-8111-111111111111',
    'priority': 'high',
    'status': status,
    'related_resource_type': 'cath_case_consumable_usage',
    'related_resource_id': '73',
    'assigned_to_role': 'PHARMACIST',
    'sla_completion_semantics': 'domain_evidence',
    'metadata': {
      'task_contract': 'cath_inventory_shortfall_v1',
      'cath_case_id': '7',
      'cath_consumable_usage_id': '73',
      'inventory_item_id': '83',
      'movement_kind': 'issue',
      'deep_link': deepLink,
    },
  });
}

void main() {
  test('exact Cath inventory task opens its protected domain workflow', () {
    final task = _task();

    expect(task.isCathInventoryShortfall, isTrue);
    expect(task.needsRoutedDomainEvidence, isTrue);
    expect(
      task.domainEvidenceRoute,
      '/pharmacy/cath-inventory-reconciliation?case_id=7'
      '&consumable_usage_id=73',
    );
  });

  test('closed or misrouted Cath tasks do not expose an action', () {
    expect(_task(status: 'completed').isCathInventoryShortfall, isFalse);
    expect(
      _task(deepLink: '/cath-lab?case_id=7&consumable_usage_id=73')
          .isCathInventoryShortfall,
      isFalse,
    );
    expect(
      _task(deepLink: '/cath-lab?case_id=7&consumable_usage_id=73')
          .needsRoutedDomainEvidence,
      isFalse,
    );
  });
}
