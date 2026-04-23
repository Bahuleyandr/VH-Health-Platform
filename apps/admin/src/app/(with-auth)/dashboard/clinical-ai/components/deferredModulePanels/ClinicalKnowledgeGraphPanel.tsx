"use client";

// Phase-2 clinical-AI panel. Tracker row 36 — clinical_knowledge_graph.
// Three-tier module:
//   Top (grid)  — nodes (list + upsert)
//                 edges (list + upsert)
//   Bottom      — health reports (evaluate + list + decide via shared queue)
//
// Backend routes (apps/backend/src/routes/admin/clinicalAiRoutes.js):
//   POST  /admin/clinical-ai/knowledge-graph/nodes              upsertNode
//   GET   /admin/clinical-ai/knowledge-graph/nodes              listNodes
//   POST  /admin/clinical-ai/knowledge-graph/edges              upsertEdge
//   GET   /admin/clinical-ai/knowledge-graph/edges              listEdges
//   POST  /admin/clinical-ai/knowledge-graph/health/evaluate    evaluateGraphHealth
//   GET   /admin/clinical-ai/knowledge-graph/health/reports     listGraphHealthReports
//   PATCH /admin/clinical-ai/knowledge-graph/health/reports/:id decideGraphHealthReport
// Service: apps/backend/src/services/ai/clinicalKnowledgeGraphService.js

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Network, PlayCircle, Save, Share2 } from "lucide-react";
import { toast } from "react-hot-toast";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  severityBadgeClass,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
} from "../ClinicalAIReviewQueue";
import {
  decideClinicalAi,
  evaluateClinicalAi,
  listClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

// ---------------------------------------------------------------------------
// Reference data mirrors NODE_TYPES / EDGE_TYPES / HEALTH_STATES in
// clinicalKnowledgeGraphService.js.
// ---------------------------------------------------------------------------
const NODE_TYPES = [
  "patient",
  "diagnosis",
  "medication",
  "lab",
  "procedure",
  "provider",
  "encounter",
  "payer",
  "organization",
] as const;

const EDGE_TYPES = [
  "has_diagnosis",
  "prescribed",
  "ordered",
  "performed_by",
  "administered_to",
  "attributed_to",
  "covered_by",
  "affiliated_with",
  "belongs_to_encounter",
  "treats",
  "contraindicates",
  "indicates",
  "related_to",
  "caused_by",
] as const;

const HEALTH_STATES = [
  "healthy",
  "watch",
  "degraded",
  "critical",
  "unknown",
] as const;

const SEVERITIES = ["critical", "high", "moderate", "low", "unknown"] as const;

const MODULE_KEY = "clinical_knowledge_graph";
const NODES_PATH = "/admin/clinical-ai/knowledge-graph/nodes";
const EDGES_PATH = "/admin/clinical-ai/knowledge-graph/edges";
const HEALTH_EVALUATE_PATH = "/admin/clinical-ai/knowledge-graph/health/evaluate";
const HEALTH_REPORTS_PATH = "/admin/clinical-ai/knowledge-graph/health/reports";

type GraphHealthDecision = "accepted" | "deferred" | "rejected" | "edited";

type NodeType = (typeof NODE_TYPES)[number];
type EdgeType = (typeof EDGE_TYPES)[number];

type GraphNodeRow = {
  id: number;
  node_type: NodeType;
  node_key: string;
  display_name: string | null;
  source: string | null;
  source_ref: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type GraphEdgeRow = {
  id: number;
  edge_type: EdgeType;
  from_node_id: number | null;
  to_node_id: number | null;
  source: string | null;
  source_ref: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type GraphHealthRow = {
  id: number;
  node_count: number;
  edge_count: number;
  orphan_node_count: number;
  missing_critical_edge_count: number;
  contradiction_count: number;
  stale_node_count: number;
  completeness_pct: number;
  overall_health: string;
  severity: string;
  summary: string | null;
  reviewer_decision: string;
  created_at: string | null;
};

type NodeListResult = { nodes?: GraphNodeRow[]; count?: number };
type EdgeListResult = { edges?: GraphEdgeRow[]; count?: number };

type NodeUpsertPayload = {
  node_type: NodeType;
  node_key: string;
  display_name?: string | null;
  source?: string | null;
  source_ref?: string | null;
};

type EdgeUpsertPayload = {
  edge_type: EdgeType;
  from_node_id: number;
  to_node_id: number;
  source?: string | null;
  source_ref?: string | null;
};

// ---------------------------------------------------------------------------
// Shared invalidation helper for the whole module key.
// ---------------------------------------------------------------------------
function useInvalidateModule() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["clinical-ai", MODULE_KEY] });
    queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
  };
}

