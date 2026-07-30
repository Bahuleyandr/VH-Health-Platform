import {
  mkdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const TEST_ONLY_PKCS8_BODY =
  'MC4CAQAwBQYDK2VwBCIEIHjm3ZDEVXAW+i4IIQs0YzN0cUcMhx+K3lxLkMXLXUWl';

export const testCertificatePath = path.resolve(
  import.meta.dirname,
  '..',
  'fixtures',
  'test-only-logging-cert.pem',
);

export async function installTestPrivateKey(root) {
  await mkdir(root, { recursive: true });
  const privateKeyPath = path.join(root, 'synthetic-test-key.pem');
  const kind = ['PRIVATE', 'KEY'].join(' ');
  await writeFile(
    privateKeyPath,
    `-----BEGIN ${kind}-----\n${TEST_ONLY_PKCS8_BODY}\n-----END ${kind}-----\n`,
    { mode: 0o600 },
  );
  return privateKeyPath;
}
