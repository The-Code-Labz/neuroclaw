import { bgChatCompletion } from '../agent/openai-client';
import { streamAntigravityChat } from '../providers/antigravity';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';
import { listSkills, createSkill } from '../skills/skill-loader';
import type { MemoryIndexRow } from '../memory/memory-service';

export interface SkillForgeInput {
  sessionId:     string;
  agentId?:      string;
  userText:      string;
  assistantText: string;
  toolCallCount: number;
}

const COMPLEXITY_TOOL_THRESHOLD = 3;
const COMPLEXITY_CHAR_THRESHOLD = 1600; // ≈400 tokens at ~4 chars/token

/**
 * Extract the first balanced JSON object from a model response.
 * Chatty bg models (gemini-3.5-flash / haiku) often return the required
 * `{...}` object followed by a trailing sentence ("This excerpt doesn't
 * contain a reusable skill..."). Naive JSON.parse succeeds on the object
 * then throws "Unexpected non-whitespace character after JSON". This
 * brace-depth scanner (string/escape aware) grabs just the object and
 * ignores any trailing prose — recovering real skills that come wrapped
 * in commentary and silencing the empty-sentinel noise.
 */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) return raw;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return raw.slice(start, i + 1);
    }
  }
  return raw.slice(start);
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\b\w{3,}\b/g) ?? []);
}

function keywordOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

function isComplex(input: SkillForgeInput): boolean {
  return (
    input.toolCallCount >= COMPLEXITY_TOOL_THRESHOLD ||
    input.assistantText.length >= COMPLEXITY_CHAR_THRESHOLD
  );
}

function isNovel(description: string): boolean {
  return !listSkills().some(s => keywordOverlap(s.description, description) > 0.6);
}

interface GeneratedSkill { name: string; description: string; body: string }

const SKILL_SYSTEM =
  'You generate reusable skill documentation from conversation excerpts. ' +
  'Output JSON with keys: ' +
  'name (kebab-case slug ≤40 chars), ' +
  'description (one sentence ≤120 chars), ' +
  'body (step-by-step procedure ≤400 words, no task-specific names or values). ' +
  'Return {"name":"","description":"","body":""} if the content is not worth a skill.';

async function generate(context: string, sessionId: string, agentId?: string): Promise<boolean> {
  const useAntigravity   = config.skillForge.provider === 'antigravity';
  const useOpenRouter    = config.skillForge.provider === 'openrouter';
  const antigravityModel = config.skillForge.antigravityModel;
  // The OpenRouter fallback model: honor SKILL_FORGE_MODEL (default Gemini 2.5
  // Flash Lite). bgChatCompletion() tries the VoidAI bg model (haiku) first, then this.
  const fallbackModel = useOpenRouter
    ? (process.env.SKILL_FORGE_MODEL?.trim() || 'google/gemini-2.5-flash-lite')
    : (config.background.model ?? config.voidai.skillForgeModel);
  let raw: string;

  if (useAntigravity) {
    try {
      const chunks: string[] = [];
      for await (const chunk of streamAntigravityChat({
        prompt:       context,
        systemPrompt: SKILL_SYSTEM,
        model:        antigravityModel,
      })) {
        chunks.push(chunk);
      }
      raw = chunks.join('').replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    } catch (agErr) {
      logHive('skill_forge_fallback', 'skill-forge: antigravity failed, falling back to OpenRouter', agentId,
        { reason: String(agErr), sessionId, fallbackModel });
      try {
        // Native MiniMax-M3 lane — off VoidAI's flaky proxy path.
        const resp = await bgChatCompletion({
          model: fallbackModel,
          messages: [
            { role: 'system', content: SKILL_SYSTEM },
            { role: 'user',   content: context },
          ],
          temperature: 0.3,
        }, { preferMinimax: true, label: 'skill-forge' });
        raw = (resp.choices[0]?.message?.content ?? '{}')
          .replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      } catch (fbErr) {
        logHive('skill_forge_failed', 'skill-forge: fallback also failed', agentId,
          { reason: String(fbErr), sessionId, errorType: 'api' });
        return false;
      }
    }
  } else {
    try {
      // Native MiniMax-M3 lane — off VoidAI's flaky proxy path.
      const resp = await bgChatCompletion({
        model: fallbackModel,
        messages: [
          { role: 'system', content: SKILL_SYSTEM },
          { role: 'user',   content: context },
        ],
        temperature: 0.3,
      }, { preferMinimax: true, label: 'skill-forge' });
      raw = (resp.choices[0]?.message?.content ?? '{}')
        .replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    } catch (err) {
      logHive('skill_forge_failed', 'skill-forge: LLM API error', agentId,
        { reason: String(err), sessionId, errorType: 'api' });
      return false;
    }
  }

  let parsed: GeneratedSkill;
  try {
    parsed = JSON.parse(extractJsonObject(raw)) as GeneratedSkill;
  } catch (err) {
    logHive('skill_forge_failed', 'skill-forge: JSON parse error', agentId,
      { reason: String(err), sessionId, errorType: 'parse', raw: raw.slice(0, 200) });
    return false;
  }

  if (!parsed.name?.trim() || !parsed.body?.trim() || !parsed.description?.trim()) return false;

  if (!isNovel(parsed.description)) {
    logger.debug('skill-forge: not novel, skipping', { name: parsed.name });
    return false;
  }

  try {
    createSkill({
      name:        parsed.name,
      description: parsed.description,
      body:        parsed.body,
      triggers:    [],
      tools:       [],
      scripts:     [],
      always_on:   false,
      authoredBy:  agentId,
    });
    logHive('skill_authored', `skill-forge: authored "${parsed.name}"`, agentId,
      { skill_name: parsed.name, sessionId });
    logger.info('skill-forge: skill authored', { name: parsed.name });
    return true;
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('already exists')) {
      logHive('skill_forge_failed', `skill-forge: createSkill failed: ${msg}`, agentId,
        { reason: msg, sessionId });
    }
    return false;
  }
}

export async function evaluate(input: SkillForgeInput): Promise<void> {
  if (!isComplex(input)) return;
  const context =
    `User: ${input.userText.slice(0, 800)}\n\nAssistant: ${input.assistantText.slice(0, 2000)}`;
  await generate(context, input.sessionId, input.agentId);
}

export async function generateFromMemory(memory: MemoryIndexRow): Promise<void> {
  try {
    const authored = await generate(
      `Recurring procedural memory:\nTitle: ${memory.title}\n${memory.summary ?? ''}`,
      memory.session_id ?? 'dream-cycle',
      memory.agent_id ?? undefined,
    );
    if (authored) {
      logHive('skill_promoted_from_memory',
        `skill-forge: promoted procedural memory "${memory.title}"`,
        memory.agent_id ?? undefined,
        { memory_id: memory.id });
    }
  } catch (err) {
    logger.debug('skill-forge: generateFromMemory swallowed error', { reason: String(err) });
  }
}
