import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as medicationService from '../../services/pharmacy/medicationService.js';
import { success, error } from '../../utils/responseHelper.js';

// Get all medications with filtering
export const getAllMedications = async (req, res) => {
  try {
    const filters = {
      page: parseInt(req.query.page) || 1,
      limit: Math.min(parseInt(req.query.limit) || 20, 100),
      search: req.query.search,
      category: req.query.category,
      in_stock: req.query.in_stock
    };
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await medicationService.getAllMedications(filters);

    success(res, {
      ...result,
      requestedBy
    }, 'Medications retrieved successfully');
  } catch (err) {
    logger.error('Get Medications Error:', err);
    res.status(500).json({
      message: 'Failed to retrieve medications - medications table may not exist',
      error: err.message,
      suggestion: 'Create medications table with proper schema',
      requestedBy: req.user?.uid
    });
  }
};

// Get medication by ID
export const getMedicationById = async (req, res) => {
  try {
    const { id } = req.params;
    const requestedBy = req.user?.uid || 'anonymous';

    const medication = await medicationService.getMedicationById(id);

    if (!medication) {
      return error(res, 'Medication not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, {
      medication,
      requestedBy
    }, 'Medication retrieved successfully');
  } catch (err) {
    logger.error('Get Medication Error:', err);
    error(res, 'Failed to retrieve medication', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get medications by category
export const getMedicationsByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const in_stock_only = req.query.in_stock === 'true';
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await medicationService.getMedicationsByCategory(category, in_stock_only);

    success(res, {
      ...result,
      requestedBy
    }, `Medications in ${category} category retrieved successfully`);
  } catch (err) {
    logger.error('Get Medications by Category Error:', err);
    error(res, 'Failed to retrieve medications by category', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Search medications
export const searchMedications = async (req, res) => {
  try {
    const searchParams = {
      q: req.query.q,
      category: req.query.category,
      prescription_required: req.query.prescription_required,
      min_price: req.query.min_price ? parseFloat(req.query.min_price) : null,
      max_price: req.query.max_price ? parseFloat(req.query.max_price) : null,
      in_stock_only: req.query.in_stock_only === 'true'
    };
    const requestedBy = req.user?.uid || 'anonymous';

    const result = await medicationService.searchMedications(searchParams);

    success(res, {
      ...result,
      requestedBy
    }, 'Medication search completed');
  } catch (err) {
    logger.error('Search Medications Error:', err);
    error(res, 'Failed to search medications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Create medication (admin only)
export const createMedication = async (req, res) => {
  try {
    const medicationData = {
      ...req.body,
      createdBy: req.user?.uid || 'system'
    };

    // Basic validation
    const { name, generic_name, category, price } = medicationData;
    if (!name || !generic_name || !category || !price) {
      return error(res, 'name, generic_name, category, and price are required', HTTP_STATUS.BAD_REQUEST);
    }

    const medication = await medicationService.createMedication(medicationData);

    if (!medication) {
      return error(res, 'Medication with this name and generic name already exists', HTTP_STATUS.CONFLICT);
    }

    success(res, {
      medication,
      createdBy: medicationData.createdBy
    }, 'Medication created successfully');
  } catch (err) {
    logger.error('Create Medication Error:', err);
    error(res, 'Failed to create medication', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update medication (admin only)
export const updateMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = {
      ...req.body,
      updatedBy: req.user?.uid || 'system'
    };

    const medication = await medicationService.updateMedication(id, updateData);

    if (!medication) {
      return error(res, 'Medication not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, {
      medication,
      updatedBy: updateData.updatedBy
    }, 'Medication updated successfully');
  } catch (err) {
    logger.error('Update Medication Error:', err);
    error(res, 'Failed to update medication', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Delete medication (admin only)
export const deleteMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedBy = req.user?.uid || 'system';

    const result = await medicationService.deleteMedication(id, deletedBy);

    if (!result) {
      return error(res, 'Medication not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, {
      deleted_medication: result,
      deletedBy,
      note: 'Medication soft deleted (marked as inactive)'
    }, 'Medication deleted successfully');
  } catch (err) {
    logger.error('Delete Medication Error:', err);
    error(res, 'Failed to delete medication', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update stock quantity
export const updateStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, operation = 'set' } = req.body;
    const updatedBy = req.user?.uid || 'system';

    if (quantity === undefined || quantity < 0) {
      return error(res, 'Valid quantity is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await medicationService.updateStock(id, quantity, operation, updatedBy);

    if (!result) {
      return error(res, 'Medication not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, {
      medication: result,
      updatedBy
    }, 'Stock quantity updated successfully');
  } catch (err) {
    logger.error('Update Stock Error:', err);
    error(res, 'Failed to update stock quantity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};