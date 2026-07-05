/**
 * Documentation Freshness Checker
 * 
 * Compares source file modification times against their corresponding
 * documentation files. Reports stale docs that may need updates.
 */

import fs from 'fs';
import path from 'path';

const WIKI_ROOT = path.resolve(process.cwd(), 'docs/wiki');
const SRC_ROOT = path.resolve(process.cwd(), 'src');

interface FreshnessReport {
  stale: Array<{ doc: string; source: string; docMtime: Date; sourceMtime: Date }>;
  missing: Array<{ source: string; suggestedDoc: string }>;
  upToDate: number;
}

// Map wiki articles to their primary source files
const DOC_SOURCE_MAP: Record<string, string[]> = {
  // Reference docs
  'reference/memory-system.md': [
    'src/memory/memory-pipeline.ts',
    'src/memory/memory-retriever.ts',
    'src/memory/memory-extractor.ts',
    'src/memory/memory-scorer.ts',
    'src/memory/context-compactor.ts'
  ],
  'reference/api-endpoints.md': [
    'src/dashboard/server.ts',
    'src/dashboard/wiki-loader.ts'
  ],
  'reference/env-vars.md': [
    'src/config.ts',
    '.env.example'
  ],
  'reference/model-catalog.md': [
    'src/system/model-triage.ts',
    'src/system/model-catalog.ts',
    'src/config.ts'
  ],
  // Agents docs
  'agents/creating-agents.md': [
    'src/db.ts',
    'src/agent/alfred.ts'
  ],
  'agents/routing-and-mentions.md': [
    'src/system/router.ts',
    'src/system/spawner.ts'
  ],
  'agents/skills.md': [
    'src/skills/loader.ts'
  ],
  // Integrations docs
  'integrations/mcp-servers.md': [
    'src/mcp/mcp-registry.ts',
    'src/mcp/mcp-client.ts'
  ],
  'integrations/discord-bot.md': [
    'src/integrations/discord-bot.ts'
  ],
  'integrations/audio.md': [
    'src/audio/tts.ts',
    'src/audio/transcribe.ts'
  ],
  'integrations/vision.md': [
    'src/vision/index.ts'
  ],
  // Getting started docs
  'getting-started/configuration.md': [
    'src/config.ts',
    '.env.example'
  ],
  'getting-started/architecture-overview.md': [
    'src/agent/alfred.ts',
    'src/system/spawner.ts',
    'src/system/router.ts'
  ],
  // Tools docs
  'tools/overview.md': [
    'src/tools/registry.ts',
    'src/tools/context.ts'
  ],
  'tools/tool-reference.md': [
    'src/tools/registry.ts',
    'src/tools/schemas.ts'
  ],
  // Deployment docs
  'deployment/production.md': [
    'src/dashboard/server.ts',
    'src/config.ts'
  ],
  // Troubleshooting docs
  'troubleshooting/common-issues.md': [
    'src/config.ts',
    'src/memory/memory-pipeline.ts'
  ],
  'troubleshooting/diagnostics.md': [
    'src/diagnostics/memory-check.ts',
    'src/diagnostics/claude-check.ts'
  ],
};

function getMtime(filePath: string): Date | null {
  try {
    return fs.statSync(filePath).mtime;
  } catch {
    return null;
  }
}

function checkFreshness(): FreshnessReport {
  const report: FreshnessReport = {
    stale: [],
    missing: [],
    upToDate: 0
  };

  for (const [docRelPath, sources] of Object.entries(DOC_SOURCE_MAP)) {
    const docPath = path.join(WIKI_ROOT, docRelPath);
    const docMtime = getMtime(docPath);

    if (!docMtime) {
      report.missing.push({
        source: sources[0],
        suggestedDoc: docRelPath
      });
      continue;
    }

    // Find the most recently modified source file
    let newestSourceMtime: Date | null = null;
    let newestSource = '';

    for (const source of sources) {
      const sourcePath = path.resolve(process.cwd(), source);
      const sourceMtime = getMtime(sourcePath);
      if (sourceMtime && (!newestSourceMtime || sourceMtime > newestSourceMtime)) {
        newestSourceMtime = sourceMtime;
        newestSource = source;
      }
    }

    if (newestSourceMtime && newestSourceMtime > docMtime) {
      report.stale.push({
        doc: docRelPath,
        source: newestSource,
        docMtime,
        sourceMtime: newestSourceMtime
      });
    } else {
      report.upToDate++;
    }
  }

  return report;
}

function formatDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function main(): void {
  console.log('=== Documentation Freshness Check ===\n');

  const report = checkFreshness();

  if (report.stale.length > 0) {
    console.log(`⚠️  STALE DOCUMENTATION (${report.stale.length}):\n`);
    for (const item of report.stale) {
      const daysSinceUpdate = Math.floor(
        (item.sourceMtime.getTime() - item.docMtime.getTime()) / (1000 * 60 * 60 * 24)
      );
      console.log(`  📄 ${item.doc}`);
      console.log(`     Source: ${item.source}`);
      console.log(`     Doc updated:    ${formatDate(item.docMtime)}`);
      console.log(`     Source updated: ${formatDate(item.sourceMtime)} (${daysSinceUpdate} days newer)`);
      console.log();
    }
  }

  if (report.missing.length > 0) {
    console.log(`❌ MISSING DOCUMENTATION (${report.missing.length}):\n`);
    for (const item of report.missing) {
      console.log(`  📝 ${item.suggestedDoc}`);
      console.log(`     Primary source: ${item.source}`);
      console.log();
    }
  }

  console.log(`✅ Up-to-date: ${report.upToDate}`);
  console.log(`⚠️  Stale:      ${report.stale.length}`);
  console.log(`❌ Missing:    ${report.missing.length}`);

  if (report.stale.length > 0 || report.missing.length > 0) {
    console.log('\nRun `npm run docs` to regenerate API reference.');
    process.exit(1);
  }
}

main();
