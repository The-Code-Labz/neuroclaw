// mcp.build-stamps — generalised dist-fresh check for local MCP server scripts.
//
// Two sources to consider:
//   1. The local stdio MCP server we ship (src/mcp/stdio-server.ts →
//      dist/mcp/stdio-server.js). package.json's mcp:stdio:built script
//      runs the dist version; if it goes stale, agents pick up old tools.
//   2. Rows in mcp_servers whose URL is a local path or file:// (rare today,
//      but supported by the schema). For each, derive the dist artifact
//      from the URL if possible and compare mtimes.

import { stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from '../registry';

interface Pair { source: string; dist: string; reason: string }

const STATIC_PAIRS: Pair[] = [
  { source: 'src/mcp/stdio-server.ts', dist: 'dist/mcp/stdio-server.js', reason: 'local stdio MCP server' },
];

function urlToLocalPath(u: string): string | null {
  const t = u.trim();
  if (!t) return null;
  if (t.startsWith('file://')) {
    try { return fileURLToPath(t); } catch { return null; }
  }
  if (t.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(t)) return t;
  return null;
}

register({
  id: 'mcp.build-stamps',
  scope: 'mcp',
  severity: 'warn',
  description: 'Local MCP server dist artifacts are up to date with source',
  async run(ctx) {
    const stale: Array<{ source: string; reason: string }> = [];
    const missing: Array<{ dist: string; reason: string }> = [];

    // 1. Static pairs (the in-tree stdio server)
    for (const p of STATIC_PAIRS) {
      const srcPath = join(ctx.repoRoot, p.source);
      const distPath = join(ctx.repoRoot, p.dist);
      let srcStat;
      try { srcStat = await stat(srcPath); } catch { continue; }
      const distStat = await stat(distPath).catch(() => null);
      if (!distStat) {
        missing.push({ dist: p.dist, reason: p.reason });
        continue;
      }
      if (distStat.mtimeMs < srcStat.mtimeMs) {
        stale.push({ source: p.source, reason: p.reason });
      }
    }

    // 2. Rows in mcp_servers — only those pointing at a local file.
    try {
      const rows = ctx.db
        .prepare(`SELECT id, name, url FROM mcp_servers WHERE enabled = 1`)
        .all() as Array<{ id: string; name: string; url: string }>;
      for (const r of rows) {
        const localPath = urlToLocalPath(r.url);
        if (!localPath) continue;
        // We can't reliably derive the source from a built artifact; just
        // verify the artifact exists. Anything else is out of scope here.
        const absDist = isAbsolute(localPath) ? localPath : join(ctx.repoRoot, localPath);
        const exists = await stat(absDist).then(() => true).catch(() => false);
        if (!exists) {
          missing.push({ dist: r.url, reason: `mcp_servers row "${r.name}" (${r.id}) points at missing file` });
        }
      }
    } catch { /* table may not exist */ }

    const total = stale.length + missing.length;
    return {
      ok: total === 0,
      detail: total === 0
        ? 'Local MCP server artifacts are current'
        : [
            stale.length ? `${stale.length} stale: ${stale.map(s => s.source).join(', ')}` : '',
            missing.length ? `${missing.length} missing: ${missing.map(m => m.dist).join(', ')}` : '',
          ].filter(Boolean).join('; '),
      fix: total > 0 ? {
        suggestion: stale.length > 0
          ? 'Rebuild the project to refresh MCP dist artifacts'
          : 'Rebuild, or remove the mcp_servers rows pointing at missing local files',
        command: stale.length > 0 ? 'npm run build' : undefined,
        automated: stale.length > 0 && missing.length === 0,
      } : undefined,
      meta: { stale, missing },
    };
  },
});
