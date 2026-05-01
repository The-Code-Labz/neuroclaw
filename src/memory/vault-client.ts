import { config } from '../config';
import { callTool, listTools, type McpToolDefinition } from '../mcp/mcp-client';
import { logger } from '../utils/logger';

// The live NeuroVault MCP is an Obsidian-style file-tree vault. Tools take
// `vault_id` (UUID) + `path`. We translate the spec's note-DB shape into that
// API: memory types map to folder prefixes, titles slugify into filenames,
// "note_id" is the file path within the vault.

// ── Vault routing (memory type → folder inside the vault) ────────────────────

const FOLDER_ROUTES: Record<string, string> = {
  procedural:      'procedures',
  procedure:       'procedures',
  project:         'projects',
  agent:           'agents',
  agent_memory:    'agents',
  log:             'logs',
  daily_log:       'logs',
  episodic:        'logs',
  session_summary: 'logs',
  working:         'logs',
  insight:         'insights',
  semantic:        'insights',
  preference:      'agents',
};

export function folderForType(type: string | undefined): string {
  if (!type) return 'default';
  return FOLDER_ROUTES[type.toLowerCase()] ?? 'default';
}

// ── Vault name → ID resolution ───────────────────────────────────────────────

interface VaultRecord { id: string; name: string }

let cachedVaults: VaultRecord[] | null = null;
let vaultsPromise: Promise<VaultRecord[]> | null = null;

function ensureEnabled(): string {
  if (!config.mcp.enabled) throw new Error('Vault: MCP_ENABLED is false');
  const url = config.mcp.neurovaultUrl;
  if (!url) throw new Error('Vault: NEUROVAULT_MCP_URL is not set');
  return url;
}

async function refreshVaults(): Promise<VaultRecord[]> {
  const url = ensureEnabled();
  const result = await callTool(url, 'list_vaults', {}) as unknown;
  // Server returns shape like { ok, data: { vaults: [...] } } wrapped in a content block;
  // mcp-client unwraps the JSON, so result may be an array of those wrappers or the parsed object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collected: VaultRecord[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (node: any): void => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    if (Array.isArray(node.vaults)) {
      for (const v of node.vaults) {
        if (v && typeof v.id === 'string' && typeof v.name === 'string') {
          collected.push({ id: v.id, name: v.name });
        }
      }
    }
    if (node.data) visit(node.data);
  };
  visit(result);
  cachedVaults = collected;
  return collected;
}

async function getVaults(): Promise<VaultRecord[]> {
  if (cachedVaults) return cachedVaults;
  if (!vaultsPromise) vaultsPromise = refreshVaults().finally(() => { vaultsPromise = null; });
  return vaultsPromise;
}

export async function resolveVaultId(nameOrId?: string): Promise<string> {
  const target = (nameOrId?.trim() || config.mcp.neurovaultDefaultVault || 'neuroclaw');
  // If the caller already passed a UUID, accept it.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) return target;
  const vaults = await getVaults();
  const hit = vaults.find(v => v.name.toLowerCase() === target.toLowerCase());
  if (hit) return hit.id;
  // Fallback to the configured default if the requested vault is unknown.
  const fallbackName = config.mcp.neurovaultDefaultVault || 'neuroclaw';
  const fallback = vaults.find(v => v.name.toLowerCase() === fallbackName.toLowerCase());
  if (fallback) {
    logger.warn(`Vault: '${target}' not found, falling back to '${fallback.name}'`);
    return fallback.id;
  }
  throw new Error(`Vault: cannot resolve '${target}' or default '${fallbackName}'`);
}

export function clearVaultCache(): void {
  cachedVaults = null;
}

// ── Note path helpers ────────────────────────────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'note';
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function defaultPathFor(type: string, title: string): string {
  return `${folderForType(type)}/${todayStamp()}--${slugify(title)}.md`;
}

// ── Public types (spec-aligned) ──────────────────────────────────────────────

export interface VaultNoteCreate {
  vault?:      string;
  title:       string;
  content:     string;
  type:        string;
  tags?:       string[];
  agent?:      string;
  path?:       string;     // override the auto-generated path
}

export interface VaultNoteUpdate {
  vault?:   string;
  note_id:  string;        // path within the vault
  updates:  {
    content?:  string;     // upsert (replace) the file's content
    append?:   string;     // append text
    prepend?:  string;     // prepend text
  };
}

export interface VaultSearchInput {
  vault?: string;
  query:  string;
  limit?: number;
}

export interface VaultReadInput {
  vault?:  string;
  note_id: string;
}

export interface VaultNoteRef {
  note_id:    string;     // path
  vault_id?:  string;
  vault_name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw?:       any;
}

export interface VaultNoteSpec {
  title:       string;
  type:        string;
  agent?:      string;
  importance?: number;
  tags?:       string[];
  summary:     string;
  details?:    string;
  source?:     string;
  related?:    string[];
}

// ── Vault note formatting (standardized) ─────────────────────────────────────

