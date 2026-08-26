import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PATIENT_NOTIFICATION_TYPE_CONTRACTS,
} from '../apps/backend/src/config/patientNotificationTypeRegistry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const generatedPatientNotificationContractPath = resolve(
  repoRoot,
  'apps/patient/lib/core/config/patient_notification_contract.g.dart',
);

function dartString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function dartLiteral(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return dartString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`Unsupported Dart literal in patient notification contract: ${typeof value}`);
}

function renderStringList(values) {
  return `<String>[${values.map(dartString).join(', ')}]`;
}

function renderStringMap(values) {
  const rows = Object.entries(values)
    .map(([key, value]) => `${dartString(key)}: ${dartString(value)}`);
  return `<String, String>{${rows.join(', ')}}`;
}

function renderExtraMap(values) {
  const rows = Object.entries(values)
    .map(([key, value]) => `${dartString(key)}: ${dartLiteral(value)}`);
  return `<String, Object?>{${rows.join(', ')}}`;
}

function actionName(action) {
  if (action === 'navigate') return 'PatientNotificationActionKind.navigate';
  if (action === 'acknowledge_only') {
    return 'PatientNotificationActionKind.acknowledgeOnly';
  }
  throw new Error(`Unsupported patient notification action: ${action}`);
}

function renderContract(value) {
  return `  ${dartString(value.type)}: PatientNotificationContract(\n`
    + `    type: ${dartString(value.type)},\n`
    + `    feedType: ${dartString(value.feedType)},\n`
    + `    writer: ${dartString(value.writer)},\n`
    + `    persistence: ${dartString(value.persistence)},\n`
    + `    targetUri: ${dartString(value.targetUri)},\n`
    + `    stableHydrationIds: ${renderStringList(value.stableHydrationIds)},\n`
    + `    hydrationValidators: ${renderStringMap(value.hydrationValidators)},\n`
    + `    authPolicy: ${dartString(value.authPolicy)},\n`
    + `    biometricPolicy: ${dartString(value.biometricPolicy)},\n`
    + `    priority: ${dartString(value.priority)},\n`
    + `    deliveryReceipt: ${dartString(value.deliveryReceipt)},\n`
    + `    acknowledgement: ${dartString(value.acknowledgement)},\n`
    + `    expiry: ${dartString(value.expiry)},\n`
    + `    fallbackUri: ${dartString(value.fallbackUri)},\n`
    + `    owner: ${dartString(value.owner)},\n`
    + `    action: ${actionName(value.action)},\n`
    + `    extra: ${renderExtraMap(value.extra)},\n`
    + `    preferenceKey: ${dartLiteral(value.preferenceKey)},\n`
    + `    inboxSupported: ${value.inboxSupported},\n`
    + `    lifecycle: ${dartString(value.lifecycle)},\n`
    + `  ),`;
}

export function renderPatientNotificationContractDart() {
  const sourceBytes = JSON.stringify(PATIENT_NOTIFICATION_TYPE_CONTRACTS);
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const rows = PATIENT_NOTIFICATION_TYPE_CONTRACTS.map(renderContract).join('\n');

  return `// GENERATED CODE - DO NOT EDIT.\n`
    + `// Source: apps/backend/src/config/patientNotificationTypeRegistry.js\n`
    + `// Regenerate: node scripts/generate-patient-notification-contract.mjs\n\n`
    + `// dart format off\n\n`
    + `enum PatientNotificationActionKind { navigate, acknowledgeOnly }\n\n`
    + `class PatientNotificationContract {\n`
    + `  const PatientNotificationContract({\n`
    + `    required this.type,\n`
    + `    required this.feedType,\n`
    + `    required this.writer,\n`
    + `    required this.persistence,\n`
    + `    required this.targetUri,\n`
    + `    required this.stableHydrationIds,\n`
    + `    required this.hydrationValidators,\n`
    + `    required this.authPolicy,\n`
    + `    required this.biometricPolicy,\n`
    + `    required this.priority,\n`
    + `    required this.deliveryReceipt,\n`
    + `    required this.acknowledgement,\n`
    + `    required this.expiry,\n`
    + `    required this.fallbackUri,\n`
    + `    required this.owner,\n`
    + `    required this.action,\n`
    + `    required this.extra,\n`
    + `    required this.preferenceKey,\n`
    + `    required this.inboxSupported,\n`
    + `    required this.lifecycle,\n`
    + `  });\n\n`
    + `  final String type;\n`
    + `  final String feedType;\n`
    + `  final String writer;\n`
    + `  final String persistence;\n`
    + `  final String targetUri;\n`
    + `  final List<String> stableHydrationIds;\n`
    + `  final Map<String, String> hydrationValidators;\n`
    + `  final String authPolicy;\n`
    + `  final String biometricPolicy;\n`
    + `  final String priority;\n`
    + `  final String deliveryReceipt;\n`
    + `  final String acknowledgement;\n`
    + `  final String expiry;\n`
    + `  final String fallbackUri;\n`
    + `  final String owner;\n`
    + `  final PatientNotificationActionKind action;\n`
    + `  final Map<String, Object?> extra;\n`
    + `  final String? preferenceKey;\n`
    + `  final bool inboxSupported;\n`
    + `  final String lifecycle;\n\n`
    + `  String resolveRoute(Map<String, dynamic> data) {\n`
    + `    var route = targetUri;\n`
    + `    for (final id in stableHydrationIds) {\n`
    + `      final value = data[id]?.toString().trim() ?? '';\n`
    + `      if (value.isEmpty) return fallbackUri;\n`
    + `      if (hydrationValidators[id] == 'positive_integer' &&\n`
    + `          !RegExp(r'^[1-9][0-9]*$').hasMatch(value)) {\n`
    + `        return fallbackUri;\n`
    + `      }\n`
    + `      route = route.replaceAll(':$id', Uri.encodeComponent(value));\n`
    + `    }\n`
    + `    return route;\n`
    + `  }\n`
    + `}\n\n`
    + `const String patientNotificationContractSourceSha256 = ${dartString(sourceSha256)};\n\n`
    + `const Map<String, PatientNotificationContract> patientNotificationContracts = {\n`
    + `${rows}\n`
    + `};\n\n`
    + `PatientNotificationContract? patientNotificationContractFor(Object? rawType) {\n`
    + `  final type = rawType?.toString().trim().toLowerCase() ?? '';\n`
    + `  return patientNotificationContracts[type];\n`
    + `}\n\n`
    + `// dart format on\n`;
}

const expected = renderPatientNotificationContractDart();
if (process.argv.includes('--check')) {
  if (!existsSync(generatedPatientNotificationContractPath)) {
    console.error(
      `Patient notification contract is missing: ${generatedPatientNotificationContractPath}`,
    );
    process.exit(1);
  }
  const actual = readFileSync(generatedPatientNotificationContractPath, 'utf8');
  if (actual !== expected) {
    console.error(
      'Patient notification contract drifted from the backend registry. '
        + 'Run: node scripts/generate-patient-notification-contract.mjs',
    );
    process.exit(1);
  }
  console.log('Patient notification contract matches the backend registry.');
} else {
  writeFileSync(generatedPatientNotificationContractPath, expected, 'utf8');
  console.log(`Generated ${generatedPatientNotificationContractPath}`);
}
