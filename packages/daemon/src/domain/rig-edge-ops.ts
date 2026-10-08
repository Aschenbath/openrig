import type { RigRepository } from "./rig-repository.js";
import type { Edge, NodeWithBinding } from "./types.js";
import { VALID_EDGE_KINDS } from "./rigspec-schema.js";

/**
 * Add or remove one typed edge on an existing rig. The operator chooses the edge; this applies exactly that
 * change and returns a receipt naming it, so a repeat is a no-op and the rollback removes only what was added.
 * It changes the edges table and nothing else: no node, session, ID or other edge.
 */

/** The kinds that order launch and restore: delegates_to launches its source first, spawned_by its target first. */
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

export interface EdgeEnd {
  logicalId: string;
  nodeId: string;
}

export interface EdgeReceipt {
  id?: string;
  kind: string;
  from: EdgeEnd;
  to: EdgeEnd;
}

export type EdgeOpOutcome =
  | {
    ok: true;
    rigId: string;
    outcome: "would_add" | "added" | "present" | "would_remove" | "removed";
    edge: EdgeReceipt;
    /** On "added": the command that removes exactly this edge. */
    rollback?: string;
  }
  | {
    ok: false;
    code: "rig_not_found" | "node_not_found" | "invalid_kind" | "edge_cycle" | "edge_not_found" | "unavailable";
    message: string;
  };

function end(node: NodeWithBinding): EdgeEnd {
  return { logicalId: node.logicalId, nodeId: node.id };
}

function launchArc(edge: Pick<Edge, "sourceId" | "targetId" | "kind">): [first: string, then: string] {
  return edge.kind === "delegates_to" ? [edge.sourceId, edge.targetId] : [edge.targetId, edge.sourceId];
}

/** True when adding `candidate` to `edges` would make launch order cycle, which fails launch and restore. */
function createsLaunchCycle(edges: Edge[], candidate: Pick<Edge, "sourceId" | "targetId" | "kind">): boolean {
  const [first, then] = launchArc(candidate);
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (!LAUNCH_DEPENDENCY_KINDS.has(edge.kind)) continue;
    const [a, b] = launchArc(edge);
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const seen = new Set<string>();
  const queue = [then];
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (node === first) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    queue.push(...(next.get(node) ?? []));
  }
  return false;
}

export function addRigEdge(
  repo: RigRepository,
  input: { rigId: string; from: string; to: string; kind: string; plan?: boolean },
): EdgeOpOutcome {
  const rig = repo.getRig(input.rigId);
  if (!rig) return { ok: false, code: "rig_not_found", message: `rig ${input.rigId} not found` };
  if (!VALID_EDGE_KINDS.has(input.kind)) {
    return { ok: false, code: "invalid_kind", message: `kind must be one of ${[...VALID_EDGE_KINDS].join(", ")} (got "${input.kind}")` };
  }
  const from = rig.nodes.find((node) => node.logicalId === input.from);
  const to = rig.nodes.find((node) => node.logicalId === input.to);
  if (!from || !to) {
    const missing = [...new Set([from ? null : input.from, to ? null : input.to].filter((id): id is string => id !== null))];
    return { ok: false, code: "node_not_found", message: `no seat with logical id ${missing.map((id) => `'${id}'`).join(" or ")} in rig ${input.rigId}` };
  }
  const edge: EdgeReceipt = { kind: input.kind, from: end(from), to: end(to) };
  const existing = rig.edges.find((e) => e.sourceId === from.id && e.targetId === to.id && e.kind === input.kind);
  if (existing) return { ok: true, rigId: input.rigId, outcome: "present", edge: { ...edge, id: existing.id } };
  const candidate = { sourceId: from.id, targetId: to.id, kind: input.kind };
  if (LAUNCH_DEPENDENCY_KINDS.has(input.kind) && createsLaunchCycle(rig.edges, candidate)) {
    return {
      ok: false,
      code: "edge_cycle",
      message: `a ${input.kind} edge from ${input.from} to ${input.to} would make launch order cycle, and launch and restore refuse a cycle`,
    };
  }
  if (input.plan) return { ok: true, rigId: input.rigId, outcome: "would_add", edge };
  const added = repo.addEdge(input.rigId, from.id, to.id, input.kind);
  return {
    ok: true,
    rigId: input.rigId,
    outcome: "added",
    edge: { ...edge, id: added.id },
    rollback: `rig edge remove ${input.rigId} ${added.id}`,
  };
}

export function removeRigEdge(
  repo: RigRepository,
  input: { rigId: string; edgeId: string; plan?: boolean },
): EdgeOpOutcome {
  const rig = repo.getRig(input.rigId);
  if (!rig) return { ok: false, code: "rig_not_found", message: `rig ${input.rigId} not found` };
  const edge = rig.edges.find((e) => e.id === input.edgeId);
  if (!edge) return { ok: false, code: "edge_not_found", message: `no edge ${input.edgeId} in rig ${input.rigId}` };
  const node = (id: string) => rig.nodes.find((n) => n.id === id)!;
  const receipt: EdgeReceipt = { id: edge.id, kind: edge.kind, from: end(node(edge.sourceId)), to: end(node(edge.targetId)) };
  if (input.plan) return { ok: true, rigId: input.rigId, outcome: "would_remove", edge: receipt };
  repo.removeEdge(edge.id);
  return { ok: true, rigId: input.rigId, outcome: "removed", edge: receipt };
}
