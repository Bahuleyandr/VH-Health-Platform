// Presentation helpers shared by the readiness checklist, the lab-readiness
// panel and the outside-result sheet.
//
// All three name the same backend vocabulary — check types, item codes, item
// states — so the lookup lives here rather than being copied three times,
// where the copies could drift into calling the same state two things.
//
// Every lookup is guarded by a membership test against the vocabulary the
// models pin: `AppStrings.lookup` answers the KEY when a key is missing, so an
// unguarded lookup of a code the backend added after this build would render
// `s4.lib.cath_lab.readiness.item.troponin` on a ward screen. The guard falls
// back to a humanised code instead.
library;

import 'package:intl/intl.dart';

import '../../../l10n/app_strings.dart';
import '../models/cath_readiness_models.dart';
import 'cath_consumable_formatting.dart';

/// The eight `cath_lab_readiness_checks` check types, in the order
/// `cathLabService.READINESS_TYPES` spells them. Only used to decide whether a
/// localised label exists for a check type the payload carries.
const cathReadinessCheckTypes = <String>[
  'consent',
  'labs',
  'allergy_renal_risk',
  'anticoagulation',
  'blood_bank',
  'equipment',
  'implants_device_rep',
  'timeout',
];

String cathReadinessCheckLabel(AppStrings s, String checkType) {
  if (!cathReadinessCheckTypes.contains(checkType)) {
    return cathHumanize(checkType);
  }
  return s.lookup('s4.lib.cath_lab.readiness.check.$checkType');
}

String cathReadinessCheckStatusLabel(AppStrings s, String status) {
  if (!cathReadinessCheckStatuses.contains(status)) {
    return cathHumanize(status);
  }
  return s.lookup('s4.lib.cath_lab.readiness.check_status.$status');
}

String cathReadinessItemLabel(AppStrings s, String itemCode) {
  if (!cathReadinessItemCodes.contains(itemCode)) {
    return cathHumanize(itemCode);
  }
  return s.lookup('s4.lib.cath_lab.readiness.item.$itemCode');
}

String cathReadinessStateLabel(AppStrings s, String state) {
  if (!cathReadinessItemStates.contains(state)) {
    return cathHumanize(state);
  }
  return s.lookup('s4.lib.cath_lab.readiness.state.$state');
}

String cathReadinessSerologyLabel(AppStrings s, String value) {
  switch (value) {
    case 'Reactive':
      return s.lookup('s4.lib.cath_lab.readiness.serology.reactive');
    case 'Non-reactive':
      return s.lookup('s4.lib.cath_lab.readiness.serology.non_reactive');
    case 'Indeterminate':
      return s.lookup('s4.lib.cath_lab.readiness.serology.indeterminate');
    default:
      return value;
  }
}

/// A clinical date, always `yyyy-MM-dd` — the same unambiguous form the
/// consumables surfaces use, so a report date can never read as day/month in
/// one place and month/day in another.
String cathReadinessDate(DateTime value) =>
    DateFormat('yyyy-MM-dd').format(value);

/// The item's value with its unit, or an empty string when nothing is on
/// record. A serology token carries no unit.
String cathReadinessValueLine(CathLabReadinessItem item) {
  final value = item.valueText.isNotEmpty
      ? item.valueText
      : (item.valueNumeric == null
            ? ''
            : cathFormatQuantity(item.valueNumeric!));
  if (value.isEmpty) return '';
  return item.unit.isEmpty ? value : '$value ${item.unit}';
}
