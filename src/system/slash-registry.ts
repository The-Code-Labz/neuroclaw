import { stopStream } from './stream-control';
import { clearHistory } from '../agent/alfred';
import { getDb, getAgentByName, updateSessionTitle, setSessionPinned, setSessionStatus, getSessionById, setSessionChatMode } from '../db';

export type Surface = 'cli' | 'dashboard' | 'discord';

export interface SlashContext {
  sessionId: string;
  surface: Surface;
  agentId?: string;
  reply: (text: string) => void | Promise<void>;
}

export type SlashOptionType = 'string' | 'integer' | 'boolean';

/**
 * Declarative argument schema for a command. Surfaces that support native
 * argument entry (Discord's `/` autocomplete popup) register these so the
 * user gets typed, validated fields instead of a bare command name. The
 * handler contract stays `(ctx, args: string)` — the surface reconstructs the
 * raw args string from the option values via `reconstructArgs`.
 */
export interface SlashOption {
  name: string;
  description: string;
  type: SlashOptionType;
  required?: boolean;
}

interface SlashCommand {
  description: string;
  surfaces?: Surface[];
  options?: SlashOption[];
  handler: (ctx: SlashContext, args: string) => void | Promise<void>;
}

const builtins = new Map<string, SlashCommand>();

export function registerBuiltin(name: string, cmd: SlashCommand): void {
  builtins.set(name, cmd);
}

/** Returns commands available on the given surface (or all commands if no surface given). */
export function getCommandCatalog(
  surface?: Surface,
): { name: string; description: string; options?: SlashOption[] }[] {
  return Array.from(builtins.entries())
    .filter(([, cmd]) => !surface || !cmd.surfaces || cmd.surfaces.includes(surface))
    .map(([name, cmd]) => ({ name, description: cmd.description, options: cmd.options }));
}

/**
 * Rebuild the raw args string a `(ctx, args)` handler expects from native
 * option values (declared order). String/integer options contribute their
 * value; boolean options are flag-like — they contribute their own NAME when
 * true and nothing when false/absent (so `/pin off:true` → args `"off"`,
 * matching the typed `/pin off` contract). Empty/absent values are skipped.
 */
export function reconstructArgs(
  options: SlashOption[] | undefined,
  get: (name: string) => string | number | boolean | null | undefined,
): string {
  if (!options || options.length === 0) return '';
  const parts: string[] = [];
  for (const opt of options) {
    const v = get(opt.name);
    if (v === null || v === undefined) continue;
    if (opt.type === 'boolean') {
      if (v === true) parts.push(opt.name);
    } else {
      const s = String(v).trim();
      if (s) parts.push(s);
    }
  }
  return parts.join(' ');
}

export function parseSlash(message: string): { name: string; args: string } | null {
  if (!message.startsWith('/')) return null;
  const rest = message.slice(1);
  const spaceIdx = rest.indexOf(' ');
  const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
  return builtins.has(name) ? { name, args } : null;
}

export async function dispatchSlash(message: string, ctx: SlashContext): Promise<boolean> {
  const parsed = parseSlash(message);
  if (!parsed) return false;
  const cmd = builtins.get(parsed.name)!;
  if (cmd.surfaces && !cmd.surfaces.includes(ctx.surface)) return false;
  await cmd.handler(ctx, parsed.args);
  return true;
}

registerBuiltin('stop', {
  description: 'Stop the current streaming response',
  handler: async (ctx) => {
    const stopped = stopStream(ctx.sessionId);
    await ctx.reply(stopped ? '// stream stopped' : '// no active stream');
  },
});

registerBuiltin('clear', {
  description: 'Clear chat history for this session',
  handler: async (ctx) => {
    clearHistory(ctx.sessionId);
    await ctx.reply('// chat history cleared');
  },
});

registerBuiltin('status', {
  description: 'Show system status',
  handler: async (ctx) => {
    const db = getDb();
    const active = (db.prepare("SELECT COUNT(*) as n FROM agents WHERE status = 'active'").get() as { n: number }).n;
    const msgs = (db.prepare('SELECT COUNT(*) as n FROM messages WHERE session_id = ?').get(ctx.sessionId) as { n: number }).n;
    await ctx.reply(`// active agents: ${active} · session messages: ${msgs}`);
  },
});

