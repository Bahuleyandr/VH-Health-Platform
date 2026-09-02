import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  evaluateDeadCodeRetirements,
  loadDeadCodeRetirementManifest,
} from './check-dead-code-retirements.mjs';

const historicalForty = [
  'apps/admin/public/sw.js',
  'apps/admin/public/sw.js.map',
  'apps/admin/public/workbox-f1770938.js',
  'apps/admin/public/workbox-f1770938.js.map',
  'apps/admin/src/app/(with-auth)/dashboard/appointments/components/AppointmentsTable.tsx',
  'apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/AIExpansionPanels.tsx',
  'apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/deferredModulePanels/index.ts',
  'apps/admin/src/app/(with-auth)/dashboard/components/types.ts',
  'apps/admin/src/app/(with-auth)/dashboard/components/utils.ts',
  'apps/admin/src/app/(with-auth)/dashboard/formatTimeAgo.ts',
  'apps/admin/src/app/(with-auth)/dashboard/notifications/components/SendAnnouncementForm.tsx',
  'apps/admin/src/app/(with-auth)/dashboard/system-logs/components/ExportLogsButton.tsx',
  'apps/admin/src/app/(with-auth)/dashboard/system-logs/components/LogSearchBar.tsx',
  'apps/admin/src/app/(with-auth)/theme.css',
  'apps/admin/src/components/PaginationControls.tsx',
  'apps/admin/src/components/ServiceWorkerCleanup.tsx',
  'apps/admin/src/components/table/TableControls.tsx',
  'apps/admin/src/hooks/useAuth.ts',
  'apps/admin/src/hooks/useDebounce.ts',
  'apps/admin/src/lib/api-response.types.ts',
  'apps/admin/src/scripts/clean.js',
  'apps/admin/src/scripts/config.ts',
  'apps/admin/src/scripts/test-auth.ts',
  'apps/admin/src/scripts/test-cors.ts',
  'apps/admin/src/types/lucide-react.d.ts',
  'apps/backend/src/schedulers/appointmentReminderScheduler.js',
  'apps/patient/lib/core/offline/record_cache_manifest.dart',
  'apps/patient/lib/core/services/shared_prefs_service.dart',
  'apps/patient/lib/core/services/websocket_service.dart',
  'apps/patient/lib/features/appointments/widgets/wait_time_widget.dart',
  'apps/patient/lib/features/bootstrap/permission_gate.dart',
  'apps/patient/lib/features/steps/widgets/step_share_card.dart',
  'apps/patient/lib/features/your_health/widgets/consultations_tab.dart',
  'apps/patient/test/core/services/websocket_service_test.dart',
  'apps/staff/lib/core/config/security_config.dart',
  'apps/staff/lib/core/services/api_retry.dart',
  'apps/staff/lib/core/services/certificate_pinner.dart',
  'apps/staff/lib/core/services/staff_api_service.dart',
  'apps/staff/lib/core/widgets/data_state_builder.dart',
  'infra/kubernetes/apps/admin/service-monitor.yaml',
];

function cloneManifest() {
  return structuredClone(loadDeadCodeRetirementManifest());
}

function writeFixture(root, path, contents = '// retirement fixture\n') {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'vh-dead-code-retirement-'));
  try {
    const manifest = cloneManifest();
    for (const entry of manifest.forbiddenFragments) {
      writeFixture(root, entry.path);
    }
    run({ root, manifest });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test('the manifest pins the exact historical 40-file delete proof', () => {
  const manifest = cloneManifest();
  assert.equal(
    manifest.evidence.auditedSource,
    '8a692269f71b0666182fa82a5b7582119b9e2539',
  );
  assert.equal(
    manifest.evidence.reconciledHead,
    'b3807dccbc9281e94182041dd440542e6e77f14d',
  );
  assert.equal(manifest.expectedAbsentPathCount, 40);
  assert.deepEqual(
    manifest.absentPaths.map((entry) => entry.path).sort(),
    [...historicalForty].sort(),
  );
  assert.deepEqual(
    manifest.requiredFindingIds,
    Array.from(
      { length: 11 },
      (_, index) => `DEAD-${String(index + 1).padStart(3, '0')}`,
    ),
  );
});

test('the exact current tree satisfies every retirement rule', () => {
  assert.deepEqual(evaluateDeadCodeRetirements(cloneManifest()), []);
});

test('restoring any retired file is detected', () => {
  withFixture(({ root, manifest }) => {
    const restored = manifest.absentPaths.find((entry) =>
      entry.id.includes('consultations-tab'),
    );
    assert.ok(restored, 'the mutation anchor must exist');
    writeFixture(root, restored.path, 'e\n');

    const violations = evaluateDeadCodeRetirements(manifest, { rootDir: root });
    assert.ok(
      violations.some((violation) =>
        violation.includes(`${restored.id}: retired path exists`),
      ),
      violations.join('\n'),
    );
  });
});

test('restoring a published 501 route fragment is detected', () => {
  withFixture(({ root, manifest }) => {
    const routeRule = manifest.forbiddenFragments.find((entry) =>
      entry.findingIds.includes('DEAD-007'),
    );
    assert.ok(routeRule, 'the DEAD-007 mutation anchor must exist');
    writeFixture(
      root,
      routeRule.path,
      "router.get('/admin/users', notImplemented);\n",
    );

    const violations = evaluateDeadCodeRetirements(manifest, { rootDir: root });
    assert.ok(
      violations.some((violation) =>
        violation.includes(`${routeRule.id}: retired fragment restored`),
      ),
      violations.join('\n'),
    );
  });
});

test('restoring an orphan auth symbol is detected', () => {
  withFixture(({ root, manifest }) => {
    const symbolRule = manifest.forbiddenFragments.find((entry) =>
      entry.findingIds.includes('DEAD-008'),
    );
    assert.ok(symbolRule, 'the DEAD-008 mutation anchor must exist');
    writeFixture(
      root,
      symbolRule.path,
      'export const verifyDevice = async () => true;\n',
    );

    const violations = evaluateDeadCodeRetirements(manifest, { rootDir: root });
    assert.ok(
      violations.some((violation) =>
        violation.includes(`${symbolRule.id}: retired fragment restored`),
      ),
      violations.join('\n'),
    );
  });
});

test('shrinking the historical manifest without changing the census fails closed', () => {
  withFixture(({ root, manifest }) => {
    manifest.absentPaths.pop();
    const violations = evaluateDeadCodeRetirements(manifest, { rootDir: root });
    assert.ok(
      violations.some(
        (violation) =>
          violation === 'retired-file census changed: expected 40, got 39',
      ),
      violations.join('\n'),
    );
  });
});

test('duplicate retirement entry ids fail closed', () => {
  withFixture(({ root, manifest }) => {
    manifest.absentPaths[1].id = manifest.absentPaths[0].id;
    const violations = evaluateDeadCodeRetirements(manifest, { rootDir: root });
    assert.ok(
      violations.some((violation) =>
        violation.startsWith('duplicate retirement entry id:'),
      ),
      violations.join('\n'),
    );
  });
});

test('the mutation suite and live gate run in the unconditional security stage', () => {
  const security = readFileSync(
    new URL('./security.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    security,
    /run\(process\.execPath,\s*\[\s*["']--test["'],\s*["']scripts\/ci\/check-dead-code-retirements\.test\.mjs["'],?\s*\]\s*\)/s,
  );
  assert.match(
    security,
    /run\(process\.execPath,\s*\[\s*["']scripts\/ci\/check-dead-code-retirements\.mjs["'],?\s*\]\s*\)/s,
  );
});
