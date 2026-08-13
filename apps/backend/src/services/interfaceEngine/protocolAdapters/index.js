import { AppError } from '../../../utils/AppError.js';
import csvAdapter from './csvAdapter.js';
import fhirJsonAdapter from './fhirJsonAdapter.js';
import hl7v2Adapter from './hl7v2Adapter.js';
import jsonAdapter from './jsonAdapter.js';
import otherAdapter from './otherAdapter.js';

const adapters = new Map([
  ['hl7v2', hl7v2Adapter],
  ['csv', csvAdapter],
  ['json', jsonAdapter],
  ['fhir_json', fhirJsonAdapter],
  ['other', otherAdapter],
]);

export const IMPLEMENTED_I05_PROTOCOLS = Object.freeze([...adapters.keys()]);

// The CANONICAL backend adapters — the ones whose `deliverBackendTx` records a
// real accepted delivery rather than a preview. A protocol with an empty list
// has no adapter capable of a clinical effect, so an inbound version cannot
// truthfully be activated for it at all.
//
// Audit 2026-08-13: inbound activation refused only the literal preview key
// (`assertVersionRuntimeReady`, and the same single-key test inside migration
// 665's two activation triggers). Everything else passed. That let an operator
// activate an `http_inbound` channel whose version named an adapter key no
// adapter implements — every message then died at `deliver_backend` with
// INTEROP_BACKEND_ADAPTER_UNREGISTERED — or named no adapter at all, in which
// case ingestion silently stopped at `transformed` and the ingress answered
// 409 forever. Since hl7v2 is the only protocol `http_inbound` may carry
// (runtimePolicy.ACTIVE_CONNECTOR_PROTOCOLS) and its only registered backend
// adapter is the FORBIDDEN preview adapter, there is no configuration of an
// inbound channel that can actually deliver. Activation must therefore be
// refused rather than approved into a state that cannot work.
export const CANONICAL_BACKEND_ADAPTER_KEYS = Object.freeze(
  Object.fromEntries(
    [...adapters.entries()].map(([protocol, adapter]) => [
      protocol,
      Object.freeze([...(adapter.canonicalBackendAdapterKeys || [])]),
    ]),
  ),
);

export function requireI05ProtocolAdapter(protocol) {
  const normalized = String(protocol || '').trim().toLowerCase();
  const adapter = adapters.get(normalized);
  if (!adapter) {
    throw AppError.conflict(
      `${normalized || 'Unknown'} I05 protocol adapter is not implemented`,
      'INTEROP_PROTOCOL_ADAPTER_UNREGISTERED',
    );
  }
  return adapter;
}

export function canonicalBackendAdapterKeysFor(protocol) {
  const normalized = String(protocol || '').trim().toLowerCase();
  return CANONICAL_BACKEND_ADAPTER_KEYS[normalized] || Object.freeze([]);
}

// Fail-closed activation guard. Refuses when the protocol has no canonical
// backend adapter at all, when no adapter is configured, and when the
// configured key is not one an adapter actually implements.
export function assertActivatableBackendAdapter({ protocol, adapterKey } = {}) {
  requireI05ProtocolAdapter(protocol);
  const normalizedProtocol = String(protocol || '').trim().toLowerCase();
  const canonicalKeys = canonicalBackendAdapterKeysFor(normalizedProtocol);
  if (canonicalKeys.length === 0) {
    throw AppError.conflict(
      `${normalizedProtocol} has no canonical backend adapter, so inbound activation is unavailable`,
      'INTEROP_CANONICAL_BACKEND_ADAPTER_UNAVAILABLE',
    );
  }
  const cleanKey = String(adapterKey || '').trim();
  if (!cleanKey) {
    throw AppError.badRequest(
      'inbound channel versions require a canonical backend adapter',
      'INTEROP_BACKEND_ADAPTER_REQUIRED',
    );
  }
  if (!canonicalKeys.includes(cleanKey)) {
    throw AppError.badRequest(
      `Unregistered ${normalizedProtocol} backend adapter: ${cleanKey}`,
      'INTEROP_BACKEND_ADAPTER_UNREGISTERED',
    );
  }
  return cleanKey;
}

export default Object.freeze({
  implementedProtocols: IMPLEMENTED_I05_PROTOCOLS,
  canonicalBackendAdapterKeys: CANONICAL_BACKEND_ADAPTER_KEYS,
  require: requireI05ProtocolAdapter,
  assertActivatable: assertActivatableBackendAdapter,
});
