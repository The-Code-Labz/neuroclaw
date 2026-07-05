import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { generateToolSchemaSnapshot } from './__snapshots__/snapshot';

const baselinePath = path.join(__dirname, '__snapshots__', 'tool-schemas.baseline.json');

test('tool JSON schemas match the committed baseline (zod migration gate)', () => {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const live = generateToolSchemaSnapshot();

  // Same set of tools.
  assert.deepEqual(
    Object.keys(live).sort(),
    Object.keys(baseline).sort(),
    'tool set changed vs baseline',
  );

  // Per-tool deep equality, so a failure names the exact tool that drifted.
  for (const name of Object.keys(baseline)) {
    assert.deepEqual(
      live[name],
      baseline[name],
      `JSON Schema drift for tool "${name}"`,
    );
  }
});

test('no tool schema is empty (guards zod-4 conversion regressions)', () => {
  // The bug that prompted the z.toJSONSchema migration: the old
  // zod-to-json-schema library silently returned {"$schema": "..."} (an empty
  // schema with no type/properties) for zod-4 inputs. This guards that failure
  // mode — every generated schema must carry real content beyond $schema.
  const live = generateToolSchemaSnapshot();
  for (const [name, schema] of Object.entries(live)) {
    const keys = Object.keys(schema as Record<string, unknown>).filter((k) => k !== '$schema');
    assert.ok(
      keys.length > 0,
      `Tool "${name}" produced an empty JSON Schema (only $schema) — zod-4 conversion regression`,
    );
  }
});
