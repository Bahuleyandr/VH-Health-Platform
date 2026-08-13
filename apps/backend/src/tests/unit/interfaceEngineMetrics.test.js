import {
  observeInterfaceOutboundInFlight,
  recordInterfaceOutboundAttempt,
  recordInterfaceOutboundClaims,
  recordInterfaceReplayMessages,
  recordInterfaceSourceRejection,
  serializeInterfaceEngineMetrics,
} from '../../observability/interfaceEngineMetrics.js';

describe('interface-engine metrics', () => {
  test('exports bounded runtime, replay, claim and source-policy signals', () => {
    recordInterfaceOutboundAttempt('accepted');
    recordInterfaceOutboundClaims('leased', 2);
    recordInterfaceReplayMessages('queued', 3);
    recordInterfaceSourceRejection('inactive_source');
    observeInterfaceOutboundInFlight('00000000-0000-4000-8000-000000000001', 4);

    const metrics = serializeInterfaceEngineMetrics();
    expect(metrics).toContain('interface_engine_outbound_attempts_total{outcome="accepted"} 1');
    expect(metrics).toContain('interface_engine_outbound_claims_total{result="leased"} 2');
    expect(metrics).toContain('interface_engine_replay_messages_total{result="queued"} 3');
    expect(metrics).toContain('interface_engine_inbound_source_rejections_total{reason="inactive_source"} 1');
    expect(metrics).toContain(
      'interface_engine_outbound_in_flight{tenant_id="00000000-0000-4000-8000-000000000001"} 4',
    );
  });
});
