import { readFileSync } from 'node:fs';

const routes = readFileSync(
  new URL('../../routes/documents/documentRoutes.js', import.meta.url),
  'utf8',
);
const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const migration760 = readFileSync(
  new URL('../../migrations/760_clinical_import_authority_custody_and_reconciliation.sql', import.meta.url),
  'utf8',
);

describe('clinical import exact-body route contract', () => {
  test('keeps the global JSON parser away from normalized clinical import paths', () => {
    expect(app).toContain(
      String.raw`const path = String(req.originalUrl || req.url || '').split('?', 1)[0].replace(/\/+$/, '');`,
    );
    expect(app).toMatch(
      /if \(path === '\/api\/v1\/documents\/import\/fhir-bundle'\s*\|\| path === '\/api\/v1\/documents\/import\/ccd'\) \{\s*return next\(\);\s*\}/,
    );
    expect(app).not.toContain('req.clinicalImportRawBody');
  });

  test('installs authenticated, rate-limited route-local parsers with one exact-byte hook', () => {
    expect(app).toContain(
      "app.use('/api/v1/documents', requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES), phiAccessLogger('CLINICAL_DOCUMENT'), documentRoutes);",
    );
    expect(routes).toContain("const clinicalImportRateLimiter = getRateLimiter('clinicalImport');");
    expect(routes).toMatch(
      /const captureClinicalImportRawBody = \(req, _res, body\) => \{\s*req\.clinicalImportRawBody = Buffer\.from\(body\);\s*\};/,
    );
    expect(routes).toMatch(
      /const parseClinicalImportJson = express\.json\(\{\s*type: \['application\/json', 'application\/fhir\+json'\],\s*limit: '5mb',\s*inflate: false,\s*verify: captureClinicalImportRawBody,\s*\}\);/,
    );
    expect(routes).toMatch(
      /const parseClinicalImportXml = express\.text\(\{\s*type: \['application\/xml', 'text\/xml', 'application\/hl7-v3\+xml'\],\s*limit: '5mb',\s*inflate: false,\s*verify: captureClinicalImportRawBody,\s*\}\);/,
    );
    expect(routes).toMatch(
      /router\.post\(\s*'\/import\/fhir-bundle',\s*clinicalImportRateLimiter,\s*requireFhirImportMediaType,\s*parseClinicalImportJson,\s*wrapAsync\(/,
    );
    expect(routes).toMatch(
      /router\.post\(\s*'\/import\/ccd',\s*clinicalImportRateLimiter,\s*requireCcdaImportMediaType,\s*parseClinicalImportJson,\s*parseClinicalImportXml,\s*wrapAsync\(/,
    );
    expect(routes).not.toContain('requires text middleware upstream');
  });

  test('keeps both uninflated route parsers at migration 760 raw-artifact byte parity', () => {
    expect(routes.match(/limit: '5mb'/g)).toHaveLength(2);
    expect(routes.match(/inflate: false/g)).toHaveLength(2);
    expect(migration760).toContain('raw_payload_bytes BETWEEN 1 AND 5242880');
  });

  test('fails fast on unsupported media types and accepts only governed import MIME types', () => {
    expect(routes).toContain("type: ['application/json', 'application/fhir+json']");
    expect(routes).not.toContain('application/*+json');
    expect(routes).toContain(
      "type: ['application/xml', 'text/xml', 'application/hl7-v3+xml']",
    );
    expect(routes).toMatch(
      /function requireClinicalImportMediaType\(\.\.\.allowedTypes\) \{[\s\S]*?if \(!allowed\.has\(mediaType\)\) \{\s*return next\(new AppError\(\s*'Clinical import Content-Type is not supported',\s*415,\s*'IMPORT_CONTENT_TYPE_UNSUPPORTED',\s*\)\);/,
    );
    expect(routes).toMatch(
      /const requireFhirImportMediaType = requireClinicalImportMediaType\(\s*'application\/json',\s*'application\/fhir\+json',\s*\);/,
    );
    expect(routes).toMatch(
      /const requireCcdaImportMediaType = requireClinicalImportMediaType\(\s*'application\/json',\s*'application\/xml',\s*'text\/xml',\s*'application\/hl7-v3\+xml',\s*\);/,
    );
    expect(routes).toMatch(
      /if \(req\.is\('application\/xml'\)\s*\|\| req\.is\('text\/xml'\)\s*\|\| req\.is\('application\/hl7-v3\+xml'\)\) \{\s*xmlString = typeof req\.body === 'string' \? req\.body : null;\s*\} else \{\s*xmlString = req\.body\?\.xml;\s*\}/,
    );
    expect(routes).toContain(
      'Request must contain C-CDA XML in body.xml or as raw XML',
    );
    expect(routes).toContain('rawDocument: Buffer.from(req.clinicalImportRawBody)');
  });
});
