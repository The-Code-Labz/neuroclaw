import { bgChatCompletion } from '../agent/openai-client';
import { getSessionById, getSessionMessages, updateSessionTitle } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

// Only sessions a human actually reads get auto-titled. Machinery sources
// (comms/spawn/step/sentinel/cron/agent_task/unknown) are skipped so the titler
// never burns background-model calls on the highest-volume internal population.
const TITLEABLE_SOURCES = new Set(['dashboard', 'cli', 'terminal', 'voice', 'discord', 'room']);

/**
 * Best-effort auto-title generator. Reads the first user + assistant messages,
 * asks a cheap background model for a 3–6 word title, and stores it with
 * title_source='auto'. Fire-and-forget — never throws.
 *
 * Guards (skipped when opts.force): the title is still system-generated
 * (title_source === 'default'), the session has >= 2 messages (one user + one
 * assistant), and its source is user-facing.
 */
export async function maybeGenerateSessionTitle(
  sessionId: string,
  opts?: { force?: boolean },
): Promise<void> {
  try {
    const session = getSessionById(sessionId);
    if (!session) return;
    if (!opts?.force) {
      if (session.title_source !== 'default') return;                 // never clobber user/auto title
      if ((session.message_count ?? 0) < 2) return;                   // need a real exchange
      if (!TITLEABLE_SOURCES.has(session.source ?? 'unknown')) return; // user-facing sources only
    }

    const messages = getSessionMessages(sessionId);
    const firstUser = messages.find((m) => m.role === 'user');
    const firstAssistant = messages.find((m) => m.role === 'assistant');
    const userText = firstUser?.content?.slice(0, 1500) ?? '';
    const assistantText = firstAssistant?.content?.slice(0, 500) ?? '';
    if (!userText) return;

    const prompt = `Generate a concise, descriptive chat title (3-6 words, no quotes, no punctuation at the end) based on this conversation:

User: ${userText}

Assistant: ${assistantText}

Title:`;

    const model = config.voidai.decomposerModel ?? config.background.model;
    const completion = await bgChatCompletion({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 20,
    }, { preferMinimax: true, label: 'session-namer' });

    const generated = completion.choices[0]?.message?.content?.trim() ?? '';
    if (!generated) return;

    const clean = generated
      .replace(/^["']|["']$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (clean.length < 2) return;

    // Re-check provenance right before writing: a manual rename may have landed
    // while the model call was in flight. Only overwrite a still-'default' title
    // (skip when force — the caller explicitly wants a rewrite).
    if (!opts?.force) {
      const fresh = getSessionById(sessionId);
      if (!fresh || fresh.title_source !== 'default') return;
    }

    updateSessionTitle(sessionId, clean, 'auto');
    logger.info('Auto-generated session title', { sessionId, title: clean });
  } catch (err) {
    // Never throw — title generation is a best-effort enhancement.
    logger.warn('Session title generation failed', { sessionId, error: (err as Error).message });
  }
}
