import type { WorkflowLimits } from "./types";

export type DAGValidationResult = {
  valid: boolean;
  error?: string;
};

export function detectCycle(graph: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;

    visiting.add(id);
    for (const dependencyId of graph.get(id) ?? []) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return [...graph.keys()].some(visit);
}

export function calculateDAGDepth(graph: ReadonlyMap<string, ReadonlySet<string>>): number {
  const depths = new Map<string, number>();

  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;

    const depth = Math.max(0, ...Array.from(graph.get(id) ?? [], depthOf)) + 1;
    depths.set(id, depth);
    return depth;
  };

  return Math.max(0, ...[...graph.keys()].map(depthOf));
}

export function validateDAG(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  limits: Pick<WorkflowLimits, "maxNestingDepth">,
): DAGValidationResult {
  for (const dependencies of graph.values()) {
    for (const dependencyId of dependencies) {
      if (!graph.has(dependencyId)) return { valid: false, error: `Unknown dependency: ${dependencyId}` };
    }
  }

  if (detectCycle(graph)) {
    return { valid: false, error: "Circular dependency detected in subagent graph" };
  }

  const depth = calculateDAGDepth(graph);
  if (depth > limits.maxNestingDepth) {
    return {
      valid: false,
      error: `Subagent nesting depth (${depth}) exceeds limit (${limits.maxNestingDepth})`,
    };
  }

  return { valid: true };
}
