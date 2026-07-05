/**
 * Workflow execution context — typed node output store + string interpolation.
 *
 * Interpolation patterns:
 *   $nodeId.output          → raw text output of a completed node
 *   $nodeId.result          → JSON.stringify of structured result (output_format: json)
 *   $nodeId.result.field    → deep property access into structured result
 *   $WORKFLOW_ID            → built-in: current run ID
 *   $LOOP_PREV_OUTPUT       → built-in: previous loop iteration output
 *   $ARTIFACTS_DIR          → built-in: per-run scratch directory path
 */

export interface NodeOutput {
  output: string;
  result?: unknown;
}

export type NodeContextMap = Map<string, NodeOutput>;

function deepGet(obj: unknown, path: string[]): string {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur == null) return '';
  if (typeof cur === 'object') return JSON.stringify(cur);
  return String(cur);
}

export interface InterpolateBuiltins {
  WORKFLOW_ID?: string;
  LOOP_PREV_OUTPUT?: string;
  ARTIFACTS_DIR?: string;
}

export function interpolate(
  template: string,
  context: NodeContextMap,
  builtins: InterpolateBuiltins = {},
): string {
  // Replace $nodeId.output and $nodeId.result[.field[.nested]] patterns
  let result = template.replace(
    /\$([a-zA-Z0-9_-]+)((?:\.[a-zA-Z0-9_]+)+)/g,
    (match, nodeId: string, dotPath: string) => {
      const entry = context.get(nodeId);
      if (!entry) return match; // node not yet completed — leave as-is
      const parts = dotPath.slice(1).split('.'); // strip leading dot
      if (parts[0] === 'output') return entry.output;
      if (parts[0] === 'result') {
        if (parts.length === 1) {
          return entry.result != null ? JSON.stringify(entry.result) : '';
        }
        return deepGet(entry.result, parts.slice(1));
      }
      return match;
    },
  );

  // Replace $BUILTIN patterns (all-caps, no dot)
  result = result.replace(/\$([A-Z_]+)/g, (_match, name: string) => {
    const val = (builtins as Record<string, string | undefined>)[name];
    return val ?? _match;
  });

  return result;
}

/**
 * Evaluate a `when:` condition expression.
 * Supports:
 *   - `$nodeId.output == "literal"` and `!= "literal"`
 *   - Bare `$nodeId.output` — truthy if non-empty and not "false"/"0"
 */
export function evaluateWhen(expr: string, context: NodeContextMap): boolean {
  const interpolated = interpolate(expr, context);
  if (interpolated === '' || interpolated === 'false' || interpolated === '0') return false;

  const eqMatch = interpolated.match(/^(.+?)\s*==\s*"(.+)"$/);
  if (eqMatch) return eqMatch[1].trim() === eqMatch[2];

  const neqMatch = interpolated.match(/^(.+?)\s*!=\s*"(.+)"$/);
  if (neqMatch) return neqMatch[1].trim() !== neqMatch[2];

  return true; // non-empty after interpolation = truthy
}
