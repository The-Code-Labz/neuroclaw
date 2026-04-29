import { Langfuse } from 'langfuse';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  const cfg = config.langfuse;
  if (!cfg.enabled) return null;

  if (!client) {
    try {
      client = new Langfuse({
        secretKey:     cfg.secretKey,
        publicKey:     cfg.publicKey,
        baseUrl:       cfg.host,
        flushAt:       10,
        flushInterval: 5000,
        release:       'neuroclaw-v1',
      });
      logger.info('Langfuse connected', { host: cfg.host });
    } catch (err) {
      logger.warn('Langfuse init failed', { err });
      return null;
    }
  }
  return client;
}

export function resetLangfuse(): void {
  if (client) {
    client.flushAsync().catch(() => {});
    client = null;
  }
}
