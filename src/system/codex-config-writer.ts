// Idempotently maintain a NeuroClaw entry in ~/.codex/config.toml so Codex
// sessions can reach our HTTP MCP endpoint.
//
// Codex MCP servers are configured under `[mcp_servers.<name>]` blocks in
// the user's config.toml. We:
//   1. Read the existing file (or start with an empty buffer if absent).
//   2. Strip any prior [mcp_servers.neuroclaw] block (so URL/token changes
//      flow through cleanly between runs).
//   3. Append a fresh block targeting the current dashboard port + token.
//
// Only writes when something actually changed — avoids gratuitous file
// rewrites on each boot.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';

const SERVER_NAME = 'neuroclaw';
const COMPOSIO_NAME = 'composio';

export interface CodexMcpRegistration {
  url:        string;
  /** Env var Codex should read for the bearer token. Defaults to DASHBOARD_TOKEN. */
  tokenEnv?:  string;
}

export interface CodexComposioRegistration {
  url:     string;
  headers: Record<string, string>;
}

function configPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

/** Escape a string for TOML basic-string syntax. */
function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/**
 * Strip a `[mcp_servers.<name>]` block — including any sub-tables like
 * `[mcp_servers.<name>.http_headers]` — up until the next non-nested
 * [section] header or EOF.
 */
function stripBlock(toml: string, name: string): string {
  const target = `mcp_servers.${name}`;
  const lines = toml.split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const headerMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (headerMatch) {
      const section = headerMatch[1];
      // Sub-tables of our target (`mcp_servers.X.http_headers`) belong to the
      // same logical block and must be stripped together.
      inBlock = section === target || section.startsWith(target + '.');
      if (inBlock) continue;
    }
    if (!inBlock) out.push(line);
  }
  return out.join('\n');
}

function buildBlock(reg: CodexMcpRegistration): string {
  const tokenEnv = reg.tokenEnv ?? 'DASHBOARD_TOKEN';
  // `default_tools_approval_mode = "approve"` auto-approves every tool on
  // this server so non-interactive `codex exec` flows work end-to-end.
  // The user already trusts NeuroClaw (it's running locally on their box) —
  // forcing approval per call would break the codex provider in alfred.ts.
  return [
    '',
    `[mcp_servers.${SERVER_NAME}]`,
    `url = "${reg.url}"`,
    `bearer_token_env_var = "${tokenEnv}"`,
    `default_tools_approval_mode = "approve"`,
    '',
  ].join('\n');
}

export async function ensureCodexMcpRegistered(reg: CodexMcpRegistration): Promise<{ written: boolean; path: string }> {
  const target = configPath();
  const dir    = path.dirname(target);

  // If the codex CLI has never been used (`~/.codex` doesn't exist) we don't
  // create it — that would imply Codex is installed, which we can't assume.
  // Instead, just no-op and log.
  if (!fs.existsSync(dir)) {
    logger.info('codex config dir absent, skipping MCP registration', { dir });
    return { written: false, path: target };
  }

  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  const stripped = stripBlock(before, SERVER_NAME);
  const after = (stripped.endsWith('\n') ? stripped : stripped + '\n') + buildBlock(reg).trimStart();

  if (before === after) {
    return { written: false, path: target };
  }

  fs.writeFileSync(target, after, 'utf-8');
  logger.info('codex MCP server registered', { path: target, name: SERVER_NAME, url: reg.url });
  return { written: true, path: target };
}

function buildComposioBlock(reg: CodexComposioRegistration): string {
  // http_headers as inline TOML table. Composio's session headers carry auth
  // info that can be a Bearer or custom keys — we pass the whole map through.
  const entries = Object.entries(reg.headers)
    .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
    .join(', ');
  return [
    '',
    `[mcp_servers.${COMPOSIO_NAME}]`,
    `url = "${reg.url}"`,
    `http_headers = { ${entries} }`,
    `default_tools_approval_mode = "approve"`,
    '',
  ].join('\n');
}

/**
 * Write or update the [mcp_servers.composio] block on `~/.codex/config.toml`.
 * Called *per chat turn* before spawning codex — the URL/headers are session-
 * scoped (rotates every COMPOSIO_SESSION_TTL_SEC). Codex concurrencyLimit=1
 * means we don't race against a running codex process.
 *
 * Pass `reg=null` to remove any existing composio block (when the agent
 * disables composio mid-session, etc).
 */
export function syncComposioInCodexConfig(reg: CodexComposioRegistration | null): { written: boolean; path: string } {
  const target = configPath();
  const dir    = path.dirname(target);

  if (!fs.existsSync(dir)) return { written: false, path: target };

  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  const stripped = stripBlock(before, COMPOSIO_NAME);
  const after = reg
    ? (stripped.endsWith('\n') ? stripped : stripped + '\n') + buildComposioBlock(reg).trimStart()
    : stripped;

  if (before === after) return { written: false, path: target };

  fs.writeFileSync(target, after, 'utf-8');
  return { written: true, path: target };
}
