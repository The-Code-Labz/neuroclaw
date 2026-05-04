// Manual Skills loader.
//
// Walks .claude/skills/*/SKILL.md, parses YAML frontmatter, exposes:
//   listSkills()              → catalog of available skills
//   getSkill(name)            → one skill record
//   buildSkillsBlock(names)   → markdown block to append to a system prompt
//
// Auto-routing is intentionally out of scope. Each agent declares a fixed
// list of skills via agents.skills (JSON array of names). Their bodies are
// appended to the system prompt at the start of every chat turn.
//
// Two roots are searched, in order:
//   1. <project>/.claude/skills/    — project-local skills (checked into the repo)
//   2. ~/.claude/skills/            — user-global skills (Claude CLI default)
// Project-local wins on name collision.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';

export interface SkillRecord {
  name:        string;
  description: string;
  triggers:    string[];        // declared, but we don't auto-route on them yet
  tools:       string[];        // allowed tool names; not enforced yet — informational
  scripts:     string[];        // executable scripts in <skill>/scripts/ exposed via run_skill_script
  body:        string;          // markdown body (everything after the second `---`)
  source:      'project' | 'user' | 'plugin' | 'marketplace';
  path:        string;          // absolute path to SKILL.md
  dir:         string;          // absolute path to skill folder
  always_on:   boolean;         // when true, injected into every agent's prompt regardless of agents.skills
  /** For plugin/marketplace skills: "<plugin>@<marketplace>" identifier. Otherwise undefined. */
  plugin?:     string;
}

const PROJECT_ROOT  = path.resolve(process.cwd(), '.claude/skills');
const USER_ROOT     = path.join(os.homedir(), '.claude', 'skills');
const PLUGINS_INDEX = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

// Skill names: lowercase letters, digits, dash. Must be one segment, ≤ 64 chars.
const NAME_RE   = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Script filenames: a single path segment, no leading dot, sane extension.
const SCRIPT_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;

export function sanitizeSkillName(raw: string): string {
  const s = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!NAME_RE.test(s)) throw new Error(`invalid skill name "${raw}" (must be lowercase letters/digits/dashes, ≤ 64 chars)`);
  return s;
}

function validateScriptFilename(filename: string): string {
  const f = (filename ?? '').trim();
  if (!SCRIPT_RE.test(f) || f.includes('/') || f.includes('\\') || f === '.' || f === '..') {
    throw new Error(`invalid script filename "${filename}" (single segment, alphanumeric + . _ -, no path components)`);
  }
  return f;
}

// ── Cache ────────────────────────────────────────────────────────────────────
// Reload on each call would re-walk the disk on every chat turn. Cache for
// 30s; force refresh available via clearSkillCache().

let cache:        Map<string, SkillRecord> | null = null;
let cacheExpires: number = 0;
const CACHE_TTL = 30_000;

export function clearSkillCache(): void {
  cache = null;
  cacheExpires = 0;
}

// ── Frontmatter parser ──────────────────────────────────────────────────────
// Minimal YAML — handles `key: value`, `key: [a, b, c]`, and quoted strings.
// Does NOT handle nested objects or block-style lists. Sufficient for the
// 4-key SKILL.md frontmatter we need.

function parseFrontmatter(raw: string): { fields: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { fields: {}, body: raw };
  const yaml = m[1];
  const body = m[2];

  const fields: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (!key) continue;

    // Strip wrapping quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // Inline list: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1);
      const items = inner.split(',').map(s => s.trim()).map(s => {
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
        return s;
      }).filter(Boolean);
      fields[key] = items;
      continue;
    }

    fields[key] = val;
  }
  return { fields, body };
}

