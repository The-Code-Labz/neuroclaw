// KIE adapter for the shared media-jobs primitive.
// Surface B — unified job API (api.kie.ai). Contract pulled live 2026-07-12.
//
//   CREATE: POST /api/v1/jobs/createTask  { model, input, callBackUrl? } → { code, data:{ taskId } }
//   POLL:   GET  /api/v1/jobs/recordInfo?taskId=…  → { data:{ state, resultJson(STRINGIFIED), failMsg, creditsConsumed } }
//
// KIE uses ONE endpoint for both status and result → resultUrl === statusUrl.
// resultJson is a STRINGIFIED JSON blob → double-parse for resultUrls[].

import type { MediaJobAdapter, MediaKind, PollState, RetryHint } from '../media-jobs';

const BASE = 'https://api.kie.ai/api/v1';

export const kieAdapter: MediaJobAdapter = {
  provider: 'kie',

  authHeader: (apiKey) => `Bearer ${apiKey}`,

  submit(model, input) {
    return { url: `${BASE}/jobs/createTask`, body: { model, input } };
  },

  parseSubmit(resp) {
    const taskId = resp?.data?.taskId ?? resp?.taskId;
    if (!taskId) return { statusUrl: '', resultUrl: '' };
    const url = `${BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
    return { statusUrl: url, resultUrl: url };
  },

  pollState(statusResp): PollState {
    const s = String(statusResp?.data?.state ?? '').toLowerCase();
    if (s === 'success') return 'success';
    if (s === 'fail' || s === 'failed' || s === 'error') return 'fail';
    return 'pending'; // waiting | queuing | generating | ''
  },

  extractUrls(resultResp, _kind: MediaKind): string[] {
    const raw = resultResp?.data?.resultJson;
    let parsed: any = raw;
    if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { parsed = undefined; } }
    const urls = parsed?.resultUrls ?? parsed?.result_urls ?? [];
    return Array.isArray(urls) ? urls.filter((u: unknown) => typeof u === 'string') : [];
  },

  retryHint(statusOrErr): RetryHint {
    // KIE rate limit: 20 create-requests / 10s → HTTP 429 (rejected, not queued).
    // Short rate-class curve; the primitive supplies the backoff timing.
    const code = statusOrErr?.status ?? statusOrErr?.code;
    if (code === 429) return { kind: 'rate' };
    return { kind: 'none' };
  },

  errorMsg(resp): string {
    return String(resp?.data?.failMsg || resp?.msg || resp?.message || resp?.data?.failCode || '').slice(0, 300);
  },
};
