// src/validators/facilityAssetValidator.js
//
// express-validator chains for the general facility asset register
// (migration 704). Vocabularies mirror the DB CHECK constraints; the service
// re-validates defensively (validator is the friendly 400 surface, the CHECKs
// are the backstop).

import { body, query } from 'express-validator';
import {
  FACILITY_ASSET_CATEGORIES,
  FACILITY_ASSET_CONDITIONS,
  FACILITY_ASSET_STATUSES,
} from '../services/facility/facilityAssetService.js';
import { optionalString, requiredString } from './sharedValidators.js';

const optionalUuid = (name) => body(name)
  .optional({ nullable: true })
  .isUUID().withMessage(`${name} must be a valid UUID`);

const optionalDate = (name) => body(name)
  .optional({ nullable: true })
  .isISO8601({ strict: true }).withMessage(`${name} must be an ISO date (YYYY-MM-DD)`);

const optionalCost = (name) => body(name)
  .optional({ nullable: true })
  .isFloat({ min: 0 }).withMessage(`${name} must be a non-negative number`);

const writeFields = [
  optionalString('description', 4000),
  optionalString('locationDepartment', 120),
  optionalString('locationRoom', 120),
  optionalUuid('custodianUid'),
  optionalString('vendor', 160),
  optionalDate('purchaseDate'),
  optionalCost('purchaseCost'),
  optionalDate('warrantyUntil'),
  body('condition').optional({ nullable: true })
    .isIn(FACILITY_ASSET_CONDITIONS)
    .withMessage(`condition must be one of: ${FACILITY_ASSET_CONDITIONS.join(', ')}`),
  optionalString('notes', 1000),
];

export const createFacilityAssetValidators = [
  requiredString('assetTag', 64),
  requiredString('name', 200),
  body('category')
    .exists({ checkFalsy: true }).withMessage('category is required')
    .isIn(FACILITY_ASSET_CATEGORIES)
    .withMessage(`category must be one of: ${FACILITY_ASSET_CATEGORIES.join(', ')}`),
  ...writeFields,
];

export const updateFacilityAssetValidators = [
  optionalString('assetTag', 64),
  optionalString('name', 200),
  body('category').optional({ nullable: true })
    .isIn(FACILITY_ASSET_CATEGORIES)
    .withMessage(`category must be one of: ${FACILITY_ASSET_CATEGORIES.join(', ')}`),
  body('status').not().exists()
    .withMessage('status cannot be changed here — use POST /:id/status'),
  ...writeFields,
];

export const transitionFacilityAssetValidators = [
  body('toStatus')
    .exists({ checkFalsy: true }).withMessage('toStatus is required')
    .isIn(FACILITY_ASSET_STATUSES)
    .withMessage(`toStatus must be one of: ${FACILITY_ASSET_STATUSES.join(', ')}`),
  optionalString('reason', 500),
  optionalString('notes', 1000),
];

export const maintenanceFacilityAssetValidators = [
  requiredString('notes', 1000),
  optionalCost('cost'),
  optionalString('vendor', 160),
];

export const listFacilityAssetValidators = [
  query('status').optional({ nullable: true })
    .isIn(FACILITY_ASSET_STATUSES)
    .withMessage(`status must be one of: ${FACILITY_ASSET_STATUSES.join(', ')}`),
  query('category').optional({ nullable: true })
    .isIn(FACILITY_ASSET_CATEGORIES)
    .withMessage(`category must be one of: ${FACILITY_ASSET_CATEGORIES.join(', ')}`),
  query('q').optional({ nullable: true })
    .isString().withMessage('q must be a string')
    .isLength({ max: 200 }).withMessage('q must be at most 200 characters'),
  query('custodian_uid').optional({ nullable: true })
    .isUUID().withMessage('custodian_uid must be a valid UUID'),
  query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('limit must be 1-500').toInt(),
  query('offset').optional().isInt({ min: 0 }).withMessage('offset must be >= 0').toInt(),
];

export default {
  createFacilityAssetValidators,
  updateFacilityAssetValidators,
  transitionFacilityAssetValidators,
  maintenanceFacilityAssetValidators,
  listFacilityAssetValidators,
};
