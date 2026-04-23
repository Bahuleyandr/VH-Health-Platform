import {
  normalizeNodeType,
  normalizeEdgeType,
  nodeMatchKey,
  computeOrphanNodes,
  computeMissingCriticalEdges,
  detectContradictions,
  detectStaleNodes,
  computeCompleteness,
  classifyGraphHealth,
  escalateGraphHealth,
  escalateSeverity,
  buildGraphActions,
  summarizeGraphHealth,
} from '../../services/ai/clinicalKnowledgeGraphService.js';

describe('clinical knowledge graph helpers', () => {
  describe('normalizeNodeType', () => {
    it('lowercases and trims a valid node type', () => {
      expect(normalizeNodeType('Patient')).toBe('patient');
    });

    it('throws badRequest for an unknown node type', () => {
      expect(() => normalizeNodeType('bogus')).toThrow();
    });
  });

  describe('normalizeEdgeType', () => {
    it('accepts a canonical edge type', () => {
      expect(normalizeEdgeType('has_diagnosis')).toBe('has_diagnosis');
    });

    it('throws for an unknown edge type', () => {
      expect(() => normalizeEdgeType('not_a_real_edge')).toThrow();
    });
  });

  describe('nodeMatchKey', () => {
    it('composes a type:key dedupe key', () => {
      expect(nodeMatchKey({ node_type: 'patient', node_key: 'p1' })).toBe('patient:p1');
    });
  });

  describe('computeOrphanNodes', () => {
    it('flags non-anchor nodes with no edges as orphan (patient is anchor)', () => {
      const result = computeOrphanNodes({
        nodes: [
          { id: 1, node_type: 'diagnosis', node_key: 'j189' },
          { id: 2, node_type: 'patient', node_key: 'p1' },
        ],
        edges: [],
      });
      expect(result.count).toBe(1);
      expect(result.orphan_nodes).toEqual([
        expect.objectContaining({ id: 1, node_type: 'diagnosis', node_key: 'j189' }),
      ]);
      expect(result.orphan_nodes.find((n) => n.id === 2)).toBeUndefined();
    });

    it('does not flag a node that has an outgoing edge', () => {
      const result = computeOrphanNodes({
        nodes: [{ id: 1, node_type: 'diagnosis', node_key: 'j189' }],
        edges: [{ from_node_id: 1, to_node_id: 2, edge_type: 'related_to' }],
      });
      expect(result.count).toBe(0);
    });
  });

  describe('computeMissingCriticalEdges', () => {
    it('flags a medication that has no prescribed edge incoming', () => {
      const result = computeMissingCriticalEdges({
        nodes: [{ id: 1, node_type: 'medication', node_key: 'amox' }],
        edges: [],
      });
      expect(result.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('detectContradictions', () => {
    it('detects treats + contraindicates on the same (from, to) pair', () => {
      const result = detectContradictions({
        edges: [
          { id: 1, from_node_id: 1, to_node_id: 2, edge_type: 'treats' },
          { id: 2, from_node_id: 1, to_node_id: 2, edge_type: 'contraindicates' },
        ],
      });
      expect(result.count).toBe(1);
    });
  });

  describe('detectStaleNodes', () => {
    it('flags a diagnosis last updated more than stalenessDays ago', () => {
      const oldIso = new Date(Date.now() - 400 * 86400000).toISOString();
      const result = detectStaleNodes({
        nodes: [{ id: 1, node_type: 'diagnosis', updated_at: oldIso }],
        today: new Date().toISOString(),
        stalenessDays: 365,
      });
      expect(result.count).toBe(1);
    });

    it('excludes patient nodes from staleness (people are anchors)', () => {
      const oldIso = new Date(Date.now() - 400 * 86400000).toISOString();
      const result = detectStaleNodes({
        nodes: [{ id: 1, node_type: 'patient', updated_at: oldIso }],
        today: new Date().toISOString(),
        stalenessDays: 365,
      });
      expect(result.count).toBe(0);
    });
  });

  describe('computeCompleteness', () => {
    it('returns 100 when there are no missing edges or orphans', () => {
      expect(
        computeCompleteness({
          nodeCount: 100,
          edgeCount: 50,
          missingCriticalEdgeCount: 0,
          orphanNodeCount: 0,
        })
      ).toBe(100.00);
    });

    it('returns a value between 0 and 100 (exclusive) when there are penalties', () => {
      const pct = computeCompleteness({
        nodeCount: 100,
        edgeCount: 50,
        missingCriticalEdgeCount: 10,
        orphanNodeCount: 5,
      });
      expect(pct).toBeLessThan(100);
      expect(pct).toBeGreaterThan(0);
    });
  });

  describe('classifyGraphHealth', () => {
    it('returns healthy/low when the graph has no anomalies', () => {
      const result = classifyGraphHealth({
        nodeCount: 100,
        edgeCount: 100,
        orphanNodeCount: 0,
        missingCriticalEdgeCount: 0,
        contradictionCount: 0,
        staleNodeCount: 0,
        completenessPct: 100,
      });
      expect(result.overall_health).toBe('healthy');
      expect(result.severity).toBe('low');
    });

    it('returns critical/critical when contradictions are present', () => {
      const result = classifyGraphHealth({
        nodeCount: 100,
        edgeCount: 100,
        orphanNodeCount: 0,
        missingCriticalEdgeCount: 0,
        contradictionCount: 2,
        staleNodeCount: 0,
        completenessPct: 90,
      });
      expect(result.overall_health).toBe('critical');
      expect(result.severity).toBe('critical');
    });

    it('returns watch/moderate when orphan counts and missing edges are moderate', () => {
      const result = classifyGraphHealth({
        nodeCount: 100,
        edgeCount: 100,
        orphanNodeCount: 3,
        missingCriticalEdgeCount: 2,
        contradictionCount: 0,
        staleNodeCount: 20,
        completenessPct: 85,
      });
      expect(result.overall_health).toBe('watch');
      expect(result.severity).toBe('moderate');
    });

    it('returns degraded/high at low completeness or high stale counts', () => {
      const result = classifyGraphHealth({
        nodeCount: 100,
        edgeCount: 30,
        orphanNodeCount: 40,
        missingCriticalEdgeCount: 5,
        contradictionCount: 0,
        staleNodeCount: 60,
        completenessPct: 55,
      });
      expect(result.overall_health).toBe('degraded');
      expect(result.severity).toBe('high');
    });

    it('returns unknown with EMPTY_GRAPH signal when there are no nodes', () => {
      const result = classifyGraphHealth({
        nodeCount: 0,
        edgeCount: 0,
        orphanNodeCount: 0,
        missingCriticalEdgeCount: 0,
        contradictionCount: 0,
        staleNodeCount: 0,
        completenessPct: 100,
      });
      expect(result.overall_health).toBe('unknown');
      expect(result.signals.some((s) => s.code === 'EMPTY_GRAPH')).toBe(true);
    });
  });

  describe('escalateGraphHealth', () => {
    it('returns the worst state from the list', () => {
      expect(escalateGraphHealth(['healthy', 'watch', 'degraded'])).toBe('degraded');
    });
  });

  describe('escalateSeverity', () => {
    it('escalates critical over other severities', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('buildGraphActions', () => {
    it('always ends with the data-engineer review disclaimer', () => {
      const actions = buildGraphActions({
        overallHealth: 'critical',
        severity: 'critical',
        signals: [{ code: 'CONTRADICTIONS_OR_MASSIVE_MISSING_EDGES' }],
      });
      const disclaimer =
        'Data engineer review required — decision support only; the graph itself is never modified by this service.';
      expect(actions).toContain(disclaimer);
    });
  });

  describe('summarizeGraphHealth', () => {
    it('embeds the overall_health value and the completeness percentage', () => {
      const text = summarizeGraphHealth({
        nodeCount: 100,
        edgeCount: 100,
        overallHealth: 'healthy',
        severity: 'low',
        completenessPct: 100,
      });
      expect(text).toContain('healthy');
      expect(text).toContain('100');
    });
  });
});
