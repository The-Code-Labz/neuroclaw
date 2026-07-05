import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { config } from '../config';

function resolveConfigDir(): string {
  return config.antigravity.settingsDir || join(homedir(), '.gemini', 'antigravity-cli');
}

// agy reads from ~/.gemini/config/mcp_config.json (NOT ~/.gemini/antigravity-cli/mcp.json).
// The config directory under ~/.gemini/config/ is separate from the antigravity-cli data dir.
function mcpConfigPath(): string {
  return join(homedir(), '.gemini', 'config', 'mcp_config.json');
}

// agy uses the HTTP transport format: { url, headers }
// NOT the stdio format: { command, args, env }
interface McpEntry { url: string; headers?: Record<string, string> }
interface McpConfig { mcpServers: Record<string, McpEntry> }

async function readMcpConfig(): Promise<McpConfig> {
  try { return JSON.parse(await readFile(mcpConfigPath(), 'utf-8')) as McpConfig; }
  catch { return { mcpServers: {} }; }
}

async function writeMcpConfig(cfg: McpConfig): Promise<void> {
  const p = mcpConfigPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

export async function ensureAntigravityMcpRegistered(): Promise<void> {
  try {
    const token = process.env.DASHBOARD_TOKEN ?? '';
    const port  = process.env.DASHBOARD_PORT ?? '3141';
    const cfg   = await readMcpConfig();
    cfg.mcpServers['neuroclaw'] = {
      url:     `http://127.0.0.1:${port}/mcp`,
      headers: { 'x-dashboard-token': token },
    };
    await writeMcpConfig(cfg);
  } catch { /* non-fatal */ }
}

export async function isAntigravityConfigAvailable(): Promise<boolean> {
  const settingsPath = join(resolveConfigDir(), 'settings.json');
  try { await readFile(settingsPath, 'utf-8'); return true; }
  catch { return false; }
}
