/**
 * CDS Hooks endpoints (https://cds-hooks.org/).
 *
 *   GET  /cds-services        — service discovery (advertised hooks).
 *   POST /cds-services/:id    — invoke a hook; returns CDS Hooks cards.
 *
 * The handlers translate cdsEngine output via cdsHooksAdapter so a
 * third-party EHR's CDS Hooks client can consume them without VH-specific
 * knowledge. Closes substrate hole S4 in docs/AI_FEATURE_GAP_BACKLOG.md.
 */

import express from 'express';

import {
  checkDrugInteractions,
  checkAllergies,
  checkDuplicateOrders,
  checkOrder,
  getActiveAlerts,
  getProtocolReminders,
} from '../../services/emr/cdsEngine.js';
import {
  buildCardsResponse,
  buildDiscoveryResponse,
  extractEncounterId,
  extractMedicationNames,
  extractPatientUid,
  findServiceById,
} from '../../services/cds/cdsHooksAdapter.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

router.get('/', (_req, res) => {
  return res.json(buildDiscoveryResponse());
});

router.post('/:id', async (req, res, next) => {
  try {
    const service = findServiceById(req.params.id);
    if (!service) {
      throw AppError.notFound(`Unknown CDS Hooks service: ${req.params.id}`);
    }
    const body = req.body || {};
    if (body.hook && body.hook !== service.hook) {
      throw AppError.badRequest(
        `Hook mismatch: service ${service.id} is hook=${service.hook}, request body declares ${body.hook}.`,
      );
    }
    const context = body.context || {};
    const patientUid = extractPatientUid(context);
    const encounterId = extractEncounterId(context);

    let alerts = [];
    switch (service.hook) {
      case 'patient-view': {
        if (!patientUid) {
          // Spec allows the service to return zero cards rather than
          // erroring on missing context.
          break;
        }
        const [protocolAlerts, activeAlerts] = await Promise.all([
          getProtocolReminders(patientUid, encounterId).catch((err) => {
            logger.warn('CDS Hooks patient-view protocols failed', { error: err.message });
            return [];
          }),
          getActiveAlerts(patientUid).catch((err) => {
            logger.warn('CDS Hooks patient-view active alerts failed', { error: err.message });
            return [];
          }),
        ]);
        alerts = [
          ...protocolAlerts,
          // getActiveAlerts persists the canonical shape but includes some
          // extra fields; map to the alert shape cdsHooksAdapter expects.
          ...activeAlerts.map((alert) => ({
            type: alert.alert_type,
            severity: alert.severity,
            title: alert.title,
            description: alert.description,
            canOverride: !alert.acknowledged,
            sourceData: alert.source_data || null,
          })),
        ];
        break;
      }

      case 'medication-prescribe': {
        if (!patientUid) break;
        const medications = extractMedicationNames(context);
        if (!medications.length) break;
        const perMed = await Promise.all(medications.map(async (medicationName) => {
          const [interactions, allergyConflicts, duplicates] = await Promise.all([
            checkDrugInteractions(medicationName, patientUid).catch(() => []),
            checkAllergies(medicationName, patientUid).catch(() => []),
            checkDuplicateOrders('medication', { medication_name: medicationName }, patientUid).catch(() => []),
          ]);
          return [...interactions, ...allergyConflicts, ...duplicates];
        }));
        alerts = perMed.flat();
        break;
      }

      case 'order-select':
      case 'order-sign': {
        if (!patientUid) break;
        const draftOrders = Array.isArray(body.context?.draftOrders?.entry)
          ? body.context.draftOrders.entry
              .map((entry) => entry?.resource)
              .filter(Boolean)
          : [];
        // For each draft order resource, infer (type, identifier) and
        // delegate to checkOrder. The richer FHIR mapping (RequestGroup,
        // ServiceRequest, MedicationRequest) is intentionally narrow here:
        // we cover MedicationRequest and ServiceRequest, the two shapes
        // CDS Hooks order-select/order-sign actually carries.
        const perOrder = await Promise.all(draftOrders.map(async (resource) => {
          if (resource.resourceType === 'MedicationRequest') {
            const medicationName = resource.medicationCodeableConcept?.text
              || resource.medicationCodeableConcept?.coding?.[0]?.display
              || resource.medicationReference?.display
              || null;
            if (!medicationName) return [];
            const result = await checkOrder({
              type: 'medication',
              medication_name: medicationName,
              patient_uid: patientUid,
              encounter_id: encounterId,
            }).catch(() => ({ alerts: [] }));
            return result.alerts || [];
          }
          if (resource.resourceType === 'ServiceRequest') {
            const testName = resource.code?.text
              || resource.code?.coding?.[0]?.display
              || null;
            if (!testName) return [];
            const result = await checkOrder({
              type: 'investigation',
              test_name: testName,
              patient_uid: patientUid,
              encounter_id: encounterId,
            }).catch(() => ({ alerts: [] }));
            return result.alerts || [];
          }
          return [];
        }));
        alerts = perOrder.flat();
        break;
      }

      default:
        // Service is registered but no evaluator wired — return empty
        // cards rather than 500.
        alerts = [];
        break;
    }

    return res.json(buildCardsResponse(alerts));
  } catch (err) {
    return next(err);
  }
});

export default router;
