// fal adapter for the shared media-jobs primitive.
// Unified media queue (queue.fal.run). Contract pulled + lifecycle proven live 2026-07-12.
//
//   SUBMIT: POST queue.fal.run/{model}  <raw input> → { request_id, status_url, response_url }
//   POLL:   GET  {status_url}  → { status: IN_QUEUE|IN_PROGRESS|COMPLETED, queue_position, error?, error_type? }
//   RESULT: GET  {response_url} (only once COMPLETED) → { images:[{url}] } | { video:{url} } | { audio:{url} }|{ audio_url }
//
// Differences vs KIE the shared core absorbs via this adapter:
//   • auth header is `Key`, not `Bearer`
//   • submit body is the RAW input object (not wrapped in {model,input})
//   • status and result are TWO different URLs (KIE reuses one)
//   • result JSON is a normal object (KIE's resultJson is double-stringified)

import type { MediaJobAdapter, MediaKind, PollState, RetryHint } from '../media-jobs';

const BASE = 'https://queue.fal.run';

export const falAdapter: MediaJobAdapter = {
  provider: 'fal',

  authHeader: (apiKey) => `Key ${apiKey}`,

  submit(model, input) {
    // Model lives in the path; body is the raw input object.
    return { url: `${BASE}/${model.replace(/^\/+/, '')}`, body: input };
  },

  parseSubmit(resp) {
    const statusUrl = resp?.status_url ?? '';
    const resultUrl = resp?.response_url ?? '';
    return { statusUrl, resultUrl };
  },

  pollState(statusResp): PollState {
    const s = String(statusResp?.status ?? '').toUpperCase();
    if (s === 'COMPLETED') {
      // A COMPLETED status that carries an error is a failure, not a success.
      return statusResp?.error || statusResp?.error_type ? 'fail' : 'success';
    }
    // IN_QUEUE | IN_PROGRESS → still working.
    return 'pending';
  },

  extractUrls(resultResp, kind: MediaKind): string[] {
    // ASAGI #3: fal returns different shapes per modality; discriminate on kind.
    if (kind === 'video') {
      const u = resultResp?.video?.url ?? resultResp?.video_url;
      return typeof u === 'string' ? [u] : [];
    }
    if (kind === 'audio') {
      // fal music/audio models vary: {audio:{url}} | {audio_url} | {audio_file:{url}} (cassetteai)
      const u = resultResp?.audio?.url ?? resultResp?.audio_url
        ?? resultResp?.audio_file?.url ?? resultResp?.audio_file
        ?? resultResp?.output?.url;
      return typeof u === 'string' ? [u] : [];
    }
    // image (default): images[].url
    const imgs = resultResp?.images ?? [];
    if (!Array.isArray(imgs)) return [];
    return imgs.map((i: any) => i?.url).filter((u: unknown) => typeof u === 'string');
  },

  retryHint(statusOrErr): RetryHint {
    // fal 429 is a CONCURRENCY cap (retry-later), not a per-second rate limit.
    // Prefer a longer curve; if queue_position is present, wait proportionally.
    const code = statusOrErr?.status_code ?? statusOrErr?.status;
    const pos  = typeof statusOrErr?.queue_position === 'number' ? statusOrErr.queue_position : undefined;
    if (code === 429 || (typeof code === 'string' && code === 'TOO_MANY_REQUESTS')) {
      return { kind: 'concurrency', retryAfterMs: pos !== undefined ? Math.min(2000 + pos * 1000, 15_000) : 5000 };
    }
    if (pos !== undefined && pos > 0) {
      // Not an error — a queued position. Nudge the poll interval up with depth.
      return { kind: 'none', retryAfterMs: Math.min(2000 + pos * 500, 10_000) };
    }
    return { kind: 'none' };
  },

  errorMsg(resp): string {
    return String(resp?.error || resp?.error_type || resp?.detail || resp?.message || '').slice(0, 300);
  },
};
