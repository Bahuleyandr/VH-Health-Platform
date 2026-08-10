export function classifyStatusSet(codes) {
  const normalized = codes.filter((code) => Number.isFinite(code));
  const has5xx = normalized.some((code) => code >= 500 && code < 600);
  const hasNon5xx = normalized.some((code) => code < 500 || code >= 600);
  const has2xx = normalized.some((code) => code >= 200 && code < 300);
  const hasAuthFailure = normalized.some((code) => code === 401 || code === 403);

  return {
    mixesServerFailure: has5xx && hasNon5xx,
    mixesAuthOutcome: has2xx && hasAuthFailure,
  };
}
