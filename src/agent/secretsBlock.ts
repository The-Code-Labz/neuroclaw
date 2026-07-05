/**
 * agent/secretsBlock.ts — prompt awareness block (spec Layer C).
 *
 * Renders the broker secrets a given agent is scoped to into a compact
 * system-prompt section: names + service/type + notes, never values.
 * Appended to the system prompt each turn by the alfred.ts prompt builders.
 *
 * See docs/superpowers/specs/2026-05-15-agent-broker-secret-injection-design.md
 */
import { listAccessible } from '../broker/agentSecrets';

/** Max secret rows rendered inline before collapsing to an overflow line. */
const MAX_ROWS = 30;

/**
 * Build the scoped-secrets awareness block for `agentId`. Returns '' when the
 * agent has no scoped secrets (or broker storage is unavailable — `listAccessible`
 * is degraded-safe and returns []). Names + metadata only; never values.
 */
export async function buildSecretsBlock(agentId: string | null): Promise<string> {
  const metas = await listAccessible(agentId);
  if (metas.length === 0) return '';

  const shown = metas.slice(0, MAX_ROWS);
  const rows = shown.map((m) => {
    const note = m.notes.trim() ? ` — ${m.notes.trim()}` : '';
    return `- ${m.name} (${m.service}/${m.type})${note}`;
  });

  let block =
    '\n\n---\nBroker secrets you are scoped to (names only — values are never shown to you):\n' +
    rows.join('\n');
  if (metas.length > MAX_ROWS) {
    block += `\n…and ${metas.length - MAX_ROWS} more — call the \`secrets_list\` tool to see them all.`;
  }
  block +=
    '\nTo use one, pass its name in the `secrets` argument of `bash_run` or `run_skill_script`; ' +
    'credential-aware tools resolve them automatically. You never see or handle the value.';
  return block;
}
