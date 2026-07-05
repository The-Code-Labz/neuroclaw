/**
 * YAML workflow loader
 *
 * Parses workflow YAML files, validates with Zod, and returns typed definitions.
 * Handles node type inference (no explicit 'type' field required in YAML).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  workflowSchema,
  nodeBaseSchema,
  promptNodeSchema,
  bashNodeSchema,
  scriptNodeSchema,
  loopNodeSchema,
  approvalNodeSchema,
  commandNodeSchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from './schema';
import { logger } from '../utils/logger';

const log = logger;

// -----------------------------------------------------------------------------
// Node type inference
// -----------------------------------------------------------------------------

/**
 * Detect node type from YAML structure.
 * Looks for the distinguishing key: prompt, bash, script, loop, approval, command.
 */
function inferNodeType(raw: Record<string, unknown>): string | null {
  if ('prompt' in raw && typeof raw.prompt === 'string') return 'prompt';
  if ('bash' in raw && typeof raw.bash === 'string') return 'bash';
  if ('script' in raw && typeof raw.script === 'string') return 'script';
  if ('loop' in raw && typeof raw.loop === 'object') return 'loop';
  if ('approval' in raw && typeof raw.approval === 'object') return 'approval';
  if ('command' in raw && typeof raw.command === 'string') return 'command';
  return null;
}

/**
 * Parse and validate a single node with type inference.
 */
