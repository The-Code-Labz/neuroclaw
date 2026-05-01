import { getClient } from '../agent/openai-client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { combineImportance, clamp01, type ImportanceComponents } from './memory-scorer';

// LLM-backed memory extractor. Reads a recent (user, assistant) exchange and
// classifies it into a structured memory candidate. Returns null when the
// extractor decides the content isn't worth remembering, or when the score
// falls below MEMORY_IMPORTANCE_THRESHOLD.

export type ExtractedMemoryType =
  | 'episodic' | 'semantic' | 'procedural' | 'preference' | 'insight';

export interface ExtractInput {
  source:      'chat' | 'task' | 'agent_result';
  agent_id?:   string | null;
  agent_name?: string | null;
  session_id?: string | null;
  user_text?:  string;          // last user turn
  assistant_text: string;        // current assistant turn / event payload
  context_hint?: string;         // optional extra context (e.g. "user said: 'remember this'")
}

export interface ExtractedMemory {
  type:        ExtractedMemoryType;
  title:       string;
  summary:     string;
  content:     string;
  tags:        string[];
  importance:  number;          // composite 0–1
  confidence:  number;          // 0–1
  components:  ImportanceComponents;
  reasoning?:  string;
}

const SYSTEM_PROMPT = `You are a memory extractor for an AI agent system.
Your job is to read a single (user, assistant) exchange and decide if it
contains anything worth remembering long-term.

You MUST output a single JSON object with this exact shape:
{
  "memorable": boolean,
  "type": "episodic" | "semantic" | "procedural" | "preference" | "insight",
  "title": string,           // short, 4-8 words
  "summary": string,         // 1-2 sentences
  "content": string,         // 2-5 sentences, denser than summary
  "tags": string[],          // 2-5 lowercase keywords
  "components": {
    "relevance":         number,  // 0–1: is this relevant to ongoing work?
    "recurrence":        number,  // 0–1: does this look like a repeated pattern?
    "usefulness":        number,  // 0–1: would future-self benefit from this?
    "user_emphasis":     number,  // 0–1: did the user say "remember"/"important"/etc?
    "correction_weight": number   // 0–1: did the assistant correct a prior mistake?
  },
  "confidence": number,      // 0–1: how sure you are this is worth saving
  "reasoning": string        // 1 sentence: why
}

Type guide:
- episodic     = a specific event, decision, or moment
- semantic     = a fact / piece of knowledge
- procedural   = a how-to or repeatable fix
- preference   = something the user prefers or wants done a certain way
- insight      = a meta-pattern or learned heuristic

Set "memorable": false for:
- small talk / greetings
- one-shot factual answers the user could trivially re-derive
- error chains where nothing was actually fixed
- anything where the user didn't engage with the response

When unsure, prefer "memorable": false. Saving noise is worse than missing a memory.

Respond with ONLY the JSON object — no prose, no code fences.`;

const FORCE_NULL = (reason: string): null => {
  logger.debug('memory-extractor: skipped', { reason });
  return null;
};

export async function extract(input: ExtractInput): Promise<ExtractedMemory | null> {
  const text = input.assistant_text ?? '';
  if (text.length < config.memory.extractMinChars) {
    return FORCE_NULL(`assistant_text below ${config.memory.extractMinChars} chars`);
  }

  const userBlock = (input.user_text ?? '').slice(0, 4000);
  const asstBlock = text.slice(0, 6000);
  const ctx       = input.context_hint ? `\n\nContext: ${input.context_hint}` : '';
  const userPrompt = `Source: ${input.source}\nAgent: ${input.agent_name ?? 'unknown'}\n\n[user]\n${userBlock}\n\n[assistant]\n${asstBlock}${ctx}`;

  const model = config.memory.extractModel ?? config.voidai.model;
  let raw: string;
  try {
    const resp = await getClient().chat.completions.create({
      model,
      max_tokens: 600,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    });
    raw = resp.choices[0]?.message?.content ?? '';
  } catch (err) {
    logger.warn('memory-extractor: LLM call failed', { error: (err as Error).message });
    return null;
  }

  let parsed: Partial<ExtractedMemory> & { memorable?: boolean };
  try { parsed = JSON.parse(raw); } catch {
    return FORCE_NULL('JSON parse failed');
  }

  if (parsed.memorable === false) return FORCE_NULL('extractor said memorable=false');
  if (!parsed.title || !parsed.type) return FORCE_NULL('missing title/type');

  const components: ImportanceComponents = parsed.components ?? {};
  const importance = combineImportance(components);
  if (importance < config.memory.importanceThreshold) {
    return FORCE_NULL(`importance ${importance.toFixed(2)} < threshold ${config.memory.importanceThreshold}`);
  }

  const memory: ExtractedMemory = {
    type:       (parsed.type ?? 'episodic') as ExtractedMemoryType,
    title:      String(parsed.title).slice(0, 120),
    summary:    String(parsed.summary ?? '').slice(0, 600),
    content:    String(parsed.content ?? parsed.summary ?? '').slice(0, 4000),
    tags:       Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10).map(t => String(t).slice(0, 30)) : [],
    importance,
    confidence: clamp01(parsed.confidence ?? 0.5),
    components,
    reasoning:  parsed.reasoning ? String(parsed.reasoning).slice(0, 240) : undefined,
  };
  return memory;
}
