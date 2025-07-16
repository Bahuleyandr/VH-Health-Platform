// controllers/investigation/uploadController.js
import db from '../../config/database.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { 
  uploadInvestigationFile, 
  getInvestigationFiles,
  getFileById,
  deleteFile,
  getFileStream 
} from '../../services/investigation/fileService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';

// Upload investigation result file
export const uploadResult = async (req, res) => {
  try {
    const { id } = req.params;
    const file = req.file;
    const uploadedBy = req.user?.uid;
    const userRole = req.user?.role?.toUpperCase();
    
    // Access control - only medical staff can upload
    const allowedRoles = ['DOCTOR', 'LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        message: 'Access denied: Medical staff privileges required',
        requestedBy: uploadedBy
      });
    }
    
    if (!file) {
      return res.status(400).json({
        message: 'No file uploaded',
        requestedBy: uploadedBy
      });
    }
    
    // Log file details for debugging
    logger.info(`File upload attempt for investigation ${id}:`, {
      filename: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      uploadedBy
    });
    
    const result = await uploadInvestigationFile(id, file, uploadedBy);
    
    await logAudit(req, 'investigation-file-uploaded', {
      investigation_id: id,
      file_id: result.id,
      file_name: file.originalname,
      file_size: file.size
    });
    
    success(res, {
      file: result,
      uploadedBy
    }, 'File uploaded successfully');
    
  } catch (err) {
    logger.error('Upload Error:', err);
    
    // Specific error handling
    if (err.message === 'Investigation not found') {
      return res.status(404).json({
        message: 'Investigation not found',
        requestedBy: req.user?.uid
      });
    } else if (err.message.includes('Invalid file type')) {
      return res.status(400).json({
        message: err.message,
        requestedBy: req.user?.uid
      });
    } else if (err.message.includes('File size exceeds')) {
      return res.status(400).json({
        message: err.message,
        requestedBy: req.user?.uid
      });
    }
    
    error(res, 'Failed to upload file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get all files for an investigation
export const getFiles = async (req, res) => {
  try {
    const { id } = req.params;
    const requestedBy = req.user?.uid;
    const userRole = req.user?.role?.toUpperCase();
    
    // Patients can only view files for their own investigations
    if (userRole === 'PATIENT') {
      // Verify the investigation belongs to this patient
      const investigationCheck = await db.query(`
        SELECT patient_id 
        FROM investigations i
        JOIN users u ON i.patient_id = u.id
        WHERE i.id = $1 AND u.uid = $2
      `, [id, requestedBy]);
      
      if (investigationCheck.rows.length === 0) {
        return res.status(403).json({
          message: 'Access denied: Cannot view files for other patients',
          requestedBy
        });
      }
    }
    
    const files = await getInvestigationFiles(id);
    
    await logAudit(req, 'investigation-files-viewed', {
      investigation_id: id,
      file_count: files.length
    });
    
    success(res, {
      files,
      count: files.length,
      requestedBy
    }, 'Files retrieved successfully');
    
  } catch (err) {
    logger.error('Get Files Error:', err);
    error(res, 'Failed to retrieve files', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Download a specific file
export const downloadFile = async (req, res) => {
  try {
    const { id, fileId } = req.params;
    const requestedBy = req.user?.uid;
    const userRole = req.user?.role?.toUpperCase();
    
    // Access control similar to getFiles
    if (userRole === 'PATIENT') {
      const investigationCheck = await db.query(`
        SELECT patient_id 
        FROM investigations i
        JOIN users u ON i.patient_id = u.id
        WHERE i.id = $1 AND u.uid = $2
      `, [id, requestedBy]);
      
      if (investigationCheck.rows.length === 0) {
        return res.status(403).json({
          message: 'Access denied',
          requestedBy
        });
      }
    }
    
    const fileData = await getFileStream(fileId);
    
    if (!fileData) {
      return res.status(404).json({
        message: 'File not found',
        requestedBy
      });
    }
    
    await logAudit(req, 'investigation-file-downloaded', {
      investigation_id: id,
      file_id: fileId,
      file_name: fileData.fileName
    });
    
    // Set appropriate headers for file download
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileData.fileName}"`);
    
    // Stream the file
    fileData.stream.pipe(res);
    
  } catch (err) {
    logger.error('Download File Error:', err);
    
    if (err.message === 'File not found' || err.message === 'File not found on disk') {
      return res.status(404).json({
        message: 'File not found',
        requestedBy: req.user?.uid
      });
    }
    
    error(res, 'Failed to download file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Delete a file
export const removeFile = async (req, res) => {
  try {
    const { id, fileId } = req.params;
    const deletedBy = req.user?.uid;
    const userRole = req.user?.role?.toUpperCase();
    
    // Only admins and the uploader can delete files
    const file = await getFileById(fileId);
    if (!file) {
      return res.status(404).json({
        message: 'File not found',
        requestedBy: deletedBy
      });
    }
    
    if (userRole !== 'ADMIN' && file.uploaded_by !== deletedBy) {
      return res.status(403).json({
        message: 'Access denied: Only admin or file uploader can delete files',
        requestedBy: deletedBy
      });
    }
    
    await deleteFile(fileId, deletedBy);
    
    await logAudit(req, 'investigation-file-deleted', {
      investigation_id: id,
      file_id: fileId,
      file_name: file.file_name
    });
    
    success(res, {
      message: 'File deleted successfully',
      deletedBy
    }, 'File deleted successfully');
    
  } catch (err) {
    logger.error('Delete File Error:', err);
    
    if (err.message === 'File not found') {
      return res.status(404).json({
        message: 'File not found',
        requestedBy: req.user?.uid
      });
    }
    
    error(res, 'Failed to delete file', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get file metadata without downloading
export const getFileInfo = async (req, res) => {
  try {
    const { id, fileId } = req.params;
    const requestedBy = req.user?.uid;
    
    const file = await getFileById(fileId);
    
    if (!file) {
      return res.status(404).json({
        message: 'File not found',
        requestedBy
      });
    }
    
    // Verify file belongs to the investigation
    if (file.investigation_id !== parseInt(id)) {
      return res.status(400).json({
        message: 'File does not belong to this investigation',
        requestedBy
      });
    }
    
    success(res, {
      file: {
        id: file.id,
        name: file.file_name,
        type: file.file_type,
        size: file.file_size,
        uploadedAt: file.uploaded_at,
        uploadedBy: file.uploaded_by
      },
      requestedBy
    }, 'File info retrieved successfully');
    
  } catch (err) {
    logger.error('Get File Info Error:', err);
    error(res, 'Failed to retrieve file info', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};