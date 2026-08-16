// TTL pins for the scan-gated signed-URL issuers (871-F6).
//
// Servability (isScanStatusServable / assertBrandAssetMetadata) is evaluated
// when the URL is ISSUED, never when it is redeemed — so the signed-URL TTL is
// exactly the window in which an already-issued URL keeps serving bytes after
// a row is quarantined or FILE_SCAN_POLICY flips. These pins hold every issuer
// on a scan-gated path to a 5-minute bound; the uploadController pin lives in
// uploadController.test.js (runtime assertion on the getSignedFileUrl call).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('scan-gated signed-URL TTLs are bounded (871-F6)', () => {
  it('brand kit assets: 300s', () => {
    const src = read('../../services/tenant/brandKitService.js');
    expect(src).toContain('const SIGNED_URL_TTL_SECONDS = 300;');
    expect(src).not.toMatch(/SIGNED_URL_TTL_SECONDS = 3600/);
  });

  it('generic upload by-key downloads: 300s', () => {
    const src = read('../../controllers/upload/uploadController.js');
    expect(src).toContain('const SIGNED_URL_TTL_SECONDS = 300;');
  });

  it('investigation booking slip/result photos: 300s via the gated helper', () => {
    const src = read('../../controllers/investigation/bookingController.js');
    expect(src).toContain('const FILE_URL_TTL_SECONDS = 300;');
    // and the helper is the only issuer (pinned in fileScanIngestCoverage too)
    expect(src.match(/getSignedFileUrl\(/g)).toHaveLength(1);
  });
});