export function formatVaultNoteContent(spec: VaultNoteSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.title}`);
  lines.push('');
  if (spec.type)             lines.push(`Type: ${spec.type}`);
  if (spec.agent)            lines.push(`Agent: ${spec.agent}`);
  if (typeof spec.importance === 'number') lines.push(`Importance: ${spec.importance.toFixed(2)}`);
  if (spec.tags?.length)     lines.push(`Tags: ${spec.tags.join(', ')}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(spec.summary);
  lines.push('');
  if (spec.details) {
    lines.push('## Details');
    lines.push(spec.details);
    lines.push('');
  }
  if (spec.source) {
    lines.push('## Source');
    lines.push(spec.source);
    lines.push('');
  }
  if (spec.related?.length) {
    lines.push('## Related Memories');
    for (const r of spec.related) lines.push(`- ${r}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function vaultListTools(): Promise<McpToolDefinition[]> {
  return listTools(ensureEnabled());
}

export async function vaultSearch(input: VaultSearchInput): Promise<unknown[]> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(input.vault);
  const result = await callTool(url, 'search_vault', {
    vault_id,
    q:     input.query,
    limit: input.limit ?? 20,
  });
  return normalizeList(result);
}

export async function vaultReadNote(input: VaultReadInput): Promise<unknown> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(input.vault);
  return callTool(url, 'read_file', { vault_id, path: input.note_id });
}

export async function vaultCreateNote(input: VaultNoteCreate): Promise<VaultNoteRef> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(input.vault);
  const path = input.path ?? defaultPathFor(input.type, input.title);
  const result = await callTool(url, 'create_file', {
    vault_id,
    path,
    content: input.content,
  });
  logger.info('Vault: note created', { vault_id, path, type: input.type });
  return { note_id: path, vault_id, raw: result };
}

export async function vaultUpsertNote(input: VaultNoteCreate): Promise<VaultNoteRef> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(input.vault);
  const path = input.path ?? defaultPathFor(input.type, input.title);
  const result = await callTool(url, 'upsert_file', {
    vault_id,
    path,
    content: input.content,
  });
  logger.info('Vault: note upserted', { vault_id, path, type: input.type });
  return { note_id: path, vault_id, raw: result };
}

export async function vaultUpdateNote(input: VaultNoteUpdate): Promise<VaultNoteRef> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(input.vault);
  const path = input.note_id;
  let raw: unknown = null;
  if (typeof input.updates.content === 'string') {
    raw = await callTool(url, 'upsert_file', { vault_id, path, content: input.updates.content });
  }
  if (typeof input.updates.append === 'string') {
    raw = await callTool(url, 'append_file', { vault_id, path, content: input.updates.append });
  }
  if (typeof input.updates.prepend === 'string') {
    raw = await callTool(url, 'prepend_file', { vault_id, path, content: input.updates.prepend });
  }
  if (raw === null) throw new Error('vaultUpdateNote: provide updates.content/append/prepend');
  logger.info('Vault: note updated', { vault_id, path });
  return { note_id: path, vault_id, raw };
}

export async function vaultListCollections(vault?: string): Promise<unknown> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(vault);
  return callTool(url, 'list_folders', { vault_id });
}

export async function vaultListFiles(vault?: string): Promise<unknown> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(vault);
  return callTool(url, 'list_files', { vault_id });
}

export async function vaultGetTree(vault?: string): Promise<unknown> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(vault);
  return callTool(url, 'get_tree', { vault_id });
}

export async function vaultGetRelatedNotes(input: VaultReadInput): Promise<unknown[]> {
  // The live MCP has no native "related" endpoint. Implement as a search using
  // the note's path as the query, which gets us folder-neighbours + name matches.
  return vaultSearch({ vault: input.vault, query: input.note_id, limit: 10 });
}

// ── Bonus tools (per user approval — not in original spec) ───────────────────

export async function vaultGetContextPack(vault?: string): Promise<unknown> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(vault);
  return callTool(url, 'get_context_pack', { vault_id });
}

export async function vaultLogHandoff(input: {
  vault?: string;
  from:   string;
  to:     string;
  summary: string;
}): Promise<unknown> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(input.vault);
  return callTool(url, 'log_handoff', {
    vault_id,
    from:    input.from,
    to:      input.to,
    summary: input.summary,
  });
}

export async function vaultCreateCheckpoint(input: { vault?: string; summary: string }): Promise<unknown> {
  const url = ensureEnabled();
  const vault_id = await resolveVaultId(input.vault);
  return callTool(url, 'create_checkpoint', { vault_id, summary: input.summary });
}

// ── Normalizers ──────────────────────────────────────────────────────────────

function normalizeList(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r.data && typeof r.data === 'object') {
      const d = r.data as Record<string, unknown>;
      if (Array.isArray(d.results)) return d.results;
      if (Array.isArray(d.items))   return d.items;
      if (Array.isArray(d.notes))   return d.notes;
      if (Array.isArray(d.files))   return d.files;
    }
    if (Array.isArray(r.results)) return r.results;
    if (Array.isArray(r.items))   return r.items;
    if (Array.isArray(r.notes))   return r.notes;
  }
  return [];
}
