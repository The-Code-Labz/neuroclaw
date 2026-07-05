// src/skills/telemetry.ts
//
// Thin wrapper that records per-skill injection events. Called once per chat
// turn from each of the four alfred.ts code paths (voidai, anthropic, claude
// CLI, and the generic completion path).
//
// Why a separate module:
//   - skill-loader.ts is intentionally pure file-IO; it must not import the
//     DB so it can be used in contexts (CLI tools, tests) without one.
//   - alfred.ts has four sites that do the same logging — better one helper
//     than four near-identical try/catch blocks.
//
// Failure is intentionally silent. Telemetry must never block a chat turn.

import { recordSkillInvocation } from '../db';
import {
  buildSkillsBlock,
  parseAgentSkills,
  resolveEffectiveSkillsDetailed,
  type BuildSkillsBlockOptions,
} from './skill-loader';
import { logger } from '../utils/logger';

export interface RenderSkillsForAgentInput {
  /** Raw value from agents.skills (JSON string of declared skill names). */
  agentSkills?: string | null;
  /** Agent ID (nullable for orphaned sessions). */
  agentId?:    string | null;
  /** Session ID (nullable when called outside a chat session). */
  sessionId?:  string | null;
  /** Agent's model_tier — shapes the skill body and is recorded for telemetry. */
  tier?:       string | null;
}

/**
 * One-stop helper used by every alfred code path:
 *
 *   1. Resolves the agent's declared skills + any always-on skills.
 *   2. Builds the tier-shaped markdown block to append to the system prompt.
 *   3. Records one telemetry row per effectively-injected skill.
 *
 * Returns the markdown block (empty string when no skills are active). The
 * caller appends it to the system prompt verbatim — identical behavior to
 * the old `buildSkillsBlock(resolveEffectiveSkillNames(...), { tier })` call,
 * except the side-effect of writing telemetry rows is folded in.
 */
export function renderSkillsForAgent(inp: RenderSkillsForAgentInput): string {
  const declared = parseAgentSkills(inp.agentSkills);
  const effective = resolveEffectiveSkillsDetailed(declared);
  if (effective.length === 0) return '';

  const opts: BuildSkillsBlockOptions = { tier: inp.tier };
  const block = buildSkillsBlock(effective.map(e => e.name), opts);

  // Record telemetry only when a block was actually produced. If the loader
  // failed to find any of the declared skills, we don't want phantom rows.
  if (block) {
    try {
      for (const e of effective) {
        recordSkillInvocation({
          skillName: e.name,
          agentId:   inp.agentId   ?? null,
          sessionId: inp.sessionId ?? null,
          tier:      inp.tier      ?? null,
          source:    e.source,
        });
      }
    } catch (err) {
      // Telemetry write failure is non-fatal; just log it once for diagnostics.
      logger.warn('skill-telemetry: failed to record invocation', {
        error: (err as Error).message,
        count: effective.length,
      });
    }
  }

  return block;
}
