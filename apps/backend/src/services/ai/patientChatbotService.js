/**
 * Patient-facing RAG chatbot.
 *
 * Consent-gated: the caller MUST be the patient themselves (JWT uid
 * matches the conversation's patient_uid) OR a SUPER_ADMIN debugging.
 * Retrieves from the tenant's RAG corpus scoped strictly to the
 * patient_uid filter so no other patient's data can leak. Every message
 * is persisted immutably for regulator review.
 *
 * Safety contract:
 *   - The assistant can ONLY quote from the patient's own record.
 *   - It does NOT give clinical advice. If the question implies a
 *     clinical decision, the response politely redirects to the care
 *     team.
 *   - PHI leak detector runs on every response; leaks route the entire
 *     message to the dead-letter surface (marked failed).
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { generateClinicalText } from './localLlmClient.js';
import { retrieveRelevant } from './ragService.js';
import { detectPhiLeaks } from './hallucinationDefenses.js';

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function truncate(text, n = 280) {
  const body = String(text || '');
  return body.length > n ? `${body.slice(0, n - 3)}...` : body;
}

// M13 (audit 2026-06-22): the patient-facing RAG chatbot must run ONLY when its
// module is enabled for the tenant. The catalog ships patient_record_chatbot with
// enabled:false / surface:'patient', and the enable flip is patient-surface-
// clearance-gated — but the chatbot entry points never consulted the toggle, so
// it answered over the patient's PHI while the platform reported the module
// disabled. Gate every write/AI entry point. Lazy import avoids a load-time cycle
// with the large clinicalAiModuleService.
async function assertChatbotEnabled(tenantId) {
  const { getClinicalAiModule } = await import('./clinicalAiModuleService.js');
  const module = await getClinicalAiModule('patient_record_chatbot', { tenantId });
  if (!module?.enabled) {
    throw AppError.forbidden(
      'The patient record chatbot is not enabled for this tenant',
      'CLINICAL_AI_MODULE_DISABLED',
      { module_key: 'patient_record_chatbot' },
    );
  }
  return module;
}

async function assertOwnership({ conversationId, tenantId, patientUid, role }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, tenant_id, status
     FROM patient_chat_conversations
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    Number.parseInt(conversationId, 10),
    tenantId
  );
  const conv = rows[0];
  if (!conv) throw AppError.notFound('Conversation not found');
  if (conv.status !== 'active') throw AppError.conflict('Conversation is closed');
  const normalizedRole = String(role || '').toUpperCase();
  if (normalizedRole === 'SUPER_ADMIN') return conv;
  if (String(conv.patient_uid) !== String(patientUid)) {
    throw AppError.forbidden('You can only access your own conversations');
  }
  return conv;
}

export async function startConversation({ tenantId = null, patientUid, title = null } = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  const tid = resolveTenantId({ tenantId });
  await assertChatbotEnabled(tid);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO patient_chat_conversations
       (tenant_id, patient_uid, title, started_at, last_message_at, status, message_count)
     VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), 'active', 0)
     RETURNING id, tenant_id, patient_uid, title, started_at, status, message_count`,
    tid,
    patientUid,
    title || null
  );
  return rows[0];
}

async function persistMessage({ tenantId, conversationId, role, content, citations = [], safetyFlags = [], provider = null, model = null, tokenUsage = {} }) {
  await prisma.$queryRawUnsafe(
    `INSERT INTO patient_chat_messages
       (tenant_id, conversation_id, role, content, citations, safety_flags, provider, model, token_usage, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, NOW())`,
    tenantId,
    conversationId,
    role,
    content,
    JSON.stringify(citations || []),
    JSON.stringify(safetyFlags || []),
    provider,
    model,
    JSON.stringify(tokenUsage || {})
  );
  await prisma.$queryRawUnsafe(
    `UPDATE patient_chat_conversations
     SET last_message_at = NOW(),
         message_count = message_count + 1
     WHERE id = $1 AND tenant_id = $2::uuid`,
    conversationId,
    tenantId
  );
}

export async function sendMessage({ req, conversationId, message } = {}) {
  if (!req?.user) throw AppError.unauthorized('authentication required');
  if (!message || !String(message).trim()) throw AppError.badRequest('message is required');
  const tenantId = resolveTenantId({ tenantId: req.tenantId });
  await assertChatbotEnabled(tenantId);
  const patientUid = req.user.uid;
  const conv = await assertOwnership({ conversationId, tenantId, patientUid, role: req.user.role });

  // Persist patient message first so the audit trail survives any downstream
  // error.
  await persistMessage({
    tenantId,
    conversationId: conv.id,
    role: 'patient',
    content: String(message),
    provider: null,
  });

  // Retrieve from THIS patient's own corpus only.
  const retrieved = await retrieveRelevant({
    tenantId,
    queryText: String(message),
    filters: { patientUid },
    topK: 4,
    minScore: 0.55,
  });
  const citations = (retrieved.results || []).map((row) => ({
    source_type: row.source_type,
    source_id: row.source_id,
    label: truncate(row.content, 160),
    similarity: Number(row.similarity || 0).toFixed(3),
    signed_at: row.signed_at,
  }));
  const evidencePackage = (retrieved.results || []).map((row, idx) =>
    `[${idx + 1}] ${row.source_type}/${row.source_id}: ${truncate(row.content, 600)}`
  ).join('\n\n');

  const systemPrompt = [
    'You are a patient-facing assistant that answers questions STRICTLY from the evidence snippets below.',
    'You never give clinical advice, diagnoses, or treatment decisions.',
    'If the question implies a clinical decision (should I take this medicine? is this dangerous?), politely redirect to the care team.',
    'If the answer is not supported by the snippets, say you cannot find that in the record.',
    'Quote facts directly. Do not generalise. Do not invent dates, dosages, or lab values.',
    'Always return a short plain-language answer (<= 150 words) followed by a bulleted list of citation numbers you used.',
  ].join('\n');
  const userPrompt = evidencePackage
    ? `Patient question: ${message}\n\nEvidence snippets from the patient's own record:\n${evidencePackage}`
    : `Patient question: ${message}\n\nNo evidence snippets available. Respond that the record doesn't contain relevant information.`;

  const aiResult = await generateClinicalText({
    systemPrompt,
    userPrompt,
    taskType: 'patient_record_chatbot',
    tenantRegion: req.tenant?.region || null,
    tenantId,
  });

  const replyText = aiResult.text && String(aiResult.text).trim()
    ? String(aiResult.text).trim()
    : 'I could not find relevant information in your record. Please talk to your care team for clinical questions.';

  // PHI-leak defense — reply must not mention any identifier not in the
  // citations or evidence snippets.
  const leakFlags = detectPhiLeaks({
    draft: { response: replyText },
    citations,
    context: { evidence: evidencePackage, question: message },
  });

  const hasCritical = leakFlags.some((flag) => flag.severity === 'critical');
  const persistedReply = hasCritical
    ? 'I couldn\'t generate a safe response to that question. Please talk to your care team.'
    : replyText;

  await persistMessage({
    tenantId,
    conversationId: conv.id,
    role: 'assistant',
    content: persistedReply,
    citations,
    safetyFlags: leakFlags,
    provider: aiResult.provider || 'template',
    model: aiResult.model || null,
    tokenUsage: aiResult.usage || {},
  });

  return {
    conversation_id: conv.id,
    reply: persistedReply,
    citations,
    safety_flags: leakFlags,
    blocked: hasCritical,
    provider: aiResult.provider || 'template',
    used_ai: Boolean(aiResult.usedAi),
    module_key: 'patient_record_chatbot',
  };
}

export async function listMessages({ req, conversationId, limit = 50 } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const patientUid = req?.user?.uid;
  await assertOwnership({ conversationId, tenantId, patientUid, role: req?.user?.role });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, role, content, citations, safety_flags, provider, model, created_at
     FROM patient_chat_messages
     WHERE conversation_id = $1
       AND tenant_id = $2::uuid
     ORDER BY created_at ASC
     LIMIT $3`,
    Number.parseInt(conversationId, 10),
    tenantId,
    safeLimit
  );
  return { messages: rows, count: rows.length };
}

export async function listMyConversations({ req, limit = 20 } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  if (!req?.user?.uid) throw AppError.unauthorized('authentication required');
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, title, started_at, last_message_at, status, message_count
     FROM patient_chat_conversations
     WHERE tenant_id = $1::uuid
       AND patient_uid = $2::uuid
     ORDER BY last_message_at DESC
     LIMIT $3`,
    tenantId,
    req.user.uid,
    safeLimit
  );
  return { conversations: rows, count: rows.length };
}

export default {
  listMessages,
  listMyConversations,
  sendMessage,
  startConversation,
};
