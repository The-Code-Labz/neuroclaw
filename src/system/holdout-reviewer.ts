import type { AppTask } from './task-manager';
import { AggregateVerdict, IssueSeverity, ReviewerIssue } from './review-council';
import { bgChatCompletion } from '../agent/openai-client';
import { getDb } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';

const MAX_ARTIFACT_CHARS = 6000;

function coerceSeverity(v: unknown): IssueSeverity {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low' || s === 'none') return s;
  return 'none';
}

function coerceIssues(v: unknown): ReviewerIssue[] {
  if (!Array.isArray(v)) return [];
  return v.map(raw => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      location: typeof o.location === 'string' ? o.location : '',
      problem:  typeof o.problem  === 'string' ? o.problem  : '',
      fix:      typeof o.fix      === 'string' ? o.fix      : '',
      severity: coerceSeverity(o.severity),
    };
  });
}

function buildArtifact(task: AppTask): string {
  // Prefer the task's own recorded output — it is the literal produced artifact
  // (set on the review transition). Reading the session's last assistant
  // messages is a fallback that is WRONG for subtasks, whose session_id is the
  // PARENT session: it would grade the parent agent's chatter, not the subtask's
  // result. task.output is correct for both agent_tasks and subtasks.
  if (task.output && task.output.trim()) {
    return task.output.length > MAX_ARTIFACT_CHARS
      ? task.output.slice(-MAX_ARTIFACT_CHARS)
      : task.output;
  }
  if (!task.session_id) return '(no session output available — fail-open)';
  const rows = getDb()
    .prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 3"
    )
    .all(task.session_id) as { content: string }[];
  if (rows.length === 0) return '(no agent output found — fail-open)';
  const combined = rows.reverse().map(r => r.content).join('\n\n---\n\n');
  return combined.length > MAX_ARTIFACT_CHARS
    ? combined.slice(-MAX_ARTIFACT_CHARS)
    : combined;
}

const SYSTEM_PROMPT = `You are a holdout reviewer. You did not implement this task. \
Evaluate whether the produced output satisfies the original specification. \
Do NOT consider how the task was done — only whether the result matches what was asked.

Return JSON with this exact shape:
{
  "passed": boolean,
  "severity": "none" | "low" | "medium" | "high" | "critical",
  "issues": [{ "location": string, "problem": string, "fix": string, "severity": "none"|"low"|"medium"|"high"|"critical" }],
  "summary": string
}

If there is no agent output to evaluate, return:
{ "passed": true, "severity": "none", "issues": [], "summary": "fail-open: no artifact" }`;

function failOpen(): AggregateVerdict {
  return {
    passed: true,
    verdicts: [{
      reviewer:  'completion',
      passed:    true,
      severity:  'none',
      issues:    [],
      summary:   'holdout reviewer unavailable (fail-open)',
    }],
    blocking: [],
    feedback: '',
  };
}

export async function runHoldoutReview(task: AppTask): Promise<AggregateVerdict> {
  const artifact      = buildArtifact(task);
  const priorFeedback = task.reviewer_feedback
    ? `\n\nPRIOR REVIEWER FEEDBACK:\n${task.reviewer_feedback}`
    : '';
  const userPrompt = `SPEC:\n${task.title}\n${task.description ?? ''}${priorFeedback}\n\nAGENT OUTPUT:\n${artifact}`;

  let raw: string;
  try {
    // The holdout reviewer is a quality gate — keep its STRONG model on both
    // tiers (VoidAI gpt-5.1 first, OpenRouter claude-sonnet-4 fallback), not the
    // gemini-flash background default.
    const resp = await bgChatCompletion({
      model:           config.voidai.model,
      max_tokens:      3000,
      temperature:     0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    }, { voidaiModel: config.voidai.model, openrouterModel: config.openrouter.model, label: 'holdout-reviewer' });
    raw = resp.choices[0]?.message?.content ?? '';
  } catch (err) {
    logger.warn('holdout: LLM call failed (fail-open)', {
      taskId: task.id,
      error:  (err as Error).message,
    });
    return failOpen();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('holdout: JSON parse failed (fail-open)', { taskId: task.id, raw });
    return failOpen();
  }

  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const verdict = {
    reviewer: 'completion' as const,
    passed:   obj.passed === true,
    severity: coerceSeverity(obj.severity),
    issues:   coerceIssues(obj.issues),
    summary:  typeof obj.summary === 'string' ? obj.summary : '',
  };

  const blocking = verdict.issues.filter(i => i.severity === 'high' || i.severity === 'critical');
  const passed   = verdict.passed && blocking.length === 0;

  const feedback = passed
    ? ''
    : `### holdout review (${verdict.severity})\n${verdict.summary}\n` +
      verdict.issues
        .map(i => `- [${i.severity}] ${i.location || '(unspecified)'}: ${i.problem}\n  Fix: ${i.fix}`)
        .join('\n');

  logHive(passed ? 'review_passed' : 'review_failed', `holdout: Holdout review for task "${task.title}": ${passed ? 'PASSED' : `FAILED (${verdict.severity})`}`, undefined, { taskId: task.id, passed, severity: verdict.severity, issues: verdict.issues.length });

  return { passed, verdicts: [verdict], blocking, feedback };
}