registerBuiltin('usage', {
  description: 'Show token usage and estimated cost summary',
  handler: async (ctx) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        s.provider,
        COALESCE(SUM(s.input_tokens + s.output_tokens), 0) AS total_tokens,
        COUNT(*) AS call_count,
        COALESCE(SUM(
          (s.input_tokens  / 1000.0) * COALESCE(c.cost_per_1k_input,  0) +
          (s.output_tokens / 1000.0) * COALESCE(c.cost_per_1k_output, 0)
        ), 0) AS est_cost_usd
      FROM model_spend s
      LEFT JOIN model_catalog c
        ON c.provider = s.provider AND c.model_id = s.model_id
      GROUP BY s.provider
      ORDER BY total_tokens DESC
    `).all() as { provider: string; total_tokens: number; call_count: number; est_cost_usd: number }[];

    if (rows.length === 0) {
      await ctx.reply('// no usage recorded yet');
      return;
    }

    let totalTokens = 0;
    let totalCalls = 0;
    let totalCost = 0;

    const lines = rows.map(r => {
      totalTokens += r.total_tokens;
      totalCalls += r.call_count;
      totalCost += r.est_cost_usd;
      const tokensStr = r.total_tokens >= 1000000
        ? `${(r.total_tokens / 1000000).toFixed(2)}M`
        : r.total_tokens >= 1000
          ? `${(r.total_tokens / 1000).toFixed(1)}K`
          : String(r.total_tokens);
      const costStr = r.est_cost_usd > 0 ? `$${r.est_cost_usd.toFixed(2)}` : '—';
      return `  ${r.provider.padEnd(15)} ${tokensStr.padStart(10)} ${String(r.call_count).padStart(8)} calls ${costStr.padStart(10)}`;
    });

    const totalTokensStr = totalTokens >= 1000000
      ? `${(totalTokens / 1000000).toFixed(2)}M`
      : totalTokens >= 1000
        ? `${(totalTokens / 1000).toFixed(1)}K`
        : String(totalTokens);

    await ctx.reply(
      `// model usage summary:\n` +
      `  PROVIDER            TOKENS    CALLS      EST COST\n` +
      lines.join('\n') + '\n' +
      `  ${'-'.repeat(50)}\n` +
      `  ${'TOTAL'.padEnd(15)} ${totalTokensStr.padStart(10)} ${String(totalCalls).padStart(8)} calls $${totalCost.toFixed(2)}`
    );
  },
});

registerBuiltin('help', {
  description: 'List all available commands',
  handler: async (ctx) => {
    const lines = Array.from(builtins.entries())
      .filter(([, cmd]) => !cmd.surfaces || cmd.surfaces.includes(ctx.surface))
      .map(([name, cmd]) => `/${name} — ${cmd.description}`);
    await ctx.reply(lines.join('\n'));
  },
});

registerBuiltin('agent', {
  description: 'Switch the active agent',
  surfaces: ['dashboard'],
  handler: async (ctx, args) => {
    if (!args) { await ctx.reply('// usage: /agent [name]'); return; }
    const agent = getAgentByName(args);
    if (!agent || agent.status !== 'active') { await ctx.reply(`// no active agent named '${args}'`); return; }
    await ctx.reply(`// agent found: ${agent.name} — select it in the chat sidebar`);
  },
});

registerBuiltin('rename', {
  description: 'Rename this session: /rename <new title>',
  options: [
    { name: 'title', description: 'New session title', type: 'string', required: true },
  ],
  handler: async (ctx, args) => {
    const title = args.trim();
    if (!title) { await ctx.reply('// usage: /rename <new title>'); return; }
    updateSessionTitle(ctx.sessionId, title.slice(0, 120), 'user');
    await ctx.reply(`// session renamed: ${title.slice(0, 120)}`);
  },
});

registerBuiltin('pin', {
  description: 'Pin (or /pin off) this session so it is never auto-cleaned',
  options: [
    { name: 'off', description: 'Set true to UNPIN this session', type: 'boolean', required: false },
  ],
  handler: async (ctx, args) => {
    const off = args.trim().toLowerCase() === 'off';
    setSessionPinned(ctx.sessionId, !off);
    await ctx.reply(off ? '// session unpinned' : '// session pinned');
  },
});

registerBuiltin('archive', {
  description: 'Archive (or /archive off) this session',
  options: [
    { name: 'off', description: 'Set true to UNARCHIVE this session', type: 'boolean', required: false },
  ],
  handler: async (ctx, args) => {
    const off = args.trim().toLowerCase() === 'off';
    setSessionStatus(ctx.sessionId, off ? 'active' : 'archived');
    await ctx.reply(off ? '// session unarchived' : '// session archived');
  },
});

registerBuiltin('mode', {
  description: 'Switch this session between chat mode (plain, no tools) and agent mode (full tools/skills); /mode alone shows current',
  options: [
    { name: 'mode', description: 'chat | agent | auto (auto clears the override to inherit the agent default)', type: 'string', required: false },
  ],
  handler: async (ctx, args) => {
    const arg = args.trim().toLowerCase();
    const sess = getSessionById(ctx.sessionId);
    const cur = sess?.chat_mode; // null (inherit) | 0 (agent) | 1 (chat)

    const describe = (v: number | null | undefined): string =>
      v == null ? 'AUTO (inherit agent default)'
        : v === 1 ? 'CHAT (plain completion — no tools/skills/MCP)'
          : 'AGENT (full tools, skills & MCP)';

    if (!arg) {
      await ctx.reply(
        `// current mode: ${describe(cur)}\n` +
        `// usage: /mode chat  ·  /mode agent  ·  /mode auto`,
      );
      return;
    }

    if (arg === 'chat' || arg === 'plain') {
      setSessionChatMode(ctx.sessionId, true);
      await ctx.reply('// switched to CHAT mode — plain completion, no tools/skills/MCP');
    } else if (arg === 'agent' || arg === 'full') {
      setSessionChatMode(ctx.sessionId, false);
      await ctx.reply('// switched to AGENT mode — full tools, skills & MCP');
    } else if (arg === 'auto' || arg === 'default' || arg === 'clear' || arg === 'inherit') {
      setSessionChatMode(ctx.sessionId, null);
      await ctx.reply('// mode override cleared — now inheriting the agent default');
    } else {
      await ctx.reply(`// unknown mode '${arg}' — usage: /mode chat · /mode agent · /mode auto`);
    }
  },
});