function readSkillFile(absPath: string, source: 'project' | 'user' | 'plugin' | 'marketplace', plugin?: string): SkillRecord | null {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const { fields, body } = parseFrontmatter(raw);
    const name = String(fields.name ?? path.basename(path.dirname(absPath))).trim();
    if (!name) return null;
    const triggers = Array.isArray(fields.triggers) ? fields.triggers.map(String) : [];
    const tools    = Array.isArray(fields.tools)    ? fields.tools.map(String)    : [];
    const dir      = path.dirname(absPath);
    // Scripts: prefer the frontmatter declaration (explicit allowlist) for safety.
    // Fall back to scanning <skill>/scripts/ when the user hasn't declared any —
    // makes the simple case "drop a script in scripts/" just work.
    let scripts: string[];
    if (Array.isArray(fields.scripts)) {
      scripts = fields.scripts.map(String).map(s => s.trim()).filter(Boolean);
    } else {
      const scriptsDir = path.join(dir, 'scripts');
      try {
        scripts = fs.existsSync(scriptsDir)
          ? fs.readdirSync(scriptsDir).filter(f => fs.statSync(path.join(scriptsDir, f)).isFile())
          : [];
      } catch { scripts = []; }
    }
    const always_on =
      fields.always_on === true ||
      fields.always_on === 'true' ||
      fields.always_on === 1 ||
      fields.always_on === '1';
    return {
      name,
      description: String(fields.description ?? '').trim(),
      triggers,
      tools,
      scripts,
      body:        body.trim(),
      source,
      path:        absPath,
      dir,
      always_on,
      ...(plugin ? { plugin } : {}),
    };
  } catch (err) {
    logger.warn('skill-loader: failed to read', { path: absPath, error: (err as Error).message });
    return null;
  }
}

function walkSkills(root: string, source: 'project' | 'user', acc: Map<string, SkillRecord>): void {
  if (!fs.existsSync(root)) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillPath = path.join(root, ent.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const rec = readSkillFile(skillPath, source);
    if (!rec) continue;
    // Project-local overrides user-global on collision (project loaded first).
    if (!acc.has(rec.name)) acc.set(rec.name, rec);
  }
}

