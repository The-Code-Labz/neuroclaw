// Idempotently maintain a NeuroClaw entry in ~/.opencode/config.toml so Opencode
// sessions can reach our HTTP MCP endpoint.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';

const SERVER_NAME = 'neuroclaw';
const COMPOSIO_NAME = 'composio';

export interface OpencodeMcpRegistration {
  url:        string;
  /** Env var Opencode should read for the bearer token. Defaults to DASHBOARD_TOKEN. */
  tokenEnv?:  string;
  /** Optional static headers written into Opencode's MCP config for this runtime. */
  headers?:   Record<string, string>;
}

export interface OpencodeComposioRegistration {
  url:     string;
  headers: Record<string, string>;
}

function configPath(): string {
  return path.join(os.homedir(), '.opencode', 'config.toml');
}

/** Escape a string for TOML basic-string syntax. */
function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function stripBlock(toml: string, name: string): string {
  const target = `mcp_servers.${name}`;
  const lines = toml.split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const headerMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (headerMatch) {
      const section = headerMatch[1];
      inBlock = section === target || section.startsWith(target + '.');
      if (inBlock) continue;
    }
    if (!inBlock) out.push(line);
  }
  return out.join('\n');
}

function buildBlock(reg: OpencodeMcpRegistration): string {
  const tokenEnv = reg.tokenEnv ?? 'DASHBOARD_TOKEN';
  const headerEntries = Object.entries(reg.headers ?? {})
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
    .join(', ');
  const lines = [
    '',
    `[mcp_servers.${SERVER_NAME}]`,
    `url = ${tomlString(reg.url)}`,
    `bearer_token_env_var = ${tomlString(tokenEnv)}`,
    ...(headerEntries ? [`http_headers = { ${headerEntries} }`] : []),
    `default_tools_approval_mode = "approve"`,
    '',
  ];
  return lines.join('\n');
}

export async function ensureOpencodeMcpRegistered(reg: OpencodeMcpRegistration): Promise<{ written: boolean; path: string }> {
  const target = configPath();
  const dir    = path.dirname(target);

  if (!fs.existsSync(dir)) {
    logger.info('opencode config dir absent, skipping MCP registration', { dir });
    return { written: false, path: target };
  }

  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  const stripped = stripBlock(before, SERVER_NAME);
  const after = (stripped.endsWith('\n') ? stripped : stripped + '\n') + buildBlock(reg).trimStart();

  if (before === after) {
    return { written: false, path: target };
  }

  fs.writeFileSync(target, after, 'utf-8');
  logger.info('opencode MCP server registered', { path: target, name: SERVER_NAME, url: reg.url });
  return { written: true, path: target };
}

function buildComposioBlock(reg: OpencodeComposioRegistration): string {
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

export function syncComposioInOpencodeConfig(reg: OpencodeComposioRegistration | null): { written: boolean; path: string } {
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
