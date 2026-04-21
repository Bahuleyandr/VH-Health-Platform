import logger from '../../logging/logger.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MODEL = 'llama3.1:8b';

function getProviderConfig() {
  const provider = (process.env.CLINICAL_AI_PROVIDER || process.env.AI_PROVIDER || 'template')
    .toLowerCase()
    .trim();
  const baseUrl = (process.env.CLINICAL_AI_BASE_URL || process.env.AI_SUMMARIZE_URL || '').replace(/\/$/, '');
  const model = process.env.CLINICAL_AI_MODEL || process.env.AI_SUMMARIZE_MODEL || DEFAULT_MODEL;
  const timeoutMs = Math.min(
    Math.max(parseInt(process.env.CLINICAL_AI_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS, 5_000),
    120_000
  );
  return { provider, baseUrl, model, timeoutMs };
}

function looksLikeOllama(config) {
  return config.provider === 'ollama' || config.baseUrl.includes(':11434');
}

function buildMessages({ systemPrompt, userPrompt }) {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

async function callOllama(config, prompt, systemPrompt) {
  const url = config.baseUrl.endsWith('/api/generate')
    ? config.baseUrl
    : `${config.baseUrl}/api/generate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      prompt,
      system: systemPrompt,
      stream: false,
      options: {
        temperature: 0.15,
        top_p: 0.9,
        num_predict: 2200,
      },
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return payload.response || '';
}

async function callOpenAICompatible(config, userPrompt, systemPrompt) {
  const url = config.baseUrl.endsWith('/chat/completions')
    ? config.baseUrl
    : `${config.baseUrl}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.CLINICAL_AI_API_KEY
        ? { Authorization: `Bearer ${process.env.CLINICAL_AI_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: buildMessages({ systemPrompt, userPrompt }),
      temperature: 0.15,
      max_tokens: 2200,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible endpoint returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || payload.choices?.[0]?.text || '';
}

export function getClinicalAiConfig() {
  const config = getProviderConfig();
  return {
    provider: config.provider,
    model: config.model,
    enabled: Boolean(config.baseUrl) && config.provider !== 'template',
    baseUrlConfigured: Boolean(config.baseUrl),
  };
}

export async function generateClinicalText({ systemPrompt, userPrompt, taskType }) {
  const config = getProviderConfig();
  if (!config.baseUrl || config.provider === 'template') {
    return {
      text: '',
      usedAi: false,
      provider: 'template',
      model: config.model,
      reason: 'No local clinical AI endpoint configured',
    };
  }

  try {
    const text = looksLikeOllama(config)
      ? await callOllama(config, userPrompt, systemPrompt)
      : await callOpenAICompatible(config, userPrompt, systemPrompt);

    if (!String(text || '').trim()) {
      throw new Error('Model returned empty content');
    }

    return {
      text: String(text).trim(),
      usedAi: true,
      provider: looksLikeOllama(config) ? 'ollama' : config.provider,
      model: config.model,
    };
  } catch (err) {
    logger.warn('Clinical AI generation failed; falling back to template', {
      taskType,
      provider: config.provider,
      model: config.model,
      error: err.message,
    });
    return {
      text: '',
      usedAi: false,
      provider: looksLikeOllama(config) ? 'ollama' : config.provider,
      model: config.model,
      reason: err.message,
    };
  }
}

export default {
  generateClinicalText,
  getClinicalAiConfig,
};
