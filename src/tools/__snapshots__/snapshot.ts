// Deterministic snapshot of every static tool's JSON Schema, generated with
// zod 4's native z.toJSONSchema (draft-7) — the same call the runtime adapters
// (openai/http-mcp/meta-tools/sub-agent-runner) use. This is the regression
// gate for tool schemas: the committed baseline is the source of truth, and any
// drift in a tool's generated schema fails the test, naming the exact tool.
//
// Covers the 71 static `registry` tools + 3 META_TOOL_DEFS. The dynamic
// MCP-registry / MCP-backed-agent tools are excluded (DB-dependent); their only
// zod surface is the two passthrough (z.looseObject) schemas.

import { z } from 'zod';
import { registry } from '../registry';
import { META_TOOL_DEFS } from '../meta-tools';

/** Map of snapshot-key -> JSON Schema, sorted by key for stable diffs. */
export function generateToolSchemaSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of registry) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[t.name] = z.toJSONSchema(t.schema as any, { target: 'draft-7' });
  }
  for (const [name, def] of Object.entries(META_TOOL_DEFS)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[`meta:${name}`] = z.toJSONSchema((def as any).schema, { target: 'draft-7' });
  }
  return Object.fromEntries(
    Object.keys(out).sort().map((k) => [k, out[k]]),
  );
}
