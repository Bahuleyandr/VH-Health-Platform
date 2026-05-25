type ApprovalLike = {
  approval_type?: string | null;
  payload?: Record<string, unknown> | null;
};

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function compactValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "inherit";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function approvalDetailLines(approval: ApprovalLike) {
  const payload = approval.payload || {};
  const lines: string[] = [];
  const changedFields = asStringArray(payload.changed_fields);

  if (payload.scope) lines.push(`Scope: ${String(payload.scope)}`);
  if (changedFields.length) lines.push(`Changes: ${changedFields.join(", ")}`);

  if (changedFields.length && payload.next && typeof payload.next === "object") {
    const next = payload.next as Record<string, unknown>;
    const nextValues = changedFields
      .map((field) => `${field}=${compactValue(next[field])}`)
      .join(", ");
    if (nextValues) lines.push(`Requested: ${nextValues}`);
  }

  const reasons = asStringArray(payload.reasons);
  if (reasons.length) lines.push(`Gate: ${reasons.join(", ")}`);

  if (payload.eval_gate && typeof payload.eval_gate === "object") {
    const evalGate = payload.eval_gate as Record<string, unknown>;
    const provider = compactValue(evalGate.provider);
    const model = compactValue(evalGate.model);
    const run = evalGate.eval_run_id ? ` run #${evalGate.eval_run_id}` : "";
    lines.push(`Eval: ${provider}/${model}${run}`);
  }

  if (payload.requested_change_hash) {
    lines.push(`Hash: ${String(payload.requested_change_hash).slice(0, 12)}`);
  }

  return lines;
}
