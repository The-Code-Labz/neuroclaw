/**
 * env-manager.ts - Dynamic .env file management for dashboard settings
 * 
 * Provides read/write/schema operations for .env variables with:
 * - Automatic secret detection and masking
 * - Category extraction from .env.example comments
 * - Safe write operations with backup
 * - Integration with config-watcher for live reload
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { configEvents } from './config-watcher';
import dotenv from 'dotenv';
import { resetClient } from '../agent/openai-client';
import { resetAnthropicClient } from '../agent/anthropic-client';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvVariable {
  key: string;
  value: string;
  isSecret: boolean;
  category: string;
  description: string;
  /** True if this variable exists in .env but not in .env.example (custom var) */
  isCustom: boolean;
}

export interface EnvSchema {
  key: string;
  defaultValue: string;
  category: string;
  description: string;
  isSecret: boolean;
}

export interface EnvCategory {
  name: string;
  description: string;
  variables: EnvVariable[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Secret detection patterns
// ─────────────────────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /^API_KEY$/i,
  /^SECRET$/i,
  /^PASSWORD$/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(key));
}

function maskValue(value: string): string {
  if (!value || value.length <= 8) {
    return '***REDACTED***';
  }
  // Show first 4 and last 4 characters for longer values
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// File paths
// ─────────────────────────────────────────────────────────────────────────────

function getEnvPath(): string {
  return path.resolve(process.cwd(), '.env');
}

function getEnvExamplePath(): string {
  return path.resolve(process.cwd(), '.env.example');
}

function getEnvBackupPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(process.cwd(), `.env.backup.${timestamp}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse .env.example to extract schema with categories and descriptions
// ─────────────────────────────────────────────────────────────────────────────

export function parseEnvExample(): EnvSchema[] {
  const examplePath = getEnvExamplePath();
  if (!fs.existsSync(examplePath)) {
    logger.warn('.env.example not found - schema will be empty');
    return [];
  }

  const content = fs.readFileSync(examplePath, 'utf-8');
  const lines = content.split('\n');
  const schema: EnvSchema[] = [];
  
  let currentCategory = 'General';
  let currentDescription = '';
  let descriptionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Category header: # ── Category Name ──
    const categoryMatch = trimmed.match(/^#\s*─+\s*(.+?)\s*─+$/);
    if (categoryMatch) {
      currentCategory = categoryMatch[1].trim();
      // Remove trailing parenthetical descriptions like "(nightly memory consolidation)"
      const parenIdx = currentCategory.indexOf('(');
      if (parenIdx > 0) {
        currentCategory = currentCategory.substring(0, parenIdx).trim();
      }
      descriptionLines = [];
      continue;
    }
    
    // Regular comment - accumulate as description for next variable
    if (trimmed.startsWith('#')) {
      const commentText = trimmed.replace(/^#\s*/, '');
      // Skip comments that are just separators or empty
      if (commentText && !commentText.match(/^─+$/)) {
        descriptionLines.push(commentText);
      }
      continue;
    }
    
    // Empty line - reset description accumulator if we haven't hit a variable
    if (!trimmed) {
      // Only reset if we didn't just process a variable
      if (descriptionLines.length > 0 && schema.length > 0) {
        const lastSchema = schema[schema.length - 1];
        if (lastSchema.description) {
          descriptionLines = [];
        }
      }
      continue;
    }
    
    // Variable line: KEY=value or KEY=
    const varMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (varMatch) {
      const [, key, defaultValue] = varMatch;
      
      // Join accumulated description lines
      currentDescription = descriptionLines.join(' ').trim();
      
      schema.push({
        key,
        defaultValue: defaultValue ?? '',
        category: currentCategory,
        description: currentDescription,
        isSecret: isSecretKey(key),
      });
      
      // Reset description for next variable
      descriptionLines = [];
    }
  }

  return schema;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse current .env file
// ─────────────────────────────────────────────────────────────────────────────

export function parseEnvFile(): Map<string, string> {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) {
    logger.warn('.env not found');
    return new Map();
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  const envMap = new Map<string, string>();
  
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Parse KEY=value (value may contain = signs)
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.substring(0, eqIdx);
      let value = trimmed.substring(eqIdx + 1);
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      envMap.set(key, value);
    }
  }

  return envMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get all env variables with metadata (merged from .env and .env.example)
// ─────────────────────────────────────────────────────────────────────────────

export function getEnvVariables(revealSecrets: boolean = false): EnvVariable[] {
  const schema = parseEnvExample();
  const currentValues = parseEnvFile();
  const schemaKeys = new Set(schema.map(s => s.key));
  const variables: EnvVariable[] = [];

  // First, add all schema variables with current values
  for (const s of schema) {
    const currentValue = currentValues.get(s.key) ?? s.defaultValue;
    const displayValue = s.isSecret && !revealSecrets ? maskValue(currentValue) : currentValue;
    
    variables.push({
      key: s.key,
      value: displayValue,
      isSecret: s.isSecret,
      category: s.category,
      description: s.description,
      isCustom: false,
    });
  }

  // Add any custom variables from .env that aren't in schema
  for (const [key, value] of currentValues) {
    if (!schemaKeys.has(key)) {
      const isSecret = isSecretKey(key);
      const displayValue = isSecret && !revealSecrets ? maskValue(value) : value;
      
      variables.push({
        key,
        value: displayValue,
        isSecret,
        category: 'Custom',
        description: 'Custom variable (not in .env.example)',
        isCustom: true,
      });
    }
  }

  return variables;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get env variables grouped by category
// ─────────────────────────────────────────────────────────────────────────────

export function getEnvByCategory(revealSecrets: boolean = false): EnvCategory[] {
  const variables = getEnvVariables(revealSecrets);
  const categoryMap = new Map<string, EnvVariable[]>();
  
  // Preserve category order from schema
  const categoryOrder: string[] = [];
  
  for (const v of variables) {
    if (!categoryMap.has(v.category)) {
      categoryMap.set(v.category, []);
      categoryOrder.push(v.category);
    }
    categoryMap.get(v.category)!.push(v);
  }

  // Build result in order
  const categories: EnvCategory[] = [];
  for (const name of categoryOrder) {
    categories.push({
      name,
      description: getCategoryDescription(name),
      variables: categoryMap.get(name) ?? [],
    });
  }

  return categories;
}

function getCategoryDescription(category: string): string {
  const descriptions: Record<string, string> = {
    'General': 'Core configuration settings',
    'Auto-delegation': 'LLM-based message routing to agents',
    'Temporary agent spawning': 'Dynamic agent creation settings',
    'Claude / Anthropic integration': 'Claude CLI and Anthropic API configuration',
    'Codex': 'OpenAI Codex CLI integration',
    'Gemini CLI': 'Google Gemini CLI integration',
    'Langfuse integration': 'LLM observability and tracing',
    'MCP + NeuroVault': 'Memory server and knowledge base connections',
    'Dream cycle': 'Nightly memory consolidation',
    'Memory pipeline': 'Automatic memory extraction settings',
    'Model triage': 'Per-task model selection configuration',
    'Auto context compaction': 'Session history summarization',
    'Heartbeat': 'Keep-alive for agents and MCP connections',
    'Exec tools': 'Filesystem and shell access for agents',
    'Vision': 'Image processing configuration',
    'Audio': 'TTS and transcription settings',
    'Memory graph extraction': 'Entity and relationship extraction',
    'Memory embeddings': 'Semantic search configuration',
    'Discord-as-frontend bot': 'Discord bot integration',
    'Browser tools': 'Browserless integration for web scraping',
    'Composio': 'External app toolkit integration',
    'Custom': 'User-defined variables not in .env.example',
  };
  return descriptions[category] ?? category;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update env variables (writes to .env file)
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvUpdateResult {
  success: boolean;
  updated: string[];
  added: string[];
  errors: string[];
  backupPath?: string;
}

export function updateEnvVariables(
  updates: Record<string, string>,
  options: { backup?: boolean; skipSecretValidation?: boolean } = {}
): EnvUpdateResult {
  const { backup = true, skipSecretValidation = false } = options;
  const envPath = getEnvPath();
  const result: EnvUpdateResult = {
    success: false,
    updated: [],
    added: [],
    errors: [],
  };

  // Validate updates
  for (const [key, value] of Object.entries(updates)) {
    // Check if this is a masked value that shouldn't be written
    if (!skipSecretValidation && value.includes('***REDACTED***')) {
      result.errors.push(`${key}: Cannot write masked value - provide the actual value`);
      continue;
    }
    // Basic key validation
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      result.errors.push(`${key}: Invalid key format (must be UPPER_SNAKE_CASE)`);
    }
  }

  if (result.errors.length > 0) {
    return result;
  }

  try {
    // Read existing .env content (preserving comments and structure)
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf-8');
    }

    // Create backup if requested
    if (backup && content) {
      const backupPath = getEnvBackupPath();
      fs.writeFileSync(backupPath, content, { mode: 0o600 });
      result.backupPath = backupPath;
      logger.info('env-mgr: created .env backup at ' + backupPath);
    }

    // Track which keys we've updated
    const existingKeys = new Set<string>();
    const lines = content.split('\n');
    const newLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Preserve comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) {
        newLines.push(line);
        continue;
      }

      // Check if this is a variable line
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx);
        existingKeys.add(key);
        
        if (key in updates) {
          // Update this variable
          const newValue = updates[key];
          // Quote value if it contains special characters
          const quotedValue = needsQuoting(newValue) ? `"${escapeValue(newValue)}"` : newValue;
          newLines.push(`${key}=${quotedValue}`);
          result.updated.push(key);
        } else {
          // Keep existing line
          newLines.push(line);
        }
      } else {
        newLines.push(line);
      }
    }

    // Add new variables that weren't in the file
    for (const [key, value] of Object.entries(updates)) {
      if (!existingKeys.has(key)) {
        const quotedValue = needsQuoting(value) ? `"${escapeValue(value)}"` : value;
        newLines.push(`${key}=${quotedValue}`);
        result.added.push(key);
      }
    }

    // Write updated content
    fs.writeFileSync(envPath, newLines.join('\n'), { mode: 0o600 });
    
    // Reload dotenv to update process.env
    dotenv.config({ path: envPath, override: true });
    
    // Reset API clients
    resetClient();
    resetAnthropicClient();
    
    // Emit change event for SSE subscribers
    configEvents.emit('change');
    
    result.success = true;
    logger.info(`.env updated: ${result.updated.length} updated, ${result.added.length} added`);
    
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to write .env: ${msg}`);
    logger.error('env-mgr: failed to update .env', err);
  }

  return result;
}

