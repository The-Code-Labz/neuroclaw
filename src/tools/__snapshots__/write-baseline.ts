// One-shot: regenerate the committed baseline (current zod-4 z.toJSONSchema
// output). Run ONLY to intentionally accept a reviewed, triaged schema diff —
// never to silence a failing snapshot test without understanding the drift.
//
//   npx tsx src/tools/__snapshots__/write-baseline.ts

import * as fs from 'fs';
import * as path from 'path';
import { generateToolSchemaSnapshot } from './snapshot';

const baselinePath = path.join(__dirname, 'tool-schemas.baseline.json');
const snapshot = generateToolSchemaSnapshot();
fs.writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
console.error(`Wrote baseline: ${Object.keys(snapshot).length} tool schemas -> ${baselinePath}`);
