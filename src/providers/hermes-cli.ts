// Hermes proxy utilities.
//
// NeuroClaw integrates with Hermes via its local OpenAI-compatible proxy:
//   hermes proxy start --provider xai   (default port 8645)
//
// Agents with provider='hermes' route through getHermesProxyClient() in
// src/agent/hermes-proxy-client.ts — no subprocess spawning needed.
// This file provides a probe helper for health-check / status endpoints.

import { config } from '../config';

export interface HermesProxyStatus {
  ok:       boolean;
  url:      string;
  model:    string;
  error?:   string;
}

export async function probeHermesProxy(): Promise<HermesProxyStatus> {
  const url = config.hermes.proxyUrl;
  try {
    const res = await fetch(`${url.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return { ok: true, url, model: config.hermes.model };
    // Many proxies return 404 on /health but still work — try models list
    const modelsRes = await fetch(`${url}/models`, { signal: AbortSignal.timeout(3000) });
    return { ok: modelsRes.ok, url, model: config.hermes.model };
  } catch (err) {
    return {
      ok:    false,
      url,
      model: config.hermes.model,
      error: `proxy unreachable at ${url} — run: hermes proxy start --provider xai`,
    };
  }
}
