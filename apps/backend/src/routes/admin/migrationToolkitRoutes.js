/**
 * NL11-S1 migration toolkit routes.
 *
 * Mounted at /api/v1/admin/migration-toolkit. The parent admin mount applies
 * JWT, role, step-up, IP allowlist, and admin rate limiting. This router keeps
 * P1 is rehearsal-only. P2 adds explicit commit batches and HL7 ADT imports;
 * both preserve redacted reports and idempotency proofs.
 */

import express from 'express';

import {
  commitImportJob,
  createImportJob,
  getAcceptanceReport,
  getRehearsalReport,
  importHl7AdtBatch,
  listImportJobs,
  listMappingProfiles,
  profileSourceFile,
  rehearseImportJob,
  upsertMappingProfile,
} from '../../services/migrationToolkit/migrationToolkitService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

router.post('/jobs', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await createImportJob({
      tenantId: req.tenantId,
      jobName: body.job_name,
      sourceSystem: body.source_system,
      importKind: body.import_kind,
      createdBy: req.user?.uid || null,
      metadata: body.metadata,
    });
    return success(res, row, 'Migration import job created', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/jobs', async (req, res, next) => {
  try {
    const result = await listImportJobs({
      tenantId: req.tenantId,
      status: req.query.status || null,
      importKind: req.query.import_kind || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Migration import jobs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/jobs/:jobId/source-files', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await profileSourceFile({
      tenantId: req.tenantId,
      jobId: req.params.jobId,
      fileKind: body.file_kind,
      sourceFilename: body.source_filename,
      csvText: body.csv_text,
      mimeType: body.mime_type,
      uploadedBy: req.user?.uid || null,
    });
    return success(res, row, 'Migration source file profiled', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/jobs/:jobId/rehearsals', async (req, res, next) => {
  try {
    const result = await rehearseImportJob({
      tenantId: req.tenantId,
      jobId: req.params.jobId,
      files: req.body?.files,
      generatedBy: req.user?.uid || null,
    });
    return success(res, result, 'Migration rehearsal report generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/jobs/:jobId/commits', async (req, res, next) => {
  try {
    const result = await commitImportJob({
      tenantId: req.tenantId,
      jobId: req.params.jobId,
      files: req.body?.files,
      idempotencyKey: req.body?.idempotency_key,
      committedBy: req.user?.uid || null,
    });
    return success(res, result, 'Migration commit batch completed', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/jobs/:jobId/hl7-adt-batches', async (req, res, next) => {
  try {
    const result = await importHl7AdtBatch({
      tenantId: req.tenantId,
      jobId: req.params.jobId,
      messages: req.body?.messages,
      sourceFilename: req.body?.source_filename,
      idempotencyKey: req.body?.idempotency_key,
      committedBy: req.user?.uid || null,
    });
    return success(res, result, 'HL7 ADT migration batch imported', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/jobs/:jobId/report', async (req, res, next) => {
  try {
    const row = await getRehearsalReport({
      tenantId: req.tenantId,
      jobId: req.params.jobId,
    });
    return success(res, row, 'Migration rehearsal report retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/jobs/:jobId/commit-batches/:batchId/report', async (req, res, next) => {
  try {
    const row = await getAcceptanceReport({
      tenantId: req.tenantId,
      batchId: req.params.batchId,
    });
    return success(res, row, 'Migration acceptance report retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/mapping-profiles', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await upsertMappingProfile({
      tenantId: req.tenantId,
      profileName: body.profile_name,
      sourceSystem: body.source_system,
      targetKind: body.target_kind,
      version: body.version,
      status: body.status,
      fieldMap: body.field_map,
      transformNotes: body.transform_notes,
      createdBy: req.user?.uid || null,
      metadata: body.metadata,
    });
    return success(res, row, 'Migration mapping profile saved');
  } catch (err) {
    return next(err);
  }
});

router.get('/mapping-profiles', async (req, res, next) => {
  try {
    const result = await listMappingProfiles({
      tenantId: req.tenantId,
      targetKind: req.query.target_kind || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Migration mapping profiles retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
