import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(repoRoot, 'infra', 'kubernetes', 'apps', 'backend');

function readBackendFile(name) {
  return normalizeLineEndings(fs.readFileSync(path.join(backendDir, name), 'utf8'));
}

function normalizeLineEndings(content) {
  return content.replace(/\r\n/g, '\n');
}

const uploadScript = readBackendFile('upload-archive.sh');
const verifyScript = readBackendFile('verify-upload-archive.sh');
const uploadCronJob = readBackendFile('backup-cronjob.yaml');
const verifyCronJob = readBackendFile('backup-verification-cronjob.yaml');
const backupPolicy = readBackendFile('backup-network-policy.yaml');
const backendKustomization = readBackendFile('kustomization.yaml');
const backendConfig = readBackendFile('configmap.yaml');
const backendSecretExample = readBackendFile('sealed-secret.yaml.example');
const backupCryptoExample = readBackendFile(
  'backup-crypto.sealed-secret.yaml.example',
);
const uploadPhase = uploadScript.slice(
  uploadScript.indexOf('\nupload_archive() {'),
  uploadScript.indexOf('\ncase "${1:-}"'),
);
const sealPhase = uploadScript.slice(
  uploadScript.indexOf('\nseal_archive() {'),
  uploadScript.indexOf('\nupload_archive() {'),
);
const verifyPhase = verifyScript.slice(
  verifyScript.indexOf('\nverify_archive() {'),
  verifyScript.indexOf('\ncase "${1:-}"'),
);

function between(document, start, end) {
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return document.slice(startIndex, endIndex);
}

const producerFetchContainer = between(
  uploadCronJob,
  '            - name: minio-fetch\n',
  '            - name: archive-seal\n',
);
const producerSealContainer = between(
  uploadCronJob,
  '            - name: archive-seal\n',
  '          containers:\n',
);
const producerUploadContainer = between(
  uploadCronJob,
  '            - name: r2-sync\n',
  '          volumes:\n',
);
const verifierReaderContainer = between(
  verifyCronJob,
  '            - name: archive-reader\n',
  '          containers:\n',
);
const verifierCryptoContainer = between(
  verifyCronJob,
  '            - name: backup-verification\n',
  '          volumes:\n',
);

test('archive scripts are valid in both execution shells', () => {
  for (const script of ['upload-archive.sh', 'verify-upload-archive.sh']) {
    const relativeScript = path.posix.join(
      'infra',
      'kubernetes',
      'apps',
      'backend',
      script,
    );
    for (const shell of ['bash', 'sh']) {
      const result = spawnSync(shell, ['-n', relativeScript], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(
        result.status,
        0,
        `${script} failed ${shell} -n:\n${result.stdout}\n${result.stderr}`,
      );
    }
  }
});

test('marker extraction accepts LF and CRLF content', () => {
  const lf = [
    'header',
    '            - name: minio-fetch',
    '              image: example.invalid/minio',
    '            - name: archive-seal',
    'footer',
    '',
  ].join('\n');
  const expected = [
    '            - name: minio-fetch',
    '              image: example.invalid/minio',
  ].join('\n') + '\n';

  for (const content of [lf, lf.replace(/\n/g, '\r\n')]) {
    assert.equal(
      between(
        normalizeLineEndings(content),
        '            - name: minio-fetch\n',
        '            - name: archive-seal\n',
      ),
      expected,
    );
  }
});

test('producer separates MinIO reader and R2 producer credentials', () => {
  for (const name of [
    'MINIO_ACCESS_KEY_ID',
    'MINIO_SECRET_ACCESS_KEY',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'BACKUP_ENCRYPTION_KEY',
    'BACKUP_HMAC_KEY',
  ]) {
    assert.match(uploadScript, new RegExp(`\\b${name}\\b`));
  }

  assert.match(
    uploadScript,
    /AWS_ACCESS_KEY_ID="\$\{MINIO_ACCESS_KEY_ID\}"[\s\S]*?s3 sync/,
  );
  assert.match(
    uploadScript,
    /AWS_ACCESS_KEY_ID="\$\{R2_ACCESS_KEY_ID\}"[\s\S]*?s3 cp/,
  );
  assert.match(uploadScript, /minio_aws s3api list-objects-v2/);
  assert.doesNotMatch(uploadPhase, /head-object|list-objects-v2|s3\s+ls/);
  assert.doesNotMatch(uploadScript, /CF_ACCOUNT_ID|r2\.cloudflarestorage\.com/);
});

test('producer authenticates canonical metadata and the complete encrypted archive', () => {
  assert.match(uploadScript, /sha256sum "\$\{archive_path\}"/);
  assert.match(
    uploadScript,
    /format=%s,sha256=%s,hmac_sha256=%s,created_at=%s,created_epoch=%s,source_bucket=%s,object_count=%s,encryption=%s/,
  );
  assert.match(uploadScript, /vhhealth-minio-archive-v1/);
  assert.match(uploadScript, /aes-256-cbc-pbkdf2-sha256/);
  assert.match(uploadScript, /openssl enc -aes-256-cbc[\s\S]*?-pbkdf2[\s\S]*?-iter 600000/);
  assert.match(
    sealPhase,
    /printf '%s\\n'[\s\S]*?"\$\{ARCHIVE_FORMAT\}"[\s\S]*?"\$\{archive_sha256\}"[\s\S]*?"\$\{created_at\}"[\s\S]*?"\$\{created_epoch\}"[\s\S]*?"\$\{MINIO_BUCKET\}"[\s\S]*?"\$\{source_object_count\}"[\s\S]*?"\$\{ARCHIVE_ENCRYPTION\}"[\s\S]*?"\$\{archive_bytes\}"[\s\S]*?"\$\{archive_key\}"[\s\S]*?cat "\$\{archive_path\}"[\s\S]*?openssl dgst -sha256 -hmac "\$\{BACKUP_HMAC_KEY\}" -r/,
  );
  assert.match(uploadScript, /--metadata "\$\{metadata\}"/);
  assert.match(uploadScript, /\[length\(Contents\), sum\(Contents\[\]\.Size\)\]/);
  assert.match(uploadScript, /awk '\{ count \+= \$1 \}[\s\S]*?awk '\{ bytes \+= \$2 \}/);
  assert.match(uploadScript, /inventory_projected_bytes[\s\S]*?source was not downloaded/);
  assert.match(uploadScript, /projected_work_bytes[\s\S]*?no archive was uploaded/);
  assert.doesNotMatch(uploadScript, /--exclude/);
  assert.match(
    sealPhase,
    /archive-bytes"[\s\S]*?rm -rf -- "\$\{source_dir\}"[\s\S]*?\n\}/,
  );
  assert.doesNotMatch(uploadPhase, /\$\{source_dir\}/);
});

test('reader authenticates metadata, freshness, key, and ciphertext before decryption', () => {
  assert.match(verifyScript, /list-objects-v2/);
  assert.match(verifyScript, /head-object/);
  assert.match(
    verifyScript,
    /\[Metadata\.format,Metadata\.sha256,Metadata\.hmac_sha256,Metadata\.created_at,Metadata\.created_epoch,Metadata\.source_bucket,Metadata\.object_count,Metadata\.encryption,ContentLength\]/,
  );
  assert.match(verifyScript, /"\$\{age_seconds\}" -gt "\$\{BACKUP_MAX_AGE_SECONDS\}"/);
  assert.match(verifyScript, /actual_bytes[\s\S]*?expected_bytes/);
  assert.match(verifyScript, /actual_sha256[\s\S]*?expected_sha256/);
  assert.match(
    verifyPhase,
    /printf '%s\\n'[\s\S]*?"\$\{archive_format\}"[\s\S]*?"\$\{expected_sha256\}"[\s\S]*?"\$\{created_at\}"[\s\S]*?"\$\{created_epoch\}"[\s\S]*?"\$\{source_bucket\}"[\s\S]*?"\$\{source_object_count\}"[\s\S]*?"\$\{archive_encryption\}"[\s\S]*?"\$\{expected_bytes\}"[\s\S]*?"\$\{archive_key\}"[\s\S]*?cat "\$\{archive_path\}"[\s\S]*?openssl dgst -sha256 -hmac "\$\{BACKUP_HMAC_KEY\}" -r/,
  );
  assert.match(
    verifyPhase,
    /expected_hmac_sha256[\s\S]*?\^\[0-9a-f\]\{64\}\$[\s\S]*?actual_hmac_sha256[\s\S]*?archive HMAC does not authenticate metadata and ciphertext/,
  );
  assert.ok(
    verifyPhase.indexOf('archive HMAC does not authenticate') <
      verifyPhase.indexOf('openssl enc -aes-256-cbc -d'),
    'HMAC comparison must reject tampering before decryption',
  );
  assert.match(verifyScript, /openssl enc -aes-256-cbc -d[\s\S]*?\|\s*tar -tf -/);
  assert.match(verifyScript, /ContentLength[\s\S]*?projected_work_bytes[\s\S]*?BACKUP_WORK_LIMIT_BYTES/);
  assert.doesNotMatch(verifyScript, /R2_PRODUCER|offsite-backup-producer|CF_ACCOUNT_ID/);
});

test('encryption and HMAC keys are independent and isolated to crypto phases', () => {
  for (const script of [sealPhase, verifyPhase]) {
    assert.match(script, /require_vars[\s\S]*?BACKUP_ENCRYPTION_KEY[\s\S]*?BACKUP_HMAC_KEY/);
    assert.match(
      script,
      /if \[ "\$\{BACKUP_HMAC_KEY\}" = "\$\{BACKUP_ENCRYPTION_KEY\}" \]; then[\s\S]*?must differ/,
    );
  }

  assert.match(backupCryptoExample, /BACKUP_ENCRYPTION_KEY:/);
  assert.match(backupCryptoExample, /BACKUP_HMAC_KEY:/);
  assert.match(backupCryptoExample, /two independent high-entropy values/);

  assert.match(producerSealContainer, /name: BACKUP_ENCRYPTION_KEY/);
  assert.match(producerSealContainer, /name: BACKUP_HMAC_KEY/);
  assert.match(verifierCryptoContainer, /name: BACKUP_ENCRYPTION_KEY/);
  assert.match(verifierCryptoContainer, /name: BACKUP_HMAC_KEY/);
  for (const nonCryptoContainer of [
    producerFetchContainer,
    producerUploadContainer,
    verifierReaderContainer,
  ]) {
    assert.doesNotMatch(nonCryptoContainer, /BACKUP_ENCRYPTION_KEY|BACKUP_HMAC_KEY/);
  }
});

test('CronJobs use disjoint least-privilege Secrets and no broad envFrom', () => {
  assert.match(uploadCronJob, /name: minio-backup-source-reader/);
  assert.match(uploadCronJob, /name: offsite-backup-producer/);
  assert.match(uploadCronJob, /name: backup-crypto/);
  assert.doesNotMatch(uploadCronJob, /offsite-backup-reader|vhhealth-backend-env|envFrom:/);
  assert.match(uploadCronJob, /name: MINIO_CA_BUNDLE[\s\S]*?value: \/var\/run\/vhhealth\/minio-ca\/ca\.crt/);
  assert.match(uploadCronJob, /name: kube-root-ca\.crt[\s\S]*?key: ca\.crt[\s\S]*?path: ca\.crt/);

  assert.match(verifyCronJob, /name: offsite-backup-reader/);
  assert.match(verifyCronJob, /name: backup-crypto/);
  assert.doesNotMatch(
    verifyCronJob,
    /offsite-backup-producer|minio-backup-source-reader|vhhealth-backend-env|envFrom:/,
  );
});

test('CronJobs are digest pinned, externally scripted, and verify every archive window', () => {
  const pinnedAwsCli =
    /docker\.io\/amazon\/aws-cli:2\.34\.53@sha256:cf53765c0de54ad3a8ea21818f1c4c845a8cf7ca87831c078a00fef244031493/;
  const pinnedCrypto =
    /docker\.io\/alpine\/openssl:3\.5\.7@sha256:045a40a53b8e283cff95052e0c39f256b7467d48c7445260d4f180fc0e767999/;
  assert.match(uploadCronJob, pinnedAwsCli);
  assert.match(verifyCronJob, pinnedAwsCli);
  assert.match(uploadCronJob, pinnedCrypto);
  assert.match(verifyCronJob, pinnedCrypto);
  assert.match(uploadCronJob, /\/opt\/vhhealth\/backup\/upload-archive\.sh/);
  assert.match(verifyCronJob, /\/opt\/vhhealth\/backup\/verify-upload-archive\.sh/);
  for (const phase of ['fetch', 'seal', 'upload']) {
    assert.match(uploadCronJob, new RegExp(`- ${phase}`));
  }
  for (const phase of ['fetch', 'verify']) {
    assert.match(verifyCronJob, new RegExp(`- ${phase}`));
  }
  assert.match(uploadCronJob, /schedule: "0 \*\/6 \* \* \*"/);
  assert.match(verifyCronJob, /schedule: "45 1,7,13,19 \* \* \*"/);
  assert.match(backendConfig, /BACKUP_MAX_AGE_SECONDS: "10800"/);
  assert.match(backendConfig, /BACKUP_WORK_LIMIT_BYTES: "10737418240"/);
});

test('backup jobs use explicit no-token ServiceAccounts and scoped egress', () => {
  assert.match(uploadCronJob, /serviceAccountName: vhhealth-backup-producer/);
  assert.match(verifyCronJob, /serviceAccountName: vhhealth-backup-verifier/);
  assert.match(uploadCronJob, /automountServiceAccountToken: false/);
  assert.match(verifyCronJob, /automountServiceAccountToken: false/);

  assert.match(backupPolicy, /name: vhhealth-backup-producer/);
  assert.match(backupPolicy, /name: vhhealth-backup-verifier/);
  assert.match(backupPolicy, /name: vhhealth-backup-producer-egress/);
  assert.match(backupPolicy, /name: vhhealth-backup-verifier-egress/);
  assert.match(backupPolicy, /v1\.min\.io\/tenant: vhhealth-minio/);
  assert.match(backupPolicy, /port: 9000/);
  assert.match(backupPolicy, /port: 443/);
});

test('endpoint and scripts render natively while placeholder Secrets stay excluded', () => {
  const endpoint =
    'https://dbe488236c64499a3dfc797a750c912d.r2.cloudflarestorage.com';
  assert.match(backendConfig, new RegExp(`R2_ENDPOINT: "${endpoint}"`));
  assert.match(backendConfig, /^  CF_R2_URL: ""$/m);
  assert.match(backendConfig, /CF_R2_URL is a different value:[\s\S]*?public[\s\S]*?fails closed/);
  assert.match(backendConfig, /MINIO_BACKUP_ENDPOINT: "https:\/\/minio\.vhhealth-platform\.svc\.cluster\.local:443"/);
  assert.match(backendConfig, /MINIO_BACKUP_BUCKET: "vhhealth-records"/);
  assert.match(backendKustomization, /name: vhhealth-backup-scripts/);
  assert.match(backendKustomization, /fieldPath: data\.R2_ENDPOINT/);
  assert.match(backendKustomization, /initContainers\.\[name=archive-reader\]/);
  assert.match(backendKustomization, /name: vhhealth-backend-r2-sync/);
  assert.match(backendKustomization, /name: backup-verification/);
  assert.doesNotMatch(
    backendSecretExample,
    /^\s+(?:CF_ACCOUNT_ID|CF_R2_URL|BACKUP_ENCRYPTION_KEY):/m,
  );
  assert.doesNotMatch(
    backendKustomization,
    /(?:^|\n)\s*-\s+.*sealed-secret\.yaml\.example\s*(?:\n|$)/,
  );
});