function needsQuoting(value: string): boolean {
  // Quote if contains spaces, special chars, or starts/ends with quotes
  return /[\s#"'\\]/.test(value) || value.startsWith('"') || value.startsWith("'");
}

function escapeValue(value: string): string {
  // Escape backslashes and double quotes
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete env variables
// ─────────────────────────────────────────────────────────────────────────────

export function deleteEnvVariable(key: string, backup: boolean = true): EnvUpdateResult {
  const envPath = getEnvPath();
  const result: EnvUpdateResult = {
    success: false,
    updated: [],
    added: [],
    errors: [],
  };

  if (!fs.existsSync(envPath)) {
    result.errors.push('.env file not found');
    return result;
  }

  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    
    // Create backup
    if (backup) {
      const backupPath = getEnvBackupPath();
      fs.writeFileSync(backupPath, content, { mode: 0o600 });
      result.backupPath = backupPath;
    }

    const lines = content.split('\n');
    const newLines: string[] = [];
    let found = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const lineKey = trimmed.substring(0, eqIdx);
        if (lineKey === key) {
          found = true;
          continue; // Skip this line (delete it)
        }
      }
      newLines.push(line);
    }

    if (!found) {
      result.errors.push(`Variable ${key} not found in .env`);
      return result;
    }

    fs.writeFileSync(envPath, newLines.join('\n'));
    
    // Remove from process.env
    delete process.env[key];
    
    // Reload and emit change
    dotenv.config({ path: envPath, override: true });
    configEvents.emit('change');
    
    result.success = true;
    result.updated.push(key);
    logger.info(`env-mgr: deleted env variable: ${key}`);
    
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to delete variable: ${msg}`);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get raw env value (for secret reveal with proper auth)
// ─────────────────────────────────────────────────────────────────────────────

export function getRawEnvValue(key: string): string | null {
  const envMap = parseEnvFile();
  return envMap.get(key) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get schema only (for reference/documentation)
// ─────────────────────────────────────────────────────────────────────────────

export function getEnvSchema(): EnvSchema[] {
  return parseEnvExample();
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect new variables in .env that process.env doesn't have yet
// (useful after external edit)
// ─────────────────────────────────────────────────────────────────────────────

export function detectNewVariables(): string[] {
  const fileVars = parseEnvFile();
  const newVars: string[] = [];
  
  for (const key of fileVars.keys()) {
    if (!(key in process.env) || process.env[key] !== fileVars.get(key)) {
      newVars.push(key);
    }
  }
  
  return newVars;
}
