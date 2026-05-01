import { spawn } from 'child_process';
import { config } from '../config';
import { getAnthropicAuthStatus } from '../agent/anthropic-client';
import { probeClaudeCli } from '../providers/claude-cli';

function fmt(label: string, value: string, color?: 'green' | 'yellow' | 'red'): void {
  const colors = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };
  const c = color ? colors[color] : '';
  const r = color ? colors.reset : '';
  console.log(`  ${label.padEnd(28)} ${c}${value}${r}`);
}

function which(cmd: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn('which', [cmd]);
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('close', code => resolve(code === 0 ? out.trim() : null));
    child.on('error', () => resolve(null));
  });
}

function redactKey(k: string): string {
  if (!k) return '(unset)';
  if (k.length < 12) return '(set, short)';
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}

async function main(): Promise<void> {
  console.log('\n── Claude backend diagnostics ──────────────────────────────────\n');

  const backend    = config.claude.backend;
  const cliCommand = config.claude.cliCommand;

  fmt('CLAUDE_BACKEND', backend);
  fmt('CLAUDE_CLI_COMMAND', cliCommand);
  fmt('CLAUDE_MAX_TURNS', String(config.claude.maxTurns));
  fmt('CLAUDE_TIMEOUT_MS', String(config.claude.timeoutMs));
  fmt('CLAUDE_CONCURRENCY_LIMIT', String(config.claude.concurrencyLimit));

  const cliPath = await which(cliCommand);
  fmt(`which ${cliCommand}`, cliPath ?? '(not found)', cliPath ? 'green' : 'red');

  const probe = await probeClaudeCli();
  fmt('claude --version', probe.version ?? `(failed: ${probe.error})`, probe.ok ? 'green' : 'red');

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  fmt('ANTHROPIC_API_KEY', redactKey(apiKey), apiKey ? 'yellow' : 'green');

  const auth = getAnthropicAuthStatus();
  fmt('Anthropic auth resolved', auth.source + (auth.subscriptionType ? ` (${auth.subscriptionType})` : ''));
  if (auth.expired) fmt('OAuth token', 'EXPIRED — run `claude` to refresh', 'red');

  console.log('');

  // Warnings
  const warnings: string[] = [];
  if (backend === 'claude-cli' && apiKey) {
    warnings.push(
      'CLAUDE_BACKEND=claude-cli but ANTHROPIC_API_KEY is set. The CLI will still ' +
      'use subscription auth (the key is stripped from child env), but if you want ' +
      'API-key billing, switch to CLAUDE_BACKEND=anthropic-api.'
    );
  }
  if (backend === 'anthropic-api' && !apiKey) {
    warnings.push('CLAUDE_BACKEND=anthropic-api but ANTHROPIC_API_KEY is unset — Claude calls will fail.');
  }
  if (backend === 'claude-cli' && !probe.ok) {
    warnings.push(`CLAUDE_BACKEND=claude-cli but \`${cliCommand}\` is not runnable: ${probe.error ?? 'unknown error'}.`);
  }
  if (config.claude.concurrencyLimit > 2) {
    warnings.push(
      `CLAUDE_CONCURRENCY_LIMIT=${config.claude.concurrencyLimit}. Subscription auth has ` +
      'tight rate limits; values >2 are likely to trigger 429s under load.'
    );
  }
  if (config.spawning.enabled && backend === 'claude-cli') {
    warnings.push(
      'SPAWN_AGENTS_ENABLED=true with claude-cli backend: each spawned Claude agent ' +
      'consumes subscription quota. Watch CLAUDE_CONCURRENCY_LIMIT.'
    );
  }

  if (warnings.length === 0) {
    console.log('  \x1b[32mNo warnings.\x1b[0m\n');
  } else {
    console.log('  \x1b[33mWarnings:\x1b[0m');
    for (const w of warnings) console.log(`   • ${w}`);
    console.log('');
  }

  // Exit non-zero if the active backend is unusable
  const fatal =
    (backend === 'claude-cli' && !probe.ok) ||
    (backend === 'anthropic-api' && !apiKey);
  process.exit(fatal ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
