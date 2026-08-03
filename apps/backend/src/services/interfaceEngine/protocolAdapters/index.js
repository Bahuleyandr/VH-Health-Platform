import { AppError } from '../../../utils/AppError.js';
import csvAdapter from './csvAdapter.js';
import hl7v2Adapter from './hl7v2Adapter.js';

const adapters = new Map([
  ['hl7v2', hl7v2Adapter],
  ['csv', csvAdapter],
]);

export const IMPLEMENTED_I05_PROTOCOLS = Object.freeze([...adapters.keys()]);

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

export default Object.freeze({
  implementedProtocols: IMPLEMENTED_I05_PROTOCOLS,
  require: requireI05ProtocolAdapter,
});
