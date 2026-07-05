#!/usr/bin/env node
// Load .env from the package root so nclaw works when invoked from any directory.
import path from 'path';
import { config as dotenvLoad } from 'dotenv';
dotenvLoad({ path: path.join(__dirname, '..', '.env') });

// Must be set before config.exec.* is read — config uses live process.env getters.
const CWD = process.cwd();
process.env.EXEC_ROOT       = CWD;
process.env.EXEC_DEFAULT_CWD = CWD;

import { chatStream } from './agent/alfred';
import {
  createSession, getAgentByName, getAllAgents, logAudit,
  updateAgentRecord, startRun, endRun,
} from './db';
import { logger, setCliMode } from './utils/logger';
import { config } from './config';
import { dispatchSlash } from './system/slash-registry';
import { scanTree } from './system/tree-scanner';
import { installConfirmGate } from './system/confirm-gate';
import {
  chatRemote, listAgentsRemote, checkRemoteConnection,
} from './cli-code-remote';
import { Tui, installGlobalHandlers } from './cli/tui';

async function main(): Promise<void> {
  setCliMode(true);
  installGlobalHandlers(logger);

  // Subcommand dispatch — `nclaw doctor [...]` runs the diagnostic suite and
  // exits without spinning up the chat TUI. Keep this above any TUI / agent
  // initialisation so the doctor can run on systems where Alfred is missing
  // or VOIDAI_API_KEY isn't set.
  if (process.argv[2] === 'doctor') {
    const { cli: doctorCli } = await import('./doctor');
    const code = await doctorCli(process.argv.slice(3));
    process.exit(code);
  }

  const remoteUrl   = process.env.NEUROCLAW_URL?.trim();
  const remoteToken = process.env.NEUROCLAW_TOKEN?.trim();
  const isRemote    = Boolean(remoteUrl && remoteToken);
  let remoteSessionId: string | undefined;

  const DIM       = '\x1b[2m';
  const BOLD      = '\x1b[1m';
  const CYAN      = '\x1b[36m';
  const GREEN     = '\x1b[32m';
  const RESET_CLR = '\x1b[0m';

  const printBanner = (agentName: string, remote?: string): void => {
    tui.writeOutput('');
    tui.writeOutput(`  ${BOLD}${CYAN}nclaw${RESET_CLR}  ${DIM}\u00b7  code agent${RESET_CLR}`);
    tui.writeOutput('');
    tui.writeOutput(`  ${DIM}Working in:${RESET_CLR}  ${CWD}`);
    if (remote) tui.writeOutput(`  ${DIM}Remote:${RESET_CLR}      ${remote}`);
    tui.writeOutput(`  ${DIM}Agent:${RESET_CLR}       ${GREEN}${agentName}${RESET_CLR}`);
    tui.writeOutput('');
    tui.writeOutput(`  ${DIM}Type a task \u00b7 /agent to switch \u00b7 Ctrl+C to exit${RESET_CLR}`);
    tui.writeOutput('');
  };

  if (!isRemote && !config.voidai.apiKey) {
    logger.error('VOIDAI_API_KEY is not set. Copy .env.example \u2192 .env and add your key.');
    process.exit(1);
  }

  const alfred = isRemote ? null : getAgentByName('Alfred');
  if (!isRemote && !alfred) {
    logger.error('Alfred agent not found \u2014 schema seed may have failed.');
    process.exit(1);
  }
  if (!isRemote && alfred && !alfred.exec_enabled) {
    updateAgentRecord(alfred.id, { exec_enabled: true });
  }

  type AnyAgent = { id: string; name: string; role: string; system_prompt?: string | null };
  let currentAgent: AnyAgent = alfred ?? { id: '', name: 'Alfred', role: 'orchestrator' };

  const tree = scanTree(CWD);
  const extraSystemContext = [
    '\u0060\u0060\u0060',
    tree,
    '\u0060\u0060\u0060',
    '',
    'You are operating as a coding agent. The user is working in the directory shown above.',
    'Use fs_read, fs_write, fs_list, fs_search, and bash_run to complete their coding tasks.',
    'All file operations are sandboxed to this directory.',
    'When writing files, prefer targeted edits over full rewrites.',
  ].join('\n');

  const sessionId = isRemote ? '' : createSession(alfred!.id, `Code CLI \u2014 ${CWD}`, 'cli');
  if (!isRemote) logAudit('session_started', 'session', sessionId);

  // ── TUI init ───────────────────────────────────────────────────────────────
  const tui = new Tui(process.stdin, process.stdout);

  if (isRemote) {
    tui.writeOutput('  Connecting to server...', { color: DIM });
    try {
      await checkRemoteConnection(remoteUrl!, remoteToken!);
      tui.writeOutput(' ok');
    } catch (e) {
      tui.writeOutput('', { color: RESET_CLR });
      tui.writeOutput(`  ${(e as Error).message}`, { color: '\x1b[31m' });
      process.exit(1);
    }
  }

  // Install confirm gate using TUI's IO abstraction so prompts don't fight the chat UI.
  const gateIO = tui.createGateIO();
  if (!isRemote) installConfirmGate(gateIO);

  printBanner(currentAgent.name, isRemote ? remoteUrl : undefined);

  // ── Conversation loop ────────────────────────────────────────────────────
  tui.onSubmit(async (message) => {
    if (!message) return;

    // Echo what the user typed so the transcript reads like a conversation.
    tui.echoUserMessage(message);

    // ── /agent switch ──────────────────────────────────────────────────────
    if (message === '/agent') {
      tui.setStatus('thinking', 'listing agents...');
      if (isRemote) {
        try {
          const remoteAgents = await listAgentsRemote(remoteUrl!, remoteToken!);
          const active = remoteAgents.filter(a => a.status === 'active');
          if (active.length === 0) {
            tui.writeOutput('  No active agents found.');
            return;
          }
          tui.writeOutput('');
          active.forEach((a, i) => {
            const marker = a.id === currentAgent.id ? `${GREEN}\u25b6${RESET_CLR}` : ' ';
            tui.writeOutput(`  ${marker} ${i + 1}. ${a.name}  ${DIM}(${a.role})${RESET_CLR}`);
          });
          tui.writeOutput('');
          const ans = await gateIO.askInput(`  Select [1-${active.length}]: `);
          const idx = parseInt(ans.trim(), 10) - 1;
          if (idx >= 0 && idx < active.length) {
            currentAgent = active[idx];
            tui.writeOutput(`\n  Switched to: ${GREEN}${currentAgent.name}${RESET_CLR}\n`);
          } else {
            tui.writeOutput('  Cancelled.\n');
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === 'INVALID_TOKEN') {
            tui.writeOutput('  Invalid NEUROCLAW_TOKEN.', { color: '\x1b[31m' });
          } else {
            tui.writeOutput(`  Failed to fetch agents: ${msg}`, { color: '\x1b[31m' });
          }
        }
      } else {
        const agents = getAllAgents().filter(a => a.status === 'active' && !a.temporary);
        if (agents.length === 0) {
          tui.writeOutput('  No active agents found.');
          return;
        }
        tui.writeOutput('');
        agents.forEach((a, i) => {
          const marker = a.id === currentAgent.id ? `${GREEN}\u25b6${RESET_CLR}` : ' ';
          tui.writeOutput(`  ${marker} ${i + 1}. ${a.name}  ${DIM}(${a.role})${RESET_CLR}`);
        });
        tui.writeOutput('');
        const ans = await gateIO.askInput(`  Select [1-${agents.length}]: `);
        const idx = parseInt(ans.trim(), 10) - 1;
        if (idx >= 0 && idx < agents.length) {
          currentAgent = agents[idx];
          tui.writeOutput(`\n  Switched to: ${GREEN}${currentAgent.name}${RESET_CLR}\n`);
        } else {
          tui.writeOutput('  Cancelled.\n');
        }
      }
      tui.setStatus('idle');
      return;
    }

    // ── Slash commands ───────────────────────────────────────────────────
    let slashHandled = false;
    try {
      slashHandled = await dispatchSlash(message, {
        sessionId,
        surface: 'cli',
        reply: (text) => tui.writeOutput(text),
      });
    } catch { /* ignore */ }
    if (slashHandled) return;

    // ── Chat ─────────────────────────────────────────────────────────────
    if (isRemote) {
      tui.setStatus('thinking');
      tui.beginAssistantStream(currentAgent.name, GREEN);
      let finalText = '';

      try {
        await chatRemote({
          url:       remoteUrl!,
          token:     remoteToken!,
          message,
          sessionId: remoteSessionId,
          agentId:   currentAgent.id || undefined,
          context:   extraSystemContext,
          onChunk:   (chunk) => { finalText += chunk; tui.writeStreamChunk(chunk); },
          onSession: (sid)   => { remoteSessionId = sid; },
        });
        tui.endAssistantStream();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        tui.endAssistantStream();
        if (msg === 'INVALID_TOKEN') {
          tui.writeOutput('  Invalid NEUROCLAW_TOKEN.', { color: '\x1b[31m' });
        } else {
          tui.writeOutput(`  Error: ${msg}`, { color: '\x1b[31m' });
        }
      } finally {
        tui.setStatus('idle');
      }
    } else {
      const runId = startRun({
        origin:            'code_cli',
        sessionId,
        initiatingAgentId: currentAgent.id,
        userMessage:       message,
      });

      tui.setStatus('thinking');
      tui.beginAssistantStream(currentAgent.name, GREEN);
      let finalText = '';

      try {
        await chatStream(
          message,
          sessionId,
          (chunk) => { finalText += chunk; tui.writeStreamChunk(chunk); },
          currentAgent.system_prompt ?? '',
          currentAgent.id,
          undefined,
          undefined,
          extraSystemContext,
          runId,
        );
        endRun(runId, { status: 'done', final_output: finalText });
        tui.endAssistantStream();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        endRun(runId, { status: 'error', error_text: msg });
        tui.endAssistantStream();
        if (/api.?key/i.test(msg)) {
          tui.writeOutput('  Invalid API key \u2014 check VOIDAI_API_KEY in .env', { color: '\x1b[31m' });
        } else if (msg.includes('500')) {
          tui.writeOutput('  VoidAI returned HTTP 500 \u2014 check API key or IP bans.', { color: '\x1b[31m' });
        } else {
          tui.writeOutput(`  Error: ${msg}`, { color: '\x1b[31m' });
        }
      } finally {
        tui.setStatus('idle');
      }
    }
  });

  tui.onClose(() => {
    if (!isRemote) logAudit('session_ended', 'session', sessionId);
    tui.writeOutput('\n  Goodbye.', { color: DIM });
  });

  tui.start('›');
}

main().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
