import type { WorkflowNode } from './schema';

/**
 * Kahn's algorithm topological sort.
 * Returns nodes in a valid execution order (all dependencies before dependents).
 * Throws if a cycle is detected (loader already validates, this is a safety net).
 */
export function topoSort(nodes: WorkflowNode[]): WorkflowNode[] {
  const nodeMap = new Map<string, WorkflowNode>(nodes.map(n => [n.id, n]));
  const inDegree = new Map<string, number>(nodes.map(n => [n.id, 0]));
  const dependents = new Map<string, string[]>(nodes.map(n => [n.id, []]));

  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      dependents.get(dep)!.push(node.id);
    }
  }

  const queue: string[] = nodes
    .filter(n => (inDegree.get(n.id) ?? 0) === 0)
    .map(n => n.id);
  const result: WorkflowNode[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(nodeMap.get(id)!);
    for (const dependent of dependents.get(id) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  if (result.length !== nodes.length) {
    throw new Error('Cycle detected in workflow DAG');
  }
  return result;
}
