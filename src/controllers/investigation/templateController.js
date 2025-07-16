// controllers/investigation/templateController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as templateService from '../../services/investigation/templateService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';

// List all templates
export const listTemplates = async (req, res) => {
  try {
    const { type, department_id } = req.query;
    const requestedBy = req.user?.uid;
    
    const templates = await templateService.getTemplates({ type, department_id });
    
    await logAudit(req, 'investigation-templates-viewed', { 
      count: templates.length,
      filters: { type, department_id }
    });
    
    success(res, {
      templates,
      count: templates.length,
      requestedBy
    }, 'Templates retrieved successfully');
    
  } catch (err) {
    logger.error('List Templates Error:', err);
    error(res, 'Failed to retrieve templates', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get single template
export const getTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const requestedBy = req.user?.uid;
    
    const template = await templateService.getTemplateById(id);
    
    if (!template) {
      return res.status(404).json({
        message: 'Template not found',
        requestedBy
      });
    }
    
    await logAudit(req, 'investigation-template-viewed', { template_id: id });
    
    success(res, {
      template,
      requestedBy
    }, 'Template retrieved successfully');
    
  } catch (err) {
    logger.error('Get Template Error:', err);
    error(res, 'Failed to retrieve template', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Create new template
export const createTemplate = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const createdBy = req.user?.uid;
    
    // Only admins and senior doctors can create templates
    if (!['ADMIN', 'DOCTOR'].includes(userRole)) {
      return res.status(403).json({
        message: 'Access denied: Admin or doctor privileges required',
        requestedBy: createdBy
      });
    }
    
    const templateData = {
      ...req.body,
      created_by: createdBy
    };
    
    const template = await templateService.createTemplate(templateData);
    
    await logAudit(req, 'investigation-template-created', { 
      template_id: template.id,
      name: template.name
    });
    
    success(res, {
      template,
      createdBy
    }, 'Template created successfully');
    
  } catch (err) {
    logger.error('Create Template Error:', err);
    error(res, 'Failed to create template', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Apply template to patient
export const applyTemplate = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const appliedBy = req.user?.uid;
    
    // Only doctors can apply templates
    if (userRole !== 'DOCTOR' && userRole !== 'ADMIN') {
      return res.status(403).json({
        message: 'Access denied: Doctor privileges required',
        requestedBy: appliedBy
      });
    }
    
    const { id } = req.params;
    const { patient_id, doctor_id } = req.body;
    
    if (!patient_id || !doctor_id) {
      return res.status(400).json({
        message: 'Patient ID and Doctor ID are required',
        requestedBy: appliedBy
      });
    }
    
    const investigations = await templateService.applyTemplate(
      id,
      patient_id,
      doctor_id,
      appliedBy
    );
    
    await logAudit(req, 'investigation-template-applied', { 
      template_id: id,
      patient_id,
      investigations_created: investigations.length
    });
    
    success(res, {
      investigations,
      count: investigations.length,
      appliedBy
    }, 'Template applied successfully');
    
  } catch (err) {
    logger.error('Apply Template Error:', err);
    
    if (err.message === 'Template not found or inactive') {
      return res.status(404).json({
        message: err.message,
        requestedBy: req.user?.uid
      });
    }
    
    error(res, 'Failed to apply template', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update template
export const updateTemplate = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const updatedBy = req.user?.uid;
    
    if (!['ADMIN', 'DOCTOR'].includes(userRole)) {
      return res.status(403).json({
        message: 'Access denied: Admin or doctor privileges required',
        requestedBy: updatedBy
      });
    }
    
    const { id } = req.params;
    const updateData = {
      ...req.body,
      updated_by: updatedBy
    };
    
    const template = await templateService.updateTemplate(id, updateData);
    
    if (!template) {
      return res.status(404).json({
        message: 'Template not found',
        requestedBy: updatedBy
      });
    }
    
    await logAudit(req, 'investigation-template-updated', { template_id: id });
    
    success(res, {
      template,
      updatedBy
    }, 'Template updated successfully');
    
  } catch (err) {
    logger.error('Update Template Error:', err);
    error(res, 'Failed to update template', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Deactivate template
export const deactivateTemplate = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const deactivatedBy = req.user?.uid;
    
    if (userRole !== 'ADMIN') {
      return res.status(403).json({
        message: 'Access denied: Admin privileges required',
        requestedBy: deactivatedBy
      });
    }
    
    const { id } = req.params;
    
    const result = await templateService.deactivateTemplate(id, deactivatedBy);
    
    if (!result) {
      return res.status(404).json({
        message: 'Template not found',
        requestedBy: deactivatedBy
      });
    }
    
    await logAudit(req, 'investigation-template-deactivated', { template_id: id });
    
    success(res, {
      message: 'Template deactivated successfully',
      deactivatedBy
    }, 'Template deactivated');
    
  } catch (err) {
    logger.error('Deactivate Template Error:', err);
    error(res, 'Failed to deactivate template', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};