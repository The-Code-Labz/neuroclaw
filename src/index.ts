import 'dotenv/config';
import * as readline from 'readline';
import { chat } from './agent/alfred';
import { createSession, getAlfredAgent, logAudit } from './db';
import { messageQueue } from './queue';
import { logger } from './utils/logger';
import { config } from './config';

// TODO [Discord bot]: Replace readline with Discord.js client — import { Client, GatewayIntentBits } from 'discord.js'
// TODO [HTTP API]: Expose chat() over Express/Fastify routes for external clients
// TODO [MCP bridge]: Mount an MCP server for IDE extension integration
// TODO [LiveKit]: Connect to a LiveKit voice room and route audio through Alfred

async function main(): Promise<void> {
  if (!config.voidai.apiKey) {
    logger.error('VOIDAI_API_KEY is not set. Copy .env.example → .env and add your key.');
    process.exit(1);
  }

  const alfred = getAlfredAgent();
  if (!alfred) {
    logger.error('Alfred agent not found in DB — schema seed may have failed.');
    process.exit(1);
  }

  const sessionId = createSession(alfred.id, `CLI Session ${new Date().toLocaleString()}`);
  logAudit('session_started', 'session', sessionId);
  logger.info(`Session started: ${sessionId}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n╔══════════════════════════╗');
  console.log('║  NeuroClaw — Alfred CLI  ║');
  console.log('╚══════════════════════════╝');
  console.log('Type your message. Ctrl+C to exit.\n');

  const prompt = (): void => {
    rl.question('You: ', (input) => {
      const message = input.trim();
      if (!message) { prompt(); return; }

      messageQueue.add(() => chat(message, sessionId))
        .then(() => prompt())
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/api.?key/i.test(msg)) {
            logger.error('Invalid API key — check VOIDAI_API_KEY in .env');
          } else if (msg.includes('500')) {
            // VoidAI returns HTTP 500 for invalid keys or IP bans
            logger.error('VoidAI returned HTTP 500. Verify your API key or check for IP bans.');
          } else {
            logger.error('Chat error', err);
          }
          prompt();
        });
    });
  };

  rl.on('close', () => {
    logAudit('session_ended', 'session', sessionId);
    logger.info('Session ended. Goodbye.');
    process.exit(0);
  });

  prompt();
}

main().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
