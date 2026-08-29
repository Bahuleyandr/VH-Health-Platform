import { readFileSync } from 'node:fs';

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('clinical import and signed prescription authority source contract', () => {
  const prescription = source('controllers/prescription/ePrescriptionController.js');
  const importService = source('services/import/patientDataImport.js');
  const routes = source('routes/documents/documentRoutes.js');
  const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

  test('signed prescriptions pin catalog identity and pediatric dose evidence', () => {
    expect(prescription).toMatch(/SIGNED_CLINICAL_AUTHORITY_CONTRACT_VERSION/);
    expect(prescription).toMatch(/signed_catalog_authority/);
    expect(prescription).toMatch(/signed_pediatric_dose_authority/);
    expect(prescription).toMatch(/PRESCRIPTION_SIGNED_CATALOG_AUTHORITY_CHANGED/);
    expect(prescription).toMatch(/PRESCRIPTION_SIGNED_PEDIATRIC_AUTHORITY_CHANGED/);
    expect(prescription).toMatch(/FROM vitals_chart[\s\S]*id=\$3::int[\s\S]*FOR UPDATE/);
    expect(prescription).toMatch(/lockTenantPatientMergeStability[\s\S]*lockPharmacyCatalogAuthorityTx/);
  });

  test('imported history is immutable and delivery type is an explicit enum', () => {
    expect(prescription).toMatch(/VALID_PHARMACY_DELIVERY_TYPES = new Set\(\['delivery', 'counter'\]\)/);
    expect(prescription).toMatch(/PRESCRIPTION_PHARMACY_DELIVERY_TYPE_INVALID/);
    expect(prescription).toMatch(/Imported medication history is immutable/);
    expect(prescription).toMatch(/Imported medication history cannot be signed/);
    expect(prescription).toMatch(/lifecycle_status, 'draft'\)\) <> 'imported_history'/);
    expect(prescription).toMatch(/PRESCRIPTION_IMPORTED_HISTORY_NOT_ORDERABLE/);
  });

  test('manual import requires exact patient, source manifest, payload hash, and PHI policy', () => {
    for (const header of [
      'X-VH-Import-Patient-Uid',
      'X-VH-Import-Source-System',
      'X-VH-Import-Source-Document-Id',
      'X-VH-Import-Source-Facility-Id',
      'X-VH-Import-Source-Signature-Sha256',
      'X-VH-Import-Payload-Sha256',
      'Idempotency-Key',
    ]) expect(routes).toContain(header);
    expect(routes).toMatch(/actorRole !== 'MEDICAL_RECORDS'/);
    expect(routes).toMatch(/IMPORT_PARTNER_AUTHORITY_NOT_CONFIGURED/);
    expect(routes).toMatch(/ACCESS_POLICY_CODES\.PATIENT_RECORD_UPLOAD/);
    expect(routes).toMatch(/patientId: authority\.patientUid/);
    expect(routes).toMatch(/userRole: authority\.actorRole/);
    expect(routes).toMatch(/tenantId,/);
    expect(routes).toMatch(/importFhirBundle\(bundle, importedBy, \{ tenantId, authority \}\)/);
    expect(routes).toMatch(/importCCDA\(xmlString, importedBy, \{ tenantId, authority \}\)/);
  });

  test('FHIR references are single-patient and medication replay includes dosage', () => {
    expect(importService).toMatch(/normalizeFhirBundlePatientReferences/);
    expect(importService).toMatch(/IMPORT_RESOURCE_PATIENT_MISMATCH/);
    expect(importService).toMatch(/lockTenantPatientMergeStability\(lockTx, tid\)/);
    expect(importService).toMatch(/dosageInstruction: fhirMedication\.dosageInstruction \|\| \[\]/);
    expect(importService).toMatch(/IMPORT_SOURCE_IDENTITY_DRIFT/);
    expect(importService).toMatch(/lifecycle_status, prescription_number[\s\S]*'imported_history'/);
    expect(importService).toMatch(/IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED/);
  });

  test('C-CDA parsing is structured, namespace tolerant, and entity safe', () => {
    expect(packageJson.dependencies['fast-xml-parser']).toBe('5.10.1');
    expect(importService).toMatch(/new XMLParser\(/);
    expect(importService).toMatch(/removeNSPrefix: true/);
    expect(importService).toMatch(/XMLValidator\.validate/);
    expect(importService).toContain('/<!DOCTYPE|<!ENTITY/i');
    expect(importService).toMatch(/CCDA_STRUCTURE_LIMIT_EXCEEDED/);
    expect(importService).not.toMatch(/function extractCCDASection/);
    expect(importService).not.toMatch(/function extractCCDAPatient/);
  });
});
