import { bgChatCompletion } from '../agent/openai-client';
import { streamAntigravityChat } from '../providers/antigravity';
import { config } from '../config';
import { logger } from '../utils/logger';
import { combineImportance, clamp01, type ImportanceComponents } from './memory-scorer';
import { logHive } from '../system/hive-mind';
import { searchMemoryIndex } from './memory-service';

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

export interface ExtractedEntity {
  name:        string;          // canonical surface form, e.g. "Composio"
  entity_type?: string;         // optional category: tool | concept | person | project | service
}

export interface ExtractedRelationship {
  subject:     string;          // entity name (matches one of `entities`)
  verb:        string;          // relation: uses, depends_on, prefers, owns, replaces, …
  object:      string;          // entity name
  confidence?: number;          // 0–1
}

export interface ExtractedMemory {
  type:           ExtractedMemoryType;
  title:          string;
  summary:        string;
  content:        string;
  tags:           string[];
  importance:     number;          // composite 0–1
  confidence:     number;          // 0–1
  components:     ImportanceComponents;
  reasoning?:     string;
  entities?:      ExtractedEntity[];        // graph-lite (v1.7+)
  relationships?: ExtractedRelationship[];  // graph-lite (v1.7+)
}

const SYSTEM_PROMPT = `You are a memory extractor for an AI agent system.
Your job is to read a single (user, assistant) exchange and decide if it
contains anything worth remembering long-term. You ALSO extract the named
entities and subject/verb/object relationships, so the memory can be
queried both lexically and as a knowledge-graph node.

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
  "reasoning": string,       // 1 sentence: why
  "entities": [              // 0-8 named things mentioned: tools, projects, people, services, concepts
    { "name": string, "entity_type": "tool" | "concept" | "person" | "project" | "service" | "framework" | "agent" }
  ],
  "relationships": [         // 0-6 subject/verb/object triples between entities you listed
    { "subject": string, "verb": string, "object": string, "confidence": number }
  ]
}

Entity rules:
- Use the canonical name as it appeared (e.g. "Composio", "NeuroClaw", "Discord", "gpt-5.5").
- Skip generic words ("user", "assistant", "memory", "task") unless they're a named project.
- Empty array is fine when nothing notable was named.

Relationship rules:
- subject and object MUST appear in the entities list.
- verb is a short snake_case relation: uses, depends_on, prefers, replaces, owns, configures, integrates_with, mentions, decides_on, etc.
- Skip vague relations ("relates_to", "involves") — leave them out instead of guessing.

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

// Attempts to recover valid JSON from a model response that may be wrapped in
// markdown fences or prefixed with prose (common with lite/flash models).
function repairJson(raw: string): string {
  // Strip ```json ... ``` or ``` ... ``` fences
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Find the first { and last } and extract that slice
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start !== -1 && end > start) return raw.slice(start, end + 1);
  return raw;
}

// entities/relationships are the LAST two keys in the prompt's JSON shape, so
// a response cut off by finish_reason:'length' truncates them first while the
// core fields (memorable/type/title/.../confidence) are already complete and
// valid. Both trailing arrays are optional downstream (empty-array fallback
// already exists), so recovering by dropping them and closing the object is
// safe — same class of fix as the proven decomposer truncation recovery.
function repairTruncatedTail(raw: string): string {
  const cut = raw.search(/,\s*"(entities|relationships)"\s*:/);
  if (cut === -1) return raw;
  return raw.slice(0, cut) + '}';
}

export async function extract(input: ExtractInput): Promise<ExtractedMemory | null> {
  const text = input.assistant_text ?? '';
  if (text.length < config.memory.extractMinChars) {
    return FORCE_NULL(`assistant_text below ${config.memory.extractMinChars} chars`);
  }

  const userBlock = (input.user_text ?? '').slice(0, 4000);
  const asstBlock = text.slice(0, 6000);
  const ctx       = input.context_hint ? `\n\nContext: ${input.context_hint}` : '';

  // Fetch related memories as context so the LLM can detect duplicates and
  // calibrate importance against what's already stored. Searches the live
  // memory store (Supabase pgvector) via memory-service — never blocks or
  // throws upstream (recall context is optional).
  let recallCtx = '';
  try {
    const recallQuery = `${(input.user_text ?? '').slice(0, 120)} ${text.slice(0, 120)}`
      .replace(/[\[\]\(\)"'`*\\,;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (recallQuery.length >= 4) {
      const hits = await searchMemoryIndex(recallQuery, 5);
      if (hits.length > 0) {
        const snippets = hits.slice(0, 4).map(h =>
          `- ${String(h.title ?? 'memory').slice(0, 80)}: ${String(h.summary ?? '').slice(0, 200)}`
        ).join('\n');
        recallCtx = `\n\nRelated memories already stored (use to calibrate importance and detect duplicates):\n${snippets}`;
      }
    }
  } catch {
    // recall context is optional — never block or crash extraction
  }

  const userPrompt = `Source: ${input.source}\nAgent: ${input.agent_name ?? 'unknown'}\n\n[user]\n${userBlock}\n\n[assistant]\n${asstBlock}${ctx}${recallCtx}`;

  const useAntigravity = config.memory.extractProvider === 'antigravity';
  const antigravityModel = config.memory.extractAntigravityModel;
  const fallbackModel    = config.memory.extractModel ?? config.background.model ?? config.voidai.model;
  let raw: string;

  if (useAntigravity) {
    try {
      const chunks: string[] = [];
      for await (const chunk of streamAntigravityChat({
        prompt:       userPrompt,
        systemPrompt: SYSTEM_PROMPT,
        model:        antigravityModel,
      })) {
        chunks.push(chunk);
      }
      raw = chunks.join('').replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    } catch (agErr) {
      logger.warn('memory-extractor: antigravity failed, falling back to OpenRouter', { error: (agErr as Error).message });
      try {
        const resp = await bgChatCompletion({
          model:           fallbackModel,
          max_tokens:      4000,
          temperature:     0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: userPrompt },
          ],
        }, { label: 'memory-extractor', preferGemini: true });
        raw = resp.choices[0]?.message?.content ?? '';
      } catch (fbErr) {
        logger.warn('memory-extractor: fallback LLM call also failed', { error: (fbErr as Error).message });
        return null;
      }
    }
  } else {
    try {
      const resp = await bgChatCompletion({
        model:           fallbackModel,
        max_tokens:      4000,
        temperature:     0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt },
        ],
      }, { label: 'memory-extractor', preferGemini: true });
      raw = resp.choices[0]?.message?.content ?? '';
    } catch (err) {
      logger.warn('memory-extractor: LLM call failed', { error: (err as Error).message });
      return null;
    }
  }

  let parsed: Partial<ExtractedMemory> & { memorable?: boolean };
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(repairJson(raw));
      logger.debug('memory-extractor: recovered JSON after repair');
    } catch {
      try {
        parsed = JSON.parse(repairTruncatedTail(repairJson(raw)));
        logger.warn('memory-extractor: recovered JSON after dropping truncated entities/relationships tail', {
          rawSnippet: raw.slice(-120),
        });
      } catch {
        logger.warn('memory-extractor: JSON parse failed, raw response unrecoverable', {
          rawLength: raw.length, rawSnippet: raw.slice(0, 200), rawTail: raw.slice(-120),
        });
        return FORCE_NULL('JSON parse failed');
      }
    }
  }

  if (parsed.memorable === false) return FORCE_NULL('extractor said memorable=false');
  if (!parsed.title || !parsed.type) return FORCE_NULL('missing title/type');

  const components: ImportanceComponents = parsed.components ?? {};
  const importance = combineImportance(components);
  if (importance < config.memory.importanceThreshold) {
    return FORCE_NULL(`importance ${importance.toFixed(2)} < threshold ${config.memory.importanceThreshold}`);
  }

  const entities: ExtractedEntity[] = [];
  if (Array.isArray(parsed.entities)) {
    for (const e of parsed.entities.slice(0, 8)) {
      const name = String(e?.name ?? '').trim().slice(0, 80);
      if (!name) continue;
      const entity_type = e?.entity_type ? String(e.entity_type).trim().toLowerCase().slice(0, 30) : undefined;
      entities.push({ name, entity_type });
    }
  }

  // Drop relationships whose subject/object aren't in the extracted entity
  // list — keeps the graph well-formed. The 6-relationship cap matches the
  // prompt and keeps any single memory from blowing up the relationship table.
  const entityNameSet = new Set(entities.map(e => e.name.toLowerCase()));
  const relationships: ExtractedRelationship[] = [];
  if (Array.isArray(parsed.relationships)) {
    for (const r of parsed.relationships.slice(0, 6)) {
      const subject = String(r?.subject ?? '').trim().slice(0, 80);
      const verb    = String(r?.verb    ?? '').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40);
      const object  = String(r?.object  ?? '').trim().slice(0, 80);
      if (!subject || !verb || !object) continue;
      if (!entityNameSet.has(subject.toLowerCase()) || !entityNameSet.has(object.toLowerCase())) continue;
      relationships.push({ subject, verb, object, confidence: clamp01(typeof r?.confidence === 'number' ? r.confidence : 0.7) });
    }
  }

  const memory: ExtractedMemory = {
    type:           (parsed.type ?? 'episodic') as ExtractedMemoryType,
    title:          String(parsed.title).slice(0, 120),
    summary:        String(parsed.summary ?? '').slice(0, 600),
    content:        String(parsed.content ?? parsed.summary ?? '').slice(0, 4000),
    tags:           Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10).map(t => String(t).slice(0, 30)) : [],
    importance,
    confidence:     clamp01(parsed.confidence ?? 0.5),
    components,
    reasoning:      parsed.reasoning ? String(parsed.reasoning).slice(0, 240) : undefined,
    entities,
    relationships,
  };

  try {
    logHive('archivist_extracted', `memory-extractor: Archivist extracted "${memory.title}" (${memory.type}, importance ${memory.importance.toFixed(2)})`, input.agent_id ?? undefined, {
        type:       memory.type,
        importance: memory.importance,
        confidence: memory.confidence,
        tags:       memory.tags,
        session_id: input.session_id ?? null,
        agent_name: input.agent_name ?? null,
      });
  } catch { /* never let hive logging crash extraction */ }

  return memory;
}
