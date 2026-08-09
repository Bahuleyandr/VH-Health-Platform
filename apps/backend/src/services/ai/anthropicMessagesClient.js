// src/services/ai/anthropicMessagesClient.js
//
// Shared, modernized Anthropic Messages API request shaping. Extracted from
// localLlmClient.js (PR #804's provider modernization) so every backend
// surface that talks to /v1/messages — the governed generateClinicalText
// path AND the patient triage chatbot — goes through ONE implementation of:
//
//   - `stop_reason: 'refusal'` handling: HTTP 200 refusals are surfaced as a
//     NON-retryable error carrying the PHI-free stop_details category and the
//     billed usage, instead of being mistaken for empty content.
//   - Structured outputs via `output_config.format` when a well-formed JSON
//     schema is supplied (normalizeStructuredOutputSchema below), with a
//     single plain retry when the endpoint rejects the schema with HTTP 400.
//   - Prompt caching: the stable system prompt is sent as a cacheable block
//     (`cache_control: {type:'ephemeral'}`), and usage accounting sums
//     cache_creation/cache_read input tokens so budgets stay honest.
//   - No sampling parameters: current Anthropic models (4.6-family onward)
//     reject non-default `temperature`/`top_p`/`top_k` with a 400.
//
// This module is deliberately a LEAF: it imports only the logger, so callers
// with a light load-time import graph (triageService) can depend on it
// without pulling in the metrics/prisma/module-registry graph that
// localLlmClient carries.

import logger from '../../logging/logger.js';

function safeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) || null;
}

export function anthropicVersionHeader() {
  return process.env.ANTHROPIC_VERSION || process.env.ANTHROPIC_API_VERSION || '2023-06-01';
}

function baseUsage(extra = {}) {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    provider_request_id: null,
    finish_reason: null,
    latency_ms: null,
    raw: null,
    ...extra,
  };
}

/**
 * Strip chain-of-thought / reasoning tags emitted by reasoning models.
 *
 * Pattern observed in production:
 *   - MiniMax-M2.7-highspeed wraps every reply in `<think>...</think>` before
 *     the final answer (verified 2026-05-02 via direct API call).
 *   - DeepSeek-R1, GLM-4-Plus, and several open-weight reasoning models use
 *     the same tag convention.
 *   - Anthropic + OpenAI emit reasoning tokens in a separate field, not
 *     inline in `content`, so this is a no-op for them.
 *
 * Stripping is safe on non-reasoning models — the regex simply doesn't
 * match. We strip ALL `<think>...</think>` blocks (some models emit
 * multiple) and trim residual whitespace.
 *
 * Done at extraction time so downstream JSON parsing in the explainer
 * pipelines and `safeJsonParse` see clean text.
 */
export function stripReasoningTags(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function readAnthropicText(payload) {
  return stripReasoningTags(
    (payload.content || [])
      .filter((part) => part?.type === 'text' && part.text)
      .map((part) => part.text)
      .join('')
      .trim(),
  );
}

/**
 * Conservatively normalize a JSON schema for Anthropic structured outputs
 * (`output_config.format` on /v1/messages). Structured outputs require
 * `additionalProperties: false` on every object node; we additionally require
 * every object node to declare non-empty `properties` and every `required` key
 * to exist in them, so the loose registry stubs (e.g. `{type:'object',
 * required:[...]}` with no properties) NEVER activate structured output —
 * they'd be rejected by the API and would only burn a request. Returns the
 * normalized deep copy, or null when the schema is absent/too loose to send.
 * Exported for unit tests.
 */
export function normalizeStructuredOutputSchema(schema) {
  const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'null']);
  const normalizeNode = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    if (node.type === 'object') {
      const properties = node.properties;
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
      const keys = Object.keys(properties);
      if (!keys.length) return null;
      const outProps = {};
      for (const key of keys) {
        const child = normalizeNode(properties[key]);
        if (!child) return null;
        outProps[key] = child;
      }
      const required = Array.isArray(node.required) ? node.required : [];
      if (!required.every((key) => Object.prototype.hasOwnProperty.call(outProps, key))) return null;
      return { ...node, type: 'object', properties: outProps, required, additionalProperties: false };
    }
    if (node.type === 'array') {
      const items = normalizeNode(node.items);
      if (!items) return null;
      return { ...node, items };
    }
    if (SCALAR_TYPES.has(node.type)) return { ...node };
    // anyOf/enum-only/unknown nodes: reject the whole schema rather than risk
    // sending something the endpoint refuses.
    return null;
  };
  const normalized = normalizeNode(schema);
  return normalized && normalized.type === 'object' ? normalized : null;
}

