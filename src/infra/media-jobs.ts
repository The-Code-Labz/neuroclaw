// media-jobs.ts — provider-agnostic async media-generation primitive.
//
// KIE-media and fal share one lifecycle: submit a job → poll a status → receive
// result URL(s) that EXPIRE. This module owns that lifecycle once; each provider
// supplies a thin `MediaJobAdapter` for the parts that differ (auth header,
// submit body shape, id/status field names, result-URL location, retry class).
//
// 🔒 BYTES-ONLY INVARIANT (spec §3, ASAGI finding 4): the primitive ALWAYS
// downloads the result URL and returns raw bytes. It NEVER returns a provider
// URL. Reason: those URLs expire (KIE 24h, fal media-expiration), and any code
// path that persists a raw URL into a saved transcript renders fine same-turn
// then silently 404s ~24h later. Returning bytes makes that class of bug
// unrepresentable — a caller literally cannot forward a URL it never receives.

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaJobResultItem {
  base64: string;
  mime:   string; // e.g. 'image/png', 'video/mp4', 'audio/mpeg'
}

export interface MediaJobResult {
  items:    MediaJobResultItem[];
  provider: string;
  model:    string;
  raw?:     unknown; // provider result JSON, for telemetry (creditsConsumed etc.)
}

export type PollState = 'pending' | 'success' | 'fail';

export interface RetryHint {
  kind:         'rate' | 'concurrency' | 'none';
  retryAfterMs?: number;
}

// The ONLY per-provider surface. Everything else lives in the shared core.
export interface MediaJobAdapter {
  provider: string;
  // "Bearer <k>" (KIE) | "Key <k>" (fal)
  authHeader(apiKey: string): string;
  // KIE: createTask + {model,input,callBackUrl}; fal: queue.fal.run/{model} + raw input
  submit(model: string, input: Record<string, unknown>): { url: string; body: unknown };
  // ASAGI #1: statusUrl and resultUrl may differ (fal) or be identical (KIE).
  // KIE → resultUrl===statusUrl (recordInfo); fal → status_url + response_url.
  parseSubmit(resp: any): { statusUrl: string; resultUrl: string };
  // KIE data.state (waiting/queuing/generating/success/fail); fal status (IN_QUEUE/IN_PROGRESS/COMPLETED).
  pollState(statusResp: any): PollState;
  // ASAGI #3: kind lets fal discriminate images[]/video/audio/audio_url. KIE ignores it.
  extractUrls(resultResp: any, kind: MediaKind): string[];
  // ASAGI #2: KIE 429=rate (short curve); fal 429=concurrency (longer; may key off queue_position).
  retryHint(statusOrErr: any): RetryHint;
  errorMsg(resp: any): string;
}

export interface RunMediaJobOpts {
  apiKey:     string;
  kind?:      MediaKind;   // default 'image'
  timeoutMs?: number;      // hard cap; default 90_000 (images). video/music → job queue (Phase 3).
  baseBackoffMs?: number;  // default 2500
  maxBackoffMs?:  number;  // default 15_000
  signal?:    AbortSignal;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function mimeForKind(kind: MediaKind, contentType?: string | null, url?: string): string {
  if (contentType && /^(image|video|audio)\//.test(contentType)) return contentType.toLowerCase();
  // fall back on URL extension, then a sane default per kind
  const ext = (url?.split('?')[0].split('.').pop() ?? '').toLowerCase();
  const byExt: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  };
  if (byExt[ext]) return byExt[ext];
  return kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png';
}

async function fetchJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: any; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text().catch(() => '');
  let body: any = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { ok: res.ok, status: res.status, body, text };
}

