import 'dotenv/config';
import { chat } from './agent/alfred';
import { createSession, getAgentByName, logAudit } from './db';
import { sessionQueueManager } from './system/session-queue-manager';
import { logger, setCliMode } from './utils/logger';
import { config } from './config';
import { syncSkillExports } from './skills/exporters';
import { dispatchSlash } from './system/slash-registry';
import './workflows/slash'; // registers /workflow slash command
import { startLogAnalyzer } from './system/log-analyzer';
import { Tui, installGlobalHandlers } from './cli/tui';
import { initBrokerStorage, resolveAllSecretsFromBroker } from './broker/bootstrap';
import { initAntigravityModel } from './providers/antigravity';
import { startCleanupScheduler } from './system/cleanup';
import { checkStandardsFreshness } from './standards/freshness';
import { initStandardsHookRegistration } from './standards/hook-registration';

async function main(): Promise<void> {
  setCliMode(true);
  installGlobalHandlers(logger);

  // Resolve broker-managed secrets before any config reads so CLI sessions
  // pick up keys stored in Infisical (same as the dashboard server path).
  await initBrokerStorage()
    .then(() => resolveAllSecretsFromBroker())
    .then(() => import('./system/inngest-client').then(({ refreshInngestEnv }) => refreshInngestEnv()))
    .catch((err: unknown) => logger.warn('broker: startup key resolution failed', { err: (err as Error).message }));

  if (!config.voidai.apiKey) {
    logger.error('VOIDAI_API_KEY is not set. Copy .env.example \u2192 .env and add your key.');
    process.exit(1);
  }

  const alfred = getAgentByName('A.S.A.G.I') ?? getAgentByName('Alfred');
  if (!alfred) {
    logger.error('No default agent found in DB \u2014 schema seed may have failed.');
    process.exit(1);
  }

  const sessionId = createSession(alfred.id, undefined, 'cli');
  logAudit('session_started', 'session', sessionId);
  logger.info(`Session started: ${sessionId}`);
  syncSkillExports({ refresh: true })
    .catch((err: unknown) => logger.warn('skill export sync failed on CLI startup', { err: (err as Error).message }));
  initAntigravityModel();
  initStandardsHookRegistration();
  startLogAnalyzer();
  startCleanupScheduler();
  checkStandardsFreshness();

  // ── TUI init ─────────────────────────────────────────────────────────────
  const tui = new Tui(process.stdin, process.stdout);

  const DIM   = '\x1b[2m';
  const CYAN  = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const RESET = '\x1b[0m';
  const BOLD  = '\x1b[1m';

  tui.writeOutput('');
  tui.writeOutput(`  ${BOLD}${CYAN}nclaw${RESET}  ${DIM}\u00b7  general agent${RESET}`);
  tui.writeOutput('');
  tui.writeOutput(`  ${DIM}Agent:${RESET}  ${GREEN}${alfred.name}${RESET}`);
  tui.writeOutput(`  ${DIM}Type your message \u00b7 Ctrl+C to exit${RESET}`);
  tui.writeOutput('');

  tui.onSubmit(async (message) => {
    if (!message) return;

    // Echo user prompt
    tui.echoUserMessage(message);

    let slashHandled = false;
    try {
      slashHandled = await dispatchSlash(message, {
        sessionId,
        surface: 'cli',
        reply: (text) => tui.writeOutput(text),
      });
    } catch { /* ignore */ }
    if (slashHandled) return;

    tui.setStatus('thinking');
    tui.beginAssistantStream(alfred.name, GREEN);
    try {
      await sessionQueueManager.enqueue(sessionId, () => chat(message, sessionId, (chunk) => {
        tui.writeStreamChunk(chunk);
      }));
      tui.endAssistantStream();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      tui.endAssistantStream();
      if (/api.?key/i.test(msg)) {
        tui.writeOutput('  Invalid API key \u2014 check VOIDAI_API_KEY in .env', { color: '\x1b[31m' });
      } else if (msg.includes('500')) {
        tui.writeOutput('  VoidAI returned HTTP 500. Verify your API key or check for IP bans.', { color: '\x1b[31m' });
      } else {
        tui.writeOutput(`  Chat error: ${msg}`, { color: '\x1b[31m' });
      }
    } finally {
      tui.setStatus('idle');
    }
  });

  tui.onClose(() => {
    logAudit('session_ended', 'session', sessionId);
    tui.writeOutput('\n  Session ended. Goodbye.', { color: DIM });
  });

  tui.start('›');
}

main().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