/**
 * POST a single (non-streaming) request to an Anthropic-compatible
 * /v1/messages endpoint with the modernized request shape described in the
 * module header. Returns `{ text, usage }`; `usage` carries prompt/completion
 * token totals (cache-aware), the provider request id, stop reason, and
 * latency.
 *
 * Error contract (callers rely on it — do not weaken):
 *   - HTTP failure  → Error with `.httpStatus` set (retry classification is
 *     the caller's concern; localLlmClient treats 429/5xx as transient).
 *   - `stop_reason: 'refusal'` → Error with `.retryable = false`,
 *     `.usage` = the billed usage, and message `anthropic_refusal[:category]`.
 *     Re-sending the same prompt cannot succeed, so this must never be
 *     retried as "empty content".
 *
 * @param {object}   opts
 * @param {string}   opts.url          full /v1/messages endpoint URL
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @param {number}   opts.maxTokens
 * @param {string}   opts.systemPrompt stable system prompt (sent cacheable)
 * @param {object[]} opts.messages     Anthropic-shaped {role, content} turns
 * @param {object}   [opts.jsonSchema] optional JSON contract; enforced via
 *                                     structured outputs when well-formed
 * @param {number}   [opts.timeoutMs]
 * @param {object}   [opts.logContext] extra PHI-free fields for warn logs
 */
export async function postAnthropicMessages({
  url,
  apiKey,
  model,
  maxTokens,
  systemPrompt,
  messages,
  jsonSchema = null,
  timeoutMs = 45_000,
  logContext = {},
}) {
  const structuredSchema = normalizeStructuredOutputSchema(jsonSchema);

  const attempt = async (withSchema) => {
    const startedAt = Date.now();
    const body = {
      model,
      max_tokens: maxTokens,
      // NOTE: no `temperature`. Current Anthropic models (4.6-family onward)
      // reject non-default sampling parameters with a 400. Determinism for
      // high-risk surfaces is carried by the prompt and, where a schema is
      // available, by structured outputs below.
      //
      // Prompt caching: system prompts are stable per prompt version, so mark
      // the system block cacheable — repeated calls against the same surface
      // reuse the cached prefix (usage parsing below already sums
      // cache_creation/cache_read token fields). Short prompts silently skip
      // caching; that is harmless.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    };
    if (withSchema) {
      body.output_config = { format: { type: 'json_schema', schema: structuredSchema } };
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': anthropicVersionHeader(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      let providerMessage = responseBody;
      try {
        providerMessage = JSON.parse(responseBody)?.error?.message || responseBody;
      } catch {
        // Anthropic-compatible proxies may return a plain-text error body.
      }
      const err = new Error(`Anthropic endpoint returned HTTP ${response.status}`);
      err.httpStatus = response.status;
      err.structuredOutputRejected = Boolean(
        withSchema
        && response.status === 400
        && /output_config|output_format|json[ _-]?schema|structured[ _-]?output|schema/i
          .test(String(providerMessage || ''))
      );
      throw err;
    }

    const payload = await response.json();
    const inputTokens = safeInt(payload.usage?.input_tokens, 0)
      + safeInt(payload.usage?.cache_creation_input_tokens, 0)
      + safeInt(payload.usage?.cache_read_input_tokens, 0);
    const outputTokens = safeInt(payload.usage?.output_tokens, 0);
    const usage = baseUsage({
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      provider_request_id: responseHeader(response, 'request-id') || payload.id || null,
      finish_reason: payload.stop_reason || null,
      latency_ms: Date.now() - startedAt,
      raw: payload.usage || null,
    });
    // Safety-classifier refusal: HTTP 200 with stop_reason 'refusal' and empty
    // (or partial) content. NON-RETRYABLE — re-sending the same prompt cannot
    // succeed, so it must not burn the transient-retry budget as "empty
    // content". The thrown reason (with the PHI-free stop_details category)
    // flows into the caller's labeled fallback path and the generation row.
    if (payload.stop_reason === 'refusal') {
      const category = payload.stop_details?.category
        ? String(payload.stop_details.category).slice(0, 60)
        : null;
      const err = new Error(category ? `anthropic_refusal:${category}` : 'anthropic_refusal');
      err.retryable = false;
      err.refusal = true;
      err.usage = usage; // refusal tokens are billed; keep them accountable
      throw err;
    }
    return { text: readAnthropicText(payload), usage };
  };

  try {
    return await attempt(Boolean(structuredSchema));
  } catch (err) {
    // Endpoint rejected the structured-output schema (e.g. an unsupported
    // constraint survived normalization). One plain retry without
    // output_config — the caller's fence-stripping JSON parser remains the
    // fallback, exactly as on providers without structured-output support.
    if (structuredSchema && err.structuredOutputRejected === true) {
      logger.warn('Anthropic rejected structured-output schema; retrying without output_config', {
        model,
        ...logContext,
      });
      return attempt(false);
    }
    throw err;
  }
}

export default {
  anthropicVersionHeader,
  normalizeStructuredOutputSchema,
  postAnthropicMessages,
  readAnthropicText,
  stripReasoningTags,
};
