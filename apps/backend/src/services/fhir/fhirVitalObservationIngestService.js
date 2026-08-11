import { importFhirVitalObservation } from '../import/patientDataImport.js';

export function ingestFhirVitalObservation(resource, importedBy, options) {
  return importFhirVitalObservation(resource, importedBy, options);
}

export default { ingestFhirVitalObservation };