// Download a (soon-to-expire) result URL and return base64 bytes + mime.
export async function downloadBytes(url: string, kind: MediaKind): Promise<MediaJobResultItem> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`result download failed (${res.status}) for ${url.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = mimeForKind(kind, res.headers.get('content-type'), url);
  return { base64: buf.toString('base64'), mime };
}

/**
 * Run one async media job end-to-end and return DOWNLOADED BYTES.
 * submit → poll (backoff, honoring retryHint + hard timeout) → on success
 * ALWAYS re-fetch resultUrl (ASAGI #1) → extract URLs → download each → bytes.
 */
export async function runMediaJob(
  adapter: MediaJobAdapter,
  model: string,
  input: Record<string, unknown>,
  opts: RunMediaJobOpts,
): Promise<MediaJobResult> {
  const kind      = opts.kind ?? 'image';
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const baseBk    = opts.baseBackoffMs ?? 2500;
  const maxBk     = opts.maxBackoffMs ?? 15_000;
  const deadline  = Date.now() + timeoutMs;
  const auth      = adapter.authHeader(opts.apiKey);
  const jsonHdr   = { 'Authorization': auth, 'Content-Type': 'application/json' };

  // ── Submit (with a small retry loop for submit-time rate/concurrency 429s) ──
  const sub = adapter.submit(model, input);
  let submitResp: any;
  for (let attempt = 0; ; attempt++) {
    const r = await fetchJson(sub.url, { method: 'POST', headers: jsonHdr, body: JSON.stringify(sub.body), signal: opts.signal });
    if (r.ok || (r.body && r.status === 200)) { submitResp = r.body ?? {}; break; }
    const hint = adapter.retryHint(r.body ?? { status: r.status });
    if ((r.status === 429 || hint.kind !== 'none') && Date.now() < deadline && attempt < 6) {
      await sleep(Math.min(hint.retryAfterMs ?? (baseBk * (attempt + 1)), maxBk));
      continue;
    }
    throw new Error(`[${adapter.provider}] submit failed (${r.status}): ${adapter.errorMsg(r.body) || r.text.slice(0, 300)}`);
  }

  const { statusUrl, resultUrl } = adapter.parseSubmit(submitResp);
  if (!statusUrl) throw new Error(`[${adapter.provider}] submit returned no status URL: ${JSON.stringify(submitResp).slice(0, 300)}`);

  // ── Poll ──
  let attempt = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`[${adapter.provider}] job timed out after ${timeoutMs}ms (model ${model})`);
    const r = await fetchJson(statusUrl, { method: 'GET', headers: { 'Authorization': auth }, signal: opts.signal });

    if (!r.ok && r.status !== 200) {
      const hint = adapter.retryHint(r.body ?? { status: r.status });
      if (r.status === 429 || hint.kind !== 'none') {
        await sleep(Math.min(hint.retryAfterMs ?? Math.min(baseBk * 2 ** attempt, maxBk), maxBk));
        attempt++;
        continue;
      }
      throw new Error(`[${adapter.provider}] poll failed (${r.status}): ${r.text.slice(0, 300)}`);
    }

    const state = adapter.pollState(r.body ?? {});
    if (state === 'fail') {
      throw new Error(`[${adapter.provider}] job failed (model ${model}): ${adapter.errorMsg(r.body) || 'unknown error'}`);
    }
    if (state === 'success') {
      // ASAGI #1: ALWAYS re-fetch resultUrl on terminal success — do not assume
      // the poll body carries the result. KIE: resultUrl===statusUrl (redundant,
      // harmless). fal: COMPLETED status has no result; needs this second GET.
      const rr = await fetchJson(resultUrl, { method: 'GET', headers: { 'Authorization': auth }, signal: opts.signal });
      if (!rr.ok && rr.status !== 200) throw new Error(`[${adapter.provider}] result fetch failed (${rr.status}): ${rr.text.slice(0, 300)}`);
      const urls = adapter.extractUrls(rr.body ?? {}, kind);
      if (!urls.length) throw new Error(`[${adapter.provider}] job succeeded but returned no result URLs: ${JSON.stringify(rr.body).slice(0, 300)}`);
      const items = await Promise.all(urls.map(u => downloadBytes(u, kind)));
      return { items, provider: adapter.provider, model, raw: rr.body };
    }

    // still pending — honor any queue-position hint, else exponential backoff
    const hint = adapter.retryHint(r.body ?? {});
    const wait = hint.retryAfterMs ?? Math.min(baseBk * 2 ** Math.min(attempt, 4), maxBk);
    await sleep(wait);
    attempt++;
  }
}
