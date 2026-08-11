import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ICU_FLOWSHEET_BOUNDS } from '../apps/backend/src/utils/clinical/icuPlausibility.js';
import { VITAL_PLAUSIBILITY_BOUNDS } from '../apps/backend/src/utils/clinical/vitalPlausibility.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const generatedVitalBoundsPath = resolve(
  repoRoot,
  'packages/vhhealth_core/lib/clinical/vital_plausibility_bounds.g.dart',
);

function dartString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function renderBoundsMap(name, bounds) {
  const rows = Object.entries(bounds).map(([field, value]) => (
    `  ${dartString(field)}: VitalPlausibilityBound(\n`
      + `    min: ${value.min},\n`
      + `    max: ${value.max},\n`
      + `    unit: ${dartString(value.unit)},\n`
      + `    integer: ${value.integer === true},\n`
      + `  ),`
  ));
  return `const Map<String, VitalPlausibilityBound> ${name} = {\n${rows.join('\n')}\n};`;
}

export function renderVitalBoundsDart() {
  const sourceBytes = JSON.stringify({
    vital: VITAL_PLAUSIBILITY_BOUNDS,
    icuFlowsheet: ICU_FLOWSHEET_BOUNDS,
  });
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');

  return `// GENERATED CODE - DO NOT EDIT.\n`
    + `// Source: apps/backend/src/utils/clinical/{vitalPlausibility,icuPlausibility}.js\n`
    + `// Regenerate: node scripts/generate-vital-bounds.mjs\n\n`
    + `// dart format off\n\n`
    + `class VitalPlausibilityBound {\n`
    + `  const VitalPlausibilityBound({\n`
    + `    required this.min,\n`
    + `    required this.max,\n`
    + `    required this.unit,\n`
    + `    required this.integer,\n`
    + `  });\n\n`
    + `  final num min;\n`
    + `  final num max;\n`
    + `  final String unit;\n`
    + `  final bool integer;\n`
    + `}\n\n`
    + `const String vitalPlausibilitySourceSha256 = '${sourceSha256}';\n\n`
    + `${renderBoundsMap('vitalPlausibilityBounds', VITAL_PLAUSIBILITY_BOUNDS)}\n\n`
    + `${renderBoundsMap('icuFlowsheetPlausibilityBounds', ICU_FLOWSHEET_BOUNDS)}\n\n`
    + `// dart format on\n`;
}

const expected = renderVitalBoundsDart();
if (process.argv.includes('--check')) {
  if (!existsSync(generatedVitalBoundsPath)) {
    console.error(`Vital bounds contract is missing: ${generatedVitalBoundsPath}`);
    process.exit(1);
  }
  const actual = readFileSync(generatedVitalBoundsPath, 'utf8');
  if (actual !== expected) {
    console.error(
      'Vital bounds contract drifted from the backend source. '
        + 'Run: node scripts/generate-vital-bounds.mjs',
    );
    process.exit(1);
  }
  console.log('Vital bounds contract matches the backend source bytes.');
} else {
  writeFileSync(generatedVitalBoundsPath, expected, 'utf8');
  console.log(`Generated ${generatedVitalBoundsPath}`);
}