// Plugins installed via `claude plugin install` land at a versioned path
// recorded in ~/.claude/plugins/installed_plugins.json. Each plugin's SKILL.md
// files live under <installPath>/skills/<name>/SKILL.md. Walk only what's
// listed in the manifest — that way cached-but-not-installed plugins (the
// other entries under marketplaces/) are correctly excluded.
function walkInstalledPlugins(acc: Map<string, SkillRecord>): void {
  if (!fs.existsSync(PLUGINS_INDEX)) return;
  let manifest: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try { manifest = JSON.parse(fs.readFileSync(PLUGINS_INDEX, 'utf-8')); }
  catch (err) { logger.warn('skill-loader: bad installed_plugins.json', { error: (err as Error).message }); return; }
  const plugins = manifest.plugins ?? {};
  for (const [pluginId, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs) || installs.length === 0) continue;
    // Use the first install (typically a single user-scope row); future
    // multi-scope installs would deduplicate here.
    const installPath = installs[0]?.installPath;
    if (!installPath) continue;
    const skillsRoot = path.join(installPath, 'skills');
    if (!fs.existsSync(skillsRoot)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(skillsRoot, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillPath = path.join(skillsRoot, ent.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const rec = readSkillFile(skillPath, 'plugin', pluginId);
      if (!rec) continue;
      if (!acc.has(rec.name)) acc.set(rec.name, rec);
    }
  }
}

// Marketplaces ship a bundle of plugins under ~/.claude/plugins/marketplaces/
// <marketplace>/{plugins,external_plugins}/<plugin>/skills/<name>/SKILL.md.
// Claude Code loads ALL of these natively when the marketplace is registered,
// so they show up as `<plugin>:<skill>` in Claude CLI agents. We expose them
// to non-Claude agents (VoidAI / OpenAI / Codex) by walking the same paths
// and treating each as a fourth source. Skills already loaded from a
// higher-priority root (project / user / installed-plugin) keep precedence.
function walkMarketplaceSkills(acc: Map<string, SkillRecord>): void {
  const marketplacesRoot = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces');
  if (!fs.existsSync(marketplacesRoot)) return;
  let marketplaces: fs.Dirent[];
  try { marketplaces = fs.readdirSync(marketplacesRoot, { withFileTypes: true }); }
  catch { return; }
  for (const m of marketplaces) {
    if (!m.isDirectory()) continue;
    const marketplaceName = m.name;
    // Both `plugins/` and `external_plugins/` follow the same layout.
    for (const bucket of ['plugins', 'external_plugins']) {
      const bucketRoot = path.join(marketplacesRoot, marketplaceName, bucket);
      if (!fs.existsSync(bucketRoot)) continue;
      let plugins: fs.Dirent[];
      try { plugins = fs.readdirSync(bucketRoot, { withFileTypes: true }); }
      catch { continue; }
      for (const p of plugins) {
        if (!p.isDirectory()) continue;
        const skillsRoot = path.join(bucketRoot, p.name, 'skills');
        if (!fs.existsSync(skillsRoot)) continue;
        let skillDirs: fs.Dirent[];
        try { skillDirs = fs.readdirSync(skillsRoot, { withFileTypes: true }); }
        catch { continue; }
        const pluginId = `${p.name}@${marketplaceName}`;
        for (const s of skillDirs) {
          if (!s.isDirectory()) continue;
          const skillPath = path.join(skillsRoot, s.name, 'SKILL.md');
          if (!fs.existsSync(skillPath)) continue;
          const rec = readSkillFile(skillPath, 'marketplace', pluginId);
          if (!rec) continue;
          if (!acc.has(rec.name)) acc.set(rec.name, rec);
        }
      }
    }
  }
}

function refreshCache(): Map<string, SkillRecord> {
  const map = new Map<string, SkillRecord>();
  // Order matters — first writer wins on name collision. Priority:
  //   project > user > installed-plugin > marketplace
  // So a user can shadow any plugin skill by dropping a SKILL.md with the
  // same name into .claude/skills/ or ~/.claude/skills/.
  walkSkills(PROJECT_ROOT, 'project', map);
  walkSkills(USER_ROOT,    'user',    map);
  walkInstalledPlugins(map);
  walkMarketplaceSkills(map);
  cache = map;
  cacheExpires = Date.now() + CACHE_TTL;
  return map;
}

function getCache(): Map<string, SkillRecord> {
  if (!cache || cacheExpires < Date.now()) return refreshCache();
  return cache;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function listSkills(): SkillRecord[] {
  return Array.from(getCache().values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): SkillRecord | null {
  return getCache().get(name) ?? null;
}

/**
 * Build a markdown block to append to an agent's system prompt. Returns ''
 * when no skills are passed or none of them are loadable.
 */
export function buildSkillsBlock(names: string[] | null | undefined): string {
  if (!names || names.length === 0) return '';
  const found: SkillRecord[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const s = getSkill(n);
    if (s) found.push(s); else missing.push(n);
  }
  if (found.length === 0 && missing.length === 0) return '';

  const lines: string[] = ['', '---', '## Active skills'];
  for (const s of found) {
    lines.push('');
    lines.push(`### Skill: ${s.name}`);
    if (s.description) lines.push(`_${s.description}_`);
    if (s.triggers.length) lines.push(`**Triggers:** ${s.triggers.join(', ')}`);
    if (s.tools.length)    lines.push(`**Allowed tools:** ${s.tools.join(', ')}`);
    if (s.scripts.length)  lines.push(`**Scripts:** ${s.scripts.join(', ')} — call via \`run_skill_script(skill_name="${s.name}", script="<filename>", args=[...])\`.`);
    lines.push('');
    lines.push(s.body);
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push(`_Missing skills (declared but not loaded): ${missing.join(', ')}_`);
  }
  return lines.join('\n');
}

/**
 * Parse an agent's `skills` JSON column into a string array.
 */
export function parseAgentSkills(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}

// ── Script discovery ────────────────────────────────────────────────────────

/** Resolve the absolute path of a script inside a skill's scripts/ folder.
 *  Path-traversal protected: throws if the resolved path escapes the folder. */
export function getSkillScriptPath(skillName: string, filename: string): string {
  const skill = getSkill(skillName);
  if (!skill) throw new Error(`skill "${skillName}" not found`);
  const fname = validateScriptFilename(filename);
  const scriptsDir = path.join(skill.dir, 'scripts');
  const target = path.resolve(scriptsDir, fname);
  // Defense in depth — even though validateScriptFilename rejects '..' in the
  // input, double-check the resolved path stays inside scriptsDir.
  if (!target.startsWith(path.resolve(scriptsDir) + path.sep) && target !== path.resolve(scriptsDir, fname)) {
    throw new Error(`script "${filename}" escapes skill folder`);
  }
  if (!fs.existsSync(target)) throw new Error(`script "${filename}" not found in skill "${skillName}"`);
  return target;
}

// ── Authoring (create / update / delete) ────────────────────────────────────
// Project-local only. Agents that author skills always write to .claude/skills/
// in the repo so they're version-controllable and shared across all agents.

export interface CreateSkillInput {
  name:         string;
  description?: string;
  body:         string;
  triggers?:    string[];
  tools?:       string[];
  scripts?:     Array<{ filename: string; content: string }>;
  always_on?:   boolean;
  authoredBy?:  string;          // agent id, for audit trail
}

function buildFrontmatter(rec: { name: string; description?: string; triggers?: string[]; tools?: string[]; scripts?: string[]; always_on?: boolean }): string {
  const lines: string[] = ['---', `name: ${rec.name}`];
  if (rec.description) lines.push(`description: ${escapeYamlScalar(rec.description)}`);
  if (rec.triggers && rec.triggers.length > 0) lines.push(`triggers: [${rec.triggers.map(escapeYamlScalar).join(', ')}]`);
  if (rec.tools    && rec.tools.length > 0)    lines.push(`tools: [${rec.tools.map(escapeYamlScalar).join(', ')}]`);
  if (rec.scripts  && rec.scripts.length > 0)  lines.push(`scripts: [${rec.scripts.map(escapeYamlScalar).join(', ')}]`);
  if (rec.always_on === true)                  lines.push(`always_on: true`);
  lines.push('---', '');
  return lines.join('\n');
}

function escapeYamlScalar(s: string): string {
  // Quote anything that could trip our minimal YAML parser (commas, brackets, colons, etc.)
  return /[:,#\[\]{}'"&*?|>]/.test(s) || s.startsWith(' ') || s.endsWith(' ')
    ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : s;
}

function ensureProjectRoot(): void {
  fs.mkdirSync(PROJECT_ROOT, { recursive: true });
}

export interface SkillSummary {
  name:        string;
  description: string;
  path:        string;
  scripts:     string[];
  source:      'project' | 'user' | 'plugin' | 'marketplace';
  always_on:   boolean;
  /** "<plugin>@<marketplace>" identifier for plugin/marketplace-sourced skills. Undefined otherwise. */
  plugin?:     string;
}

export function createSkill(input: CreateSkillInput): SkillSummary {
  const name = sanitizeSkillName(input.name);
  if (getSkill(name)) throw new Error(`skill "${name}" already exists — use manage_skill action="update"`);
  ensureProjectRoot();
  const dir = path.join(PROJECT_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });

  const scriptNames = (input.scripts ?? []).map(s => validateScriptFilename(s.filename));
  if (scriptNames.length > 0) {
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const s of input.scripts ?? []) {
      const fname = validateScriptFilename(s.filename);
      const target = path.join(scriptsDir, fname);
      fs.writeFileSync(target, s.content, 'utf-8');
      // Mark scripts executable so direct exec-shebang works (`#!/usr/bin/env python3`).
      try { fs.chmodSync(target, 0o755); } catch { /* permission errors are non-fatal */ }
    }
  }

  const md = buildFrontmatter({
    name,
    description: input.description ?? '',
    triggers:    input.triggers ?? [],
    tools:       input.tools    ?? [],
    scripts:     scriptNames,
    always_on:   input.always_on === true,
  }) + (input.body ?? '').trim() + '\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf-8');

  clearSkillCache();
  logger.info('skill-loader: created', { name, scripts: scriptNames.length, always_on: input.always_on === true, by: input.authoredBy });
  const created = getSkill(name);
  if (!created) throw new Error('internal: created skill not visible after cache clear');
  return summarize(created);
}

export interface UpdateSkillInput {
  description?: string;
  body?:        string;
  triggers?:    string[];
  tools?:       string[];
  always_on?:   boolean;
}

export function updateSkill(name: string, fields: UpdateSkillInput): SkillSummary {
  const skill = getSkill(name);
  if (!skill) throw new Error(`skill "${name}" not found`);
  if (skill.source !== 'project') throw new Error(`skill "${name}" lives outside the project (.claude/skills/) — only project skills can be edited`);

  const merged = {
    name:        skill.name,
    description: fields.description ?? skill.description,
    triggers:    fields.triggers    ?? skill.triggers,
    tools:       fields.tools       ?? skill.tools,
    scripts:     skill.scripts,
    always_on:   fields.always_on   ?? skill.always_on,
  };
  const body = fields.body ?? skill.body;
  const md = buildFrontmatter(merged) + body.trim() + '\n';
  fs.writeFileSync(skill.path, md, 'utf-8');
  clearSkillCache();
  logger.info('skill-loader: updated', { name, fields: Object.keys(fields) });
  return summarize(getSkill(name)!);
}

export function deleteSkill(name: string): void {
  const skill = getSkill(name);
  if (!skill) throw new Error(`skill "${name}" not found`);
  if (skill.source !== 'project') throw new Error(`skill "${name}" lives outside the project — refusing to delete`);
  fs.rmSync(skill.dir, { recursive: true, force: true });
  clearSkillCache();
  logger.info('skill-loader: deleted', { name });
}

export function writeSkillScript(skillName: string, filename: string, content: string): { path: string; bytes: number } {
  const skill = getSkill(skillName);
  if (!skill) throw new Error(`skill "${skillName}" not found`);
  if (skill.source !== 'project') throw new Error(`skill "${skillName}" is read-only (lives outside the project)`);
  const fname = validateScriptFilename(filename);
  const scriptsDir = path.join(skill.dir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const target = path.join(scriptsDir, fname);
  fs.writeFileSync(target, content, 'utf-8');
  try { fs.chmodSync(target, 0o755); } catch { /* non-fatal */ }

  // Update SKILL.md frontmatter so the new script appears in buildSkillsBlock and
  // is part of the explicit allowlist for any agent prompt that lists scripts.
  const updated = new Set(skill.scripts);
  updated.add(fname);
  const md = buildFrontmatter({
    name:        skill.name,
    description: skill.description,
    triggers:    skill.triggers,
    tools:       skill.tools,
    scripts:     [...updated],
    always_on:   skill.always_on,
  }) + skill.body.trim() + '\n';
  fs.writeFileSync(skill.path, md, 'utf-8');

  clearSkillCache();
  logger.info('skill-loader: wrote script', { skill: skillName, filename: fname, bytes: content.length });
  return { path: target, bytes: Buffer.byteLength(content, 'utf-8') };
}

export function deleteSkillScript(skillName: string, filename: string): void {
  const skill = getSkill(skillName);
  if (!skill) throw new Error(`skill "${skillName}" not found`);
  if (skill.source !== 'project') throw new Error(`skill "${skillName}" is read-only`);
  const fname = validateScriptFilename(filename);
  const target = path.join(skill.dir, 'scripts', fname);
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const remaining = skill.scripts.filter(s => s !== fname);
  const md = buildFrontmatter({
    name:        skill.name,
    description: skill.description,
    triggers:    skill.triggers,
    tools:       skill.tools,
    scripts:     remaining,
    always_on:   skill.always_on,
  }) + skill.body.trim() + '\n';
  fs.writeFileSync(skill.path, md, 'utf-8');

  clearSkillCache();
  logger.info('skill-loader: deleted script', { skill: skillName, filename: fname });
}

function summarize(s: SkillRecord): SkillSummary {
  return {
    name:        s.name,
    description: s.description,
    path:        s.path,
    scripts:     s.scripts,
    source:      s.source,
    always_on:   s.always_on,
    ...(s.plugin ? { plugin: s.plugin } : {}),
  };
}

/** Names of all skills with `always_on: true` in their frontmatter. */
export function getAlwaysOnSkillNames(): string[] {
  return Array.from(getCache().values()).filter(s => s.always_on).map(s => s.name);
}

/** Union an agent's declared skills with every always-on skill in the catalog.
 *  De-duplicated; declared order preserved, then any always-on names appended. */
export function resolveEffectiveSkillNames(declared: string[]): string[] {
  const set = new Set(declared);
  const out = [...declared];
  for (const n of getAlwaysOnSkillNames()) {
    if (!set.has(n)) { set.add(n); out.push(n); }
  }
  return out;
}