function parseNode(raw: unknown, index: number): WorkflowNode {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Node at index ${index} is not an object`);
  }

  const rawObj = raw as Record<string, unknown>;
  const nodeType = inferNodeType(rawObj);

  if (!nodeType) {
    throw new Error(
      `Node at index ${index} (id: ${rawObj.id ?? 'unknown'}) has no recognizable type. ` +
      `Must have one of: prompt, bash, script, loop, approval, command`
    );
  }

  // Validate base fields first
  const baseResult = nodeBaseSchema.safeParse(rawObj);
  if (!baseResult.success) {
    throw new Error(
      `Node at index ${index}: ${baseResult.error.issues.map((e: { message: string }) => e.message).join(', ')}`
    );
  }

  // Validate type-specific fields
  let result: z.ZodSafeParseResult<unknown>;

  switch (nodeType) {
    case 'prompt':
      result = promptNodeSchema.safeParse(rawObj);
      break;
    case 'bash':
      result = bashNodeSchema.safeParse(rawObj);
      break;
    case 'script':
      result = scriptNodeSchema.safeParse(rawObj);
      break;
    case 'loop':
      result = loopNodeSchema.safeParse(rawObj);
      break;
    case 'approval':
      result = approvalNodeSchema.safeParse(rawObj);
      break;
    case 'command':
      result = commandNodeSchema.safeParse(rawObj);
      break;
    default:
      throw new Error(`Unknown node type: ${nodeType}`);
  }

  if (!result.success) {
    throw new Error(
      `Node '${rawObj.id}' (${nodeType}): ${result.error.issues.map(e => `${e.path.map(String).join('.')}: ${e.message}`).join(', ')}`
    );
  }

  return { ...(result.data as object), type: nodeType } as WorkflowNode;
}

// -----------------------------------------------------------------------------
// Workflow validation
// -----------------------------------------------------------------------------

/**
 * Validate DAG structure: no cycles, all depends_on references exist.
 */
function validateDagStructure(nodes: WorkflowNode[]): void {
  const nodeIds = new Set(nodes.map(n => n.id));

  // Check for duplicate IDs
  if (nodeIds.size !== nodes.length) {
    const counts: Record<string, number> = {};
    for (const node of nodes) {
      counts[node.id] = (counts[node.id] || 0) + 1;
    }
    const duplicates = Object.entries(counts)
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
    throw new Error(`Duplicate node IDs: ${duplicates.join(', ')}`);
  }

  // Check all depends_on references exist
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!nodeIds.has(dep)) {
        throw new Error(`Node '${node.id}' depends on unknown node '${dep}'`);
      }
      if (dep === node.id) {
        throw new Error(`Node '${node.id}' cannot depend on itself`);
      }
    }
  }

  // Check for cycles using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);

    const node = nodes.find(n => n.id === nodeId)!;
    for (const dep of node.depends_on ?? []) {
      if (!visited.has(dep)) {
        if (hasCycle(dep)) return true;
      } else if (recursionStack.has(dep)) {
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      if (hasCycle(node.id)) {
        throw new Error(`Cycle detected in workflow DAG involving node '${node.id}'`);
      }
    }
  }
}

/**
 * Validate $nodeId.output references in prompts/commands point to earlier nodes.
 */
function validateOutputReferences(nodes: WorkflowNode[]): void {
  const nodeIds = new Set(nodes.map(n => n.id));
  const outputRefPattern = /\$([a-zA-Z0-9_-]+)\.(?:output|result)(?:\.[a-zA-Z0-9_]+)*/g;

  for (const node of nodes) {
    const textsToCheck: string[] = [];

    // Collect all text fields that might contain references
    if (node.type === 'prompt') {
      textsToCheck.push(node.prompt);
      if (node.system_prompt) textsToCheck.push(node.system_prompt);
    } else if (node.type === 'bash') {
      textsToCheck.push(node.bash);
    } else if (node.type === 'loop') {
      textsToCheck.push(node.loop.prompt);
    } else if (node.type === 'approval') {
      textsToCheck.push(node.approval.message);
    }

    if (node.when) {
      textsToCheck.push(node.when);
    }

    // Check each reference
    for (const text of textsToCheck) {
      let match;
      while ((match = outputRefPattern.exec(text)) !== null) {
        const refId = match[1];
        // Skip built-in variables
        if (['ARTIFACTS_DIR', 'WORKFLOW_ID', 'LOOP_PREV_OUTPUT', 'LOOP_USER_INPUT'].includes(refId)) {
          continue;
        }
        if (!nodeIds.has(refId)) {
          throw new Error(
            `Node '${node.id}' references output of unknown node '${refId}'. ` +
            `Available nodes: ${Array.from(nodeIds).join(', ')}`
          );
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface LoadWorkflowResult {
  workflow: WorkflowDefinition;
  filePath: string;
  source: 'bundled' | 'user' | 'project';
}

export interface LoadWorkflowError {
  filePath: string;
  error: string;
}

/**
 * Load and validate a workflow from a YAML file.
 */
export function loadWorkflowFromFile(
  filePath: string,
  source: 'bundled' | 'user' | 'project' = 'project'
): LoadWorkflowResult {
  const content = fs.readFileSync(filePath, 'utf-8');
  return loadWorkflowFromString(content, filePath, source);
}

/**
 * Load and validate a workflow from a YAML string.
 */
export function loadWorkflowFromString(
  yamlContent: string,
  filePath: string = '<inline>',
  source: 'bundled' | 'user' | 'project' = 'project'
): LoadWorkflowResult {
  // Parse YAML
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (err) {
    throw new Error(`YAML parse error in ${filePath}: ${(err as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${filePath}: workflow must be an object`);
  }

  const rawObj = raw as Record<string, unknown>;

  // Validate top-level schema (without nodes)
  const { nodes: rawNodes, ...rest } = rawObj;
  const baseResult = workflowSchema.omit({ nodes: true }).safeParse(rest);

  if (!baseResult.success) {
    throw new Error(
      `${filePath}: ${baseResult.error.issues.map(e => `${e.path.map(String).join('.')}: ${e.message}`).join(', ')}`
    );
  }

  // Parse nodes
  if (!Array.isArray(rawNodes)) {
    throw new Error(`${filePath}: 'nodes' must be an array`);
  }

  const nodes: WorkflowNode[] = [];
  const nodeErrors: string[] = [];

  for (let i = 0; i < rawNodes.length; i++) {
    try {
      nodes.push(parseNode(rawNodes[i], i));
    } catch (err) {
      nodeErrors.push((err as Error).message);
    }
  }

  if (nodeErrors.length > 0) {
    throw new Error(`${filePath}:\n  ${nodeErrors.join('\n  ')}`);
  }

  // Validate DAG structure
  validateDagStructure(nodes);
  validateOutputReferences(nodes);

  const workflow: WorkflowDefinition = {
    ...baseResult.data,
    nodes,
  };

  log.debug('workflow.loaded', { name: workflow.name, nodeCount: nodes.length, source });

  return { workflow, filePath, source };
}

/**
 * Try to load a workflow, returning error info instead of throwing.
 */
export function tryLoadWorkflow(
  filePath: string,
  source: 'bundled' | 'user' | 'project' = 'project'
): LoadWorkflowResult | LoadWorkflowError {
  try {
    return loadWorkflowFromFile(filePath, source);
  } catch (err) {
    return { filePath, error: (err as Error).message };
  }
}

/**
 * Check if a result is an error.
 */
export function isLoadError(
  result: LoadWorkflowResult | LoadWorkflowError
): result is LoadWorkflowError {
  return 'error' in result;
}

/**
 * Get workflow name from filename (fallback if not specified in YAML).
 */
export function getWorkflowNameFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}
