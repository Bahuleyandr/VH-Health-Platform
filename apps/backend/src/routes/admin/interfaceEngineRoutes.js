import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  activateChannelVersion,
  createChannel,
  createChannelVersion,
  createReplayBatch,
  createSystem,
  createTransformTest,
  dispatchOutboundMessages,
  enqueueOutboundMessage,
  getMessage,
  listChannels,
  listMessages,
  listReplayBatches,
  listSystems,
  listTransformTests,
  markMessageDead,
  runTransformTest,
} from '../../services/interfaceEngine/interfaceEngineService.js';

const router = express.Router();

router.get('/systems', async (req, res, next) => {
  try {
    const result = await listSystems({
      tenantId: req.tenantId,
      status: req.query.status || null,
      kind: req.query.kind || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Interface systems retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/systems', async (req, res, next) => {
  try {
    const row = await createSystem({
      tenantId: req.tenantId,
      systemKey: req.body?.system_key,
      displayName: req.body?.display_name,
      kind: req.body?.kind,
      direction: req.body?.direction,
      status: req.body?.status || 'draft',
      allowedSourceIps: req.body?.allowed_source_ips || [],
      metadata: req.body?.metadata || {},
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Interface system created', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/channels', async (req, res, next) => {
  try {
    const result = await listChannels({
      tenantId: req.tenantId,
      status: req.query.status || null,
      connectorKind: req.query.connector_kind || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Interface channels retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/channels', async (req, res, next) => {
  try {
    const row = await createChannel({
      tenantId: req.tenantId,
      channelKey: req.body?.channel_key,
      displayName: req.body?.display_name,
      sourceSystemId: req.body?.source_system_id || null,
      targetSystemId: req.body?.target_system_id || null,
      direction: req.body?.direction,
      connectorKind: req.body?.connector_kind,
      protocol: req.body?.protocol,
      messageTypes: req.body?.message_types || [],
      authKind: req.body?.auth_kind || 'tenant_interop_secret',
      authSenderIdentifier: req.body?.auth_sender_identifier || null,
      retentionDays: req.body?.retention_days,
      maxAttempts: req.body?.max_attempts,
      retryPolicy: req.body?.retry_policy || {},
      deadLetterPolicy: req.body?.dead_letter_policy || {},
      metadata: req.body?.metadata || {},
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Interface channel created', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/channels/:id/versions', async (req, res, next) => {
  try {
    const row = await createChannelVersion({
      tenantId: req.tenantId,
      channelId: req.params.id,
      connectorConfig: req.body?.connector_config || {},
      validationProfile: req.body?.validation_profile || {},
      transformDsl: req.body?.transform_dsl || {},
      routingPolicy: req.body?.routing_policy || {},
      redactionProfile: req.body?.redaction_profile || {},
      status: req.body?.status || 'candidate',
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Interface channel version created', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/versions/:id/activate', async (req, res, next) => {
  try {
    const row = await activateChannelVersion({
      tenantId: req.tenantId,
      channelVersionId: req.params.id,
      actorUid: req.user?.uid || null,
    });
    return success(res, row, 'Interface channel version activated');
  } catch (err) {
    return next(err);
  }
});

router.get('/versions/:id/transform-tests', async (req, res, next) => {
  try {
    const result = await listTransformTests({
      tenantId: req.tenantId,
      channelVersionId: req.params.id,
      limit: req.query.limit,
    });
    return success(res, result, 'Transform tests retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/versions/:id/transform-tests', async (req, res, next) => {
  try {
    const row = await createTransformTest({
      tenantId: req.tenantId,
      channelVersionId: req.params.id,
      name: req.body?.name,
      messageType: req.body?.message_type || null,
      inputPayload: req.body?.input_payload,
      inputPayloadIsSynthetic: req.body?.input_payload_is_synthetic !== false,
      expectedOutput: req.body?.expected_output || {},
      expectedFindings: req.body?.expected_findings || [],
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Transform test created', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/transform-tests/:id/run', async (req, res, next) => {
  try {
    const row = await runTransformTest({
      tenantId: req.tenantId,
      testId: req.params.id,
    });
    return success(res, row, 'Transform test run completed');
  } catch (err) {
    return next(err);
  }
});

router.get('/messages', async (req, res, next) => {
  try {
    const result = await listMessages({
      tenantId: req.tenantId,
      channelId: req.query.channel_id || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Interface messages retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/messages/enqueue-outbound', async (req, res, next) => {
  try {
    const row = await enqueueOutboundMessage({
      tenantId: req.tenantId,
      channelId: req.body?.channel_id,
      payload: req.body?.payload,
      protocol: req.body?.protocol || null,
      messageType: req.body?.message_type || null,
      sourceTable: req.body?.source_table || null,
      sourceId: req.body?.source_id || null,
    });
    return success(res, row, 'Outbound interface message queued', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/messages/dispatch-now', async (req, res, next) => {
  try {
    const result = await dispatchOutboundMessages({
      tenantId: req.tenantId,
      batchSize: req.body?.batch_size || 25,
    });
    return success(res, result, 'Interface outbound dispatch completed', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/messages/:id', async (req, res, next) => {
  try {
    const row = await getMessage({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, row, 'Interface message retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/messages/:id/mark-dead', async (req, res, next) => {
  try {
    const row = await markMessageDead({
      tenantId: req.tenantId,
      id: req.params.id,
      reason: req.body?.reason || null,
    });
    return success(res, row, 'Interface message moved to dead-letter');
  } catch (err) {
    return next(err);
  }
});

router.get('/replay-batches', async (req, res, next) => {
  try {
    const result = await listReplayBatches({
      tenantId: req.tenantId,
      channelId: req.query.channel_id || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Replay batches retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/replay-batches', async (req, res, next) => {
  try {
    const row = await createReplayBatch({
      tenantId: req.tenantId,
      channelId: req.body?.channel_id,
      reason: req.body?.reason,
      mode: req.body?.mode || 'retry_delivery',
      selectionFilter: req.body?.selection_filter || {},
      requestedBy: req.user?.uid || null,
    });
    return success(res, row, 'Replay batch evaluated and eligible messages queued', 201);
  } catch (err) {
    return next(err);
  }
});

export default router;