// ---------------------------------------------------------------------------
// Tier 1a: nodes list + upsert.
// ---------------------------------------------------------------------------
function KnowledgeGraphNodesSection() {
  const invalidate = useInvalidateModule();
  const [typeFilter, setTypeFilter] = useState<string>("");

  const nodes = useQuery({
    queryKey: ["clinical-ai", MODULE_KEY, "nodes", typeFilter],
    queryFn: () => {
      const params: Record<string, unknown> = { limit: 50 };
      if (typeFilter) params.node_type = typeFilter;
      return listClinicalAi(NODES_PATH, params) as Promise<
        NodeListResult & { count: number }
      >;
    },
  });

  const [nodeType, setNodeType] = useState<NodeType>(NODE_TYPES[0]);
  const [nodeKey, setNodeKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [source, setSource] = useState("");

  const upsert = useMutation({
    mutationFn: (payload: NodeUpsertPayload) =>
      evaluateClinicalAi(NODES_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Node upserted");
      invalidate();
      setNodeKey("");
      setDisplayName("");
      setSource("");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to save node"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = nodeKey.trim();
    if (!key) {
      toast.error("node_key is required");
      return;
    }
    upsert.mutate({
      node_type: nodeType,
      node_key: key,
      display_name: displayName.trim() || null,
      source: source.trim() || null,
    });
  };

  const rows = nodes.data?.nodes ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Share2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">Nodes</h3>
        </div>
        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-xs"
          aria-label="Filter by node type"
        >
          <option value="">All types</option>
          {NODE_TYPES.map((value) => (
            <option key={value} value={value}>
              {readableKey(value)}
            </option>
          ))}
        </select>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border bg-card p-3"
      >
        <div className="grid gap-2 md:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Node type</span>
            <select
              value={nodeType}
              onChange={(event) => setNodeType(event.target.value as NodeType)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {NODE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {readableKey(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Node key *</span>
            <input
              value={nodeKey}
              onChange={(event) => setNodeKey(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="e.g. icd10:E11.9"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Source</span>
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="CPIC, ICD-10, ..."
            />
          </label>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={upsert.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {upsert.isPending ? "Saving…" : "Save node"}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                ID
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Type
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Key / name
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Source
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {nodes.isLoading ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-sm text-slate-500"
                  colSpan={5}
                >
                  Loading…
                </td>
              </tr>
            ) : nodes.isError ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-sm text-red-600"
                  colSpan={5}
                >
                  {(nodes.error as Error)?.message || "Failed to load nodes"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-sm text-slate-500"
                  colSpan={5}
                >
                  No nodes recorded
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                  <td className="px-3 py-2 text-xs">
                    {readableKey(row.node_type)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs">{row.node_key}</div>
                    {row.display_name ? (
                      <div className="text-xs text-muted-foreground">
                        {row.display_name}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs">{row.source ?? "-"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {fmt(row.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tier 1b: edges list + upsert.
// ---------------------------------------------------------------------------
function KnowledgeGraphEdgesSection() {
  const invalidate = useInvalidateModule();
  const [typeFilter, setTypeFilter] = useState<string>("");

  const edges = useQuery({
    queryKey: ["clinical-ai", MODULE_KEY, "edges", typeFilter],
    queryFn: () => {
      const params: Record<string, unknown> = { limit: 50 };
      if (typeFilter) params.edge_type = typeFilter;
      return listClinicalAi(EDGES_PATH, params) as Promise<
        EdgeListResult & { count: number }
      >;
    },
  });

  const [edgeType, setEdgeType] = useState<EdgeType>(EDGE_TYPES[0]);
  const [fromNodeId, setFromNodeId] = useState("");
  const [toNodeId, setToNodeId] = useState("");
  const [source, setSource] = useState("");

  const upsert = useMutation({
    mutationFn: (payload: EdgeUpsertPayload) =>
      evaluateClinicalAi(EDGES_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Edge upserted");
      invalidate();
      setFromNodeId("");
      setToNodeId("");
      setSource("");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to save edge"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fromId = Number.parseInt(fromNodeId.trim(), 10);
    const toId = Number.parseInt(toNodeId.trim(), 10);
    if (!Number.isFinite(fromId) || fromId < 1) {
      toast.error("from_node_id must be a positive integer");
      return;
    }
    if (!Number.isFinite(toId) || toId < 1) {
      toast.error("to_node_id must be a positive integer");
      return;
    }
    upsert.mutate({
      edge_type: edgeType,
      from_node_id: fromId,
      to_node_id: toId,
      source: source.trim() || null,
    });
  };

  const rows = edges.data?.edges ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">Edges</h3>
        </div>
        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-xs"
          aria-label="Filter by edge type"
        >
          <option value="">All types</option>
          {EDGE_TYPES.map((value) => (
            <option key={value} value={value}>
              {readableKey(value)}
            </option>
          ))}
        </select>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border bg-card p-3"
      >
        <div className="grid gap-2 md:grid-cols-2">
          <label className="space-y-1 text-xs md:col-span-2">
            <span className="text-muted-foreground">Edge type</span>
            <select
              value={edgeType}
              onChange={(event) => setEdgeType(event.target.value as EdgeType)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {EDGE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {readableKey(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">From node ID *</span>
            <input
              value={fromNodeId}
              onChange={(event) => setFromNodeId(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">To node ID *</span>
            <input
              value={toNodeId}
              onChange={(event) => setToNodeId(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1 text-xs md:col-span-2">
            <span className="text-muted-foreground">Source</span>
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={upsert.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {upsert.isPending ? "Saving…" : "Save edge"}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                ID
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Type
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                From → To
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Source
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {edges.isLoading ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-sm text-slate-500"
                  colSpan={5}
                >
                  Loading…
                </td>
              </tr>
            ) : edges.isError ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-sm text-red-600"
                  colSpan={5}
                >
                  {(edges.error as Error)?.message || "Failed to load edges"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-sm text-slate-500"
                  colSpan={5}
                >
                  No edges recorded
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                  <td className="px-3 py-2 text-xs">
                    {readableKey(row.edge_type)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.from_node_id ?? "-"} → {row.to_node_id ?? "-"}
                  </td>
                  <td className="px-3 py-2 text-xs">{row.source ?? "-"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {fmt(row.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tier 2: graph health evaluate form + shared decide queue.
// ---------------------------------------------------------------------------
function GraphHealthEvaluateForm() {
  const invalidate = useInvalidateModule();
  const [stalenessDays, setStalenessDays] = useState("365");
  const [today, setToday] = useState("");

  const evaluate = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      const parsed = Number.parseInt(stalenessDays.trim(), 10);
      if (Number.isFinite(parsed)) body.staleness_days = parsed;
      if (today) body.today = today;
      return evaluateClinicalAi(HEALTH_EVALUATE_PATH, body);
    },
    onSuccess: () => {
      toast.success("Graph health evaluated");
      invalidate();
    },
    onError: (err: Error) =>
      toast.error(err.message || "Graph health evaluation failed"),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        evaluate.mutate();
      }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Staleness days</span>
          <input
            value={stalenessDays}
            onChange={(event) => setStalenessDays(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Reference date (optional)</span>
          <input
            type="date"
            value={today}
            onChange={(event) => setToday(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={evaluate.isPending}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {evaluate.isPending ? "Evaluating…" : "Evaluate"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Health report decide queue config.
// ---------------------------------------------------------------------------
const HEALTH_FILTERS: FilterSpec[] = [
  {
    key: "overall_health",
    label: "Overall",
    kind: "select",
    options: HEALTH_STATES.map((value) => ({
      value,
      label: readableKey(value),
    })),
  },
  {
    key: "severity",
    label: "Severity",
    kind: "select",
    options: SEVERITIES.map((value) => ({ value, label: readableKey(value) })),
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: [
      { value: "pending", label: "Pending" },
      { value: "accepted", label: "Accepted" },
      { value: "deferred", label: "Deferred" },
      { value: "rejected", label: "Rejected" },
      { value: "edited", label: "Edited" },
    ],
  },
];

const HEALTH_COLUMNS: ColumnSpec<GraphHealthRow>[] = [
  {
    key: "overall",
    header: "Overall",
    render: (row) => (
      <div>
        <div className="font-medium">{readableKey(row.overall_health)}</div>
        {row.summary ? (
          <div className="text-xs text-muted-foreground">{row.summary}</div>
        ) : null}
      </div>
    ),
  },
  {
    key: "severity",
    header: "Severity",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.severity)}`}
      >
        {row.severity || "unknown"}
      </span>
    ),
  },
  {
    key: "counts",
    header: "Nodes / Edges",
    render: (row) => (
      <div className="text-xs">
        <div>{row.node_count} nodes</div>
        <div className="text-muted-foreground">{row.edge_count} edges</div>
      </div>
    ),
  },
  {
    key: "orphans",
    header: "Orphans",
    render: (row) => row.orphan_node_count,
  },
  {
    key: "missing_edges",
    header: "Missing edges",
    render: (row) => row.missing_critical_edge_count,
  },
  {
    key: "contradictions",
    header: "Contradictions",
    render: (row) => row.contradiction_count,
  },
  {
    key: "completeness",
    header: "Completeness",
    render: (row) => `${row.completeness_pct.toFixed(1)}%`,
  },
  {
    key: "decision",
    header: "Review status",
    render: (row) => (
      <span className="text-xs">{readableKey(row.reviewer_decision)}</span>
    ),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const HEALTH_DECIDE_ACTIONS: DecideAction<GraphHealthDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
  { value: "edited", label: "Mark edited", variant: "muted", promptForNote: true },
];

// ---------------------------------------------------------------------------
// Top-level composite panel.
// ---------------------------------------------------------------------------
export default function ClinicalKnowledgeGraphPanel() {
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2">
        <Network className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Clinical Knowledge Graph</h2>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <KnowledgeGraphNodesSection />
        <KnowledgeGraphEdgesSection />
      </div>

      <ClinicalAIReviewQueue<GraphHealthRow, GraphHealthDecision>
        title="Graph Health Reports"
        moduleKey={MODULE_KEY}
        icon={<Network className="h-4 w-4" />}
        description="Evaluate the knowledge graph to draft an overall-health recommendation, then review and decide."
        listFn={(params) => listClinicalAi(HEALTH_REPORTS_PATH, params)}
        rowsKey="reports"
        decideFn={(id, decision, note) =>
          decideClinicalAi(HEALTH_REPORTS_PATH, id, decision, note)
        }
        filters={HEALTH_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={HEALTH_COLUMNS}
        decideActions={HEALTH_DECIDE_ACTIONS}
        evaluateForm={<GraphHealthEvaluateForm />}
        emptyState="No graph health reports pending review"
      />
    </section>
  );
}
