#!/usr/bin/env node
// Persistent mock Ollama daemon for the Clinical AI rollout-preflight smoke.
//
// The preflight's deep-tier liveness gate (checkDeepModuleReadiness ->
// probeModelPulled in apps/backend/src/services/ai/localLlmClient.js) does a
// live `GET /api/tags` against CLINICAL_AI_DEEP_BASE_URL and asserts the
// configured deep model is present. In CI there is no GPU/Ollama, and the
// local-Ollama smoke's own mock is start/stopped within that step, so by the
// time the preflight runs the port is dead -> `deep_module_not_live: fetch
// failed`. This serves a stable /api/tags (advertising the configured model)
// so the readiness probe passes, letting the smoke run strict
// (`-RequireNoWarnings`). It also answers /api/generate so anything that
// generates during the window gets a deterministic deep-tier draft.
//
// Unlike the in-step mock, this stays up until the job ends (started
// backgrounded in its own CI step AFTER the local-Ollama smoke frees the port).
//
// Usage: node scripts/mock-ollama-readiness-server.mjs [port] [model]
//   env: MOCK_OLLAMA_PORT, MOCK_OLLAMA_MODEL (override the positional args)

import http from 'node:http';

const PORT = Number(process.env.MOCK_OLLAMA_PORT || process.argv[2] || 11534);
const MODEL =
  process.env.MOCK_OLLAMA_MODEL ||
  process.argv[3] ||
  'llama3.1:70b-instruct-q4_K_M';

const draft = {
  continue: [
    {
      medication: 'amlodipine',
      dose: '5 mg',
      rationale: 'Continue documented home antihypertensive pending clinician review.',
    },
  ],
  stop: [],
  change: [],
  safety_flags: [],
  source_citations: [],
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: MODEL }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          response: JSON.stringify(draft),
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 31,
          eval_count: 19,
          total_duration: 420000000,
        })
      );
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  // Sentinel the CI step greps for before proceeding to the preflight.
  console.log(`mock-ollama-readiness-ready:${PORT}`);
});
