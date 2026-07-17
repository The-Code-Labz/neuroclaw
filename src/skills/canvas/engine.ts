// Canvas — engine.
//
// Implements the 4-function public API from §5 of the ASAGI brief.
// In v1 we use the VoidAI / OpenAI-compatible client already wired into
// NeuroClaw. Real-time SSE is exposed by `generate` and `iterate` as async
// iterables.

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { getClient } from '../../agent/openai-client';
import { getOpenRouterClient } from '../../agent/openrouter-client';
import { getVeniceClient } from '../../agent/venice-client';
import { getOllamaClient } from '../../agent/ollama-client';
import { getHermesProxyClient } from '../../agent/hermes-proxy-client';
import { getKimiApiClient } from '../../agent/kimi-api-client';
import { getLiteLlmClient } from '../../agent/litellm-client';
import { getAbacusClient } from '../../agent/abacus-client';
import { getSubAgentKimiClient, getSubAgentMinimaxClient } from '../../agent/subagent-clients';
import { streamAntigravityChat } from '../../providers/antigravity';
import { DIRECTIONS } from './directions';
import {
  createProject, getProject, attachArtifact, setDirection, setArtifactCritique,
  findProjectByArtifact, getArtifact, updateProject, CANVAS_ROOT,
} from './store';
import type {
  CanvasEvent, DesignBrief, Direction, Artifact, CritiqueResult,
  DiscoveryForm, TodoItem,
} from './types';

/**
 * Resolve the model for canvas generation, evaluated per-call so dashboard
 * edits to the Asia agent take effect without a restart:
 *   CANVAS_MODEL env  >  the registered "Asia" agent's model  >  VOIDAI_MODEL.
 * Canvas is "Asia's design studio" but runs as a standalone engine (not an
 * agent), so it does not inherit Asia's model automatically — this bridges it.
 */
function canvasModel(): string {
  if (process.env.CANVAS_MODEL) return process.env.CANVAS_MODEL;
  try {
    // Lazy require — db.ts participates in import cycles (see logger.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAgentByName } = require('../../db') as typeof import('../../db');
    const asia = getAgentByName('Asia');
    if (asia?.model) return asia.model;
  } catch { /* DB not ready / unavailable — fall through to default */ }
  return config.voidai.model || 'gpt-4o-mini';
}

function canvasProvider(): string {
  if (process.env.CANVAS_PROVIDER) return process.env.CANVAS_PROVIDER;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAgentByName } = require('../../db') as typeof import('../../db');
    const asia = getAgentByName('Asia');
    if (asia?.provider) return asia.provider;
  } catch { /* fall through */ }
  return 'voidai';
}

/**
 * Provider-aware STREAMING text completion. Mirrors the resolveProviderClient()
 * logic in alfred.ts so canvas always routes to the same backend as Asia's
 * agent. Yields token deltas as they arrive — the generate()/iterate() loops
 * re-emit these as `chunk` events so the UI shows live progress instead of a
 * multi-minute silent gap.
 */
async function* streamModelText(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  opts: { temperature?: number; max_tokens?: number } = {},
): AsyncIterable<string> {
  const model    = canvasModel();
  const provider = canvasProvider();

  if (provider === 'antigravity' || model.startsWith('antigravity/')) {
    const systemMsg = messages.find(m => m.role === 'system')?.content;
    const userParts = messages.filter(m => m.role === 'user').map(m => m.content);
    for await (const chunk of streamAntigravityChat({
      prompt:       userParts.join('\n\n'),
      systemPrompt: systemMsg,
      model,
    })) {
      yield chunk;
    }
    return;
  }

  const clientMap: Record<string, () => import('openai').OpenAI> = {
    openrouter: getOpenRouterClient,
    venice:     getVeniceClient,
    ollama:     getOllamaClient,
    hermes:     getHermesProxyClient,
    'kimi-api': getKimiApiClient,
    litellm:    getLiteLlmClient,
    abacus:     getAbacusClient,
    // Native MiniMax/Kimi gateways: Asia/Lucius use provider='minimax'. Their
    // OpenAI-compatible endpoints serve MiniMax-M3 etc.; without these the call
    // fell through to the default VoidAI client → "400 Model 'MiniMax-M3' does
    // not exist". (Kimi added for symmetry — provider='kimi' agents on canvas.)
    minimax:    getSubAgentMinimaxClient,
    kimi:       getSubAgentKimiClient,
  };
  const client = (clientMap[provider] ?? getClient)();
  const stream = await client.chat.completions.create({
    model,
    temperature: opts.temperature ?? 0.65,
    max_tokens:  opts.max_tokens  ?? 16000,
    messages,
    stream: true,
  });
  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta?.content || '';
    if (delta) yield delta;
  }
}

/**
 * Non-streaming convenience wrapper — accumulates the streamed deltas into a
 * single string. Used by the critique path, which does not surface tokens to
 * the UI.
 */
async function callModelText(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  opts: { temperature?: number; max_tokens?: number } = {},
): Promise<string> {
  let out = '';
  for await (const delta of streamModelText(messages, opts)) out += delta;
  return out;
}

const DISCOVERY_FORM: DiscoveryForm = {
  surfaces: [
    { id: 'deck',        label: 'Pitch deck',        hint: 'Slide deck (PPTX / PDF)' },
    { id: 'web',         label: 'Web page',          hint: 'Landing page or hero section (HTML)' },
    { id: 'mobile',      label: 'Mobile screen',     hint: 'iOS / Android UI mock (HTML)' },
    { id: 'poster',      label: 'Poster',            hint: 'Single-frame visual (HTML / PDF)' },
    { id: 'motion',      label: 'Motion piece',      hint: 'Animated HTML (MP4 export later)' },
    { id: 'infographic', label: 'Infographic',       hint: 'Data-driven explainer (HTML)' },
  ],
  audiences: ['Investors', 'Engineers', 'Designers', 'Executives', 'End users', 'General public'],
  tones:     ['Cinematic', 'Minimal', 'Playful', 'Authoritative', 'Editorial', 'Experimental'],
  scales: [
    { id: 'single',      label: 'Single artifact' },
    { id: 'multi-page',  label: 'Multi-page set' },
    { id: 'prototype',   label: 'Interactive prototype' },
  ],
};

function systemPromptFor(brief: DesignBrief, direction: Direction): string {
  const brand = brief.brandKit
    ? `\nBrand kit:\n- Name: ${brief.brandKit.name || 'Untitled'}\n- Colors: ${(brief.brandKit.colors || []).join(', ') || 'designer\'s choice'}\n- Voice: ${brief.brandKit.voice || 'designer\'s choice'}`
    : '';

  return [
    'You are Asia, NeuroClaw\'s in-house design lead. You write production-quality, accessible HTML+CSS in a single self-contained document.',
    '',
    'Constraints (non-negotiable):',
    '- Output ONE complete HTML document. <!doctype html> through </html>. No surrounding markdown, no commentary, no code fences.',
    '- Inline ALL CSS in a <style> block. No external requests except Google Fonts (which is allowed).',
    '- The artifact MUST render inside a sandboxed iframe with `sandbox="allow-scripts"` and NO `allow-same-origin`. Therefore: no fetch(), no localStorage, no parent-window calls, no service workers.',
    '- Mobile-friendly. Semantic HTML. Sufficient contrast (WCAG AA).',
    '- Polished. Editorial-quality typography. Real spacing rhythm.',
    '',
    `Visual direction: ${direction.name}`,
    `Philosophy: ${direction.philosophy}`,
    `Palette hint: ${direction.paletteHint}`,
    `Typography hint: ${direction.typeHint}`,
    `Exemplars to study: ${direction.exemplars.join(', ')}`,
    '',
    `Brief: ${brief.brief}`,
    brief.surface  ? `Surface: ${brief.surface}` : '',
    brief.audience ? `Audience: ${brief.audience}` : '',
    brief.tone     ? `Tone: ${brief.tone}` : '',
    brief.scale    ? `Scale: ${brief.scale}` : '',
    brand,
  ].filter(Boolean).join('\n');
}

/**
 * Game Studio system prompt — produces ONE self-contained, playable HTML5
 * browser game. Tuned for the sandboxed `allow-scripts` (no same-origin) view:
 * inline JS is allowed, but localStorage/fetch throw — so state stays in-memory.
 */
function gameSystemPromptFor(brief: DesignBrief): string {
  return [
    'You are a senior JavaScript game developer. You build complete, polished, PLAYABLE browser games as a single self-contained HTML document.',
    '',
    'Constraints (non-negotiable):',
    '- Output ONE complete HTML document. <!doctype html> through </html>. No surrounding markdown, no commentary, no code fences.',
    '- The ENTIRE game — HTML, CSS, and JavaScript — lives in this one file. Inline CSS in a <style> block and JS in an inline <script> block. No external files, no imports, no CDNs, no external assets.',
    '- Render with an HTML5 <canvas> and a requestAnimationFrame game loop. Draw all art programmatically (shapes, gradients, text) — do NOT load external images, audio files, or fonts.',
    '- The game runs inside a sandboxed iframe with `sandbox="allow-scripts"` and NO same-origin. Therefore: NO fetch(), NO localStorage/sessionStorage, NO cookies, NO parent-window calls. Keep ALL state (including high score) in plain JS variables — session-only is fine.',
    '- Fully self-starting and self-contained: on load, show a title/start screen, then play. Include a visible score/HUD and a game-over + restart flow.',
    '- Controls: support keyboard (Arrow keys / WASD / Space) AND pointer/touch where it makes sense, so it works on desktop and mobile. Prevent default scrolling on gameplay keys.',
    '- Make it genuinely fun and responsive: smooth 60fps loop, clear feedback, escalating difficulty. Size the canvas responsively to the viewport.',
    '- Polished visuals: cohesive color palette, particles/juice where appropriate, readable typography drawn on canvas.',
    '',
    `Game to build: ${brief.brief}`,
    'Build the complete, playable game now. Return only the HTML document.',
  ].filter(Boolean).join('\n');
}

function buildTodos(brief: DesignBrief): TodoItem[] {
  return [
    { id: 't1', text: 'Lock brief & direction',           status: 'completed'   },
    { id: 't2', text: 'Sketch layout (grid, hierarchy)',  status: 'in_progress' },
    { id: 't3', text: 'Generate typography & color',      status: 'pending'     },
    { id: 't4', text: 'Render single HTML artifact',      status: 'pending'     },
    { id: 't5', text: 'Self-critique (5 dimensions)',     status: 'pending'     },
    { id: 't6', text: 'Ready for export & iteration',     status: 'pending'     },
  ];
}

function pickDefaultDirection(brief: DesignBrief): Direction {
  if (brief.direction) {
    const hit = DIRECTIONS.find(d => d.id === brief.direction);
    if (hit) return hit;
  }
  // Heuristic: cyber tones → neuroclaw house brand.
  const text = (brief.brief + ' ' + (brief.tone || '')).toLowerCase();
  if (/cyber|neon|dark|terminal|hud|techn|ai-?os/.test(text)) {
    return DIRECTIONS.find(d => d.id === 'neuroclaw') || DIRECTIONS[0];
  }
  return DIRECTIONS[0];
}

/**
 * Guard against "stub" artifacts — a real design artifact is thousands of
 * chars; reasoning models (e.g. MiniMax-M3) sometimes burn their token budget
 * on hidden reasoning and emit only a scaffold with a literal "..." placeholder
 * in <body>, which renders as a blank white page. Detect that so the caller can
 * fail loudly instead of silently persisting an empty artifact.
 */
function looksLikeStub(html: string): boolean {
  const s = html || '';
  if (s.replace(/\s+/g, '').length < 800) return true;
  const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : s;
  // Strip tags, whitespace, and ellipsis placeholders — what's left is real content.
  const visible = body.replace(/<[^>]+>/g, '').replace(/[\s.…]+/g, '');
  return visible.length < 24;
}

/** Pull a single HTML document out of a model response, stripping fences if any. */
function extractHtml(raw: string): string {
  let s = (raw || '').trim();
  // Strip ```html ... ``` fences.
  const fence = s.match(/```(?:html)?\s*([\s\S]+?)```/i);
  if (fence) s = fence[1].trim();
  // If model added preamble before <!doctype, slice from the doctype.
  const dt = s.search(/<!doctype\s+html/i);
  if (dt > 0) s = s.slice(dt);
  if (!/<!doctype\s+html/i.test(s) && !/<html[\s>]/i.test(s)) {
    // Wrap fragment in a minimal doc so the iframe still renders something.
    s = `<!doctype html><html><head><meta charset="utf-8"><title>Artifact</title></head><body>${s}</body></html>`;
  }
  return s;
}

async function callModelForCritique(html: string, brief: DesignBrief, persona: 'asia' | 'lucius' | 'joker' = 'asia'): Promise<CritiqueResult> {
  const personaPrompt = {
    asia:   'You are Asia, design lead. Critique for taste, hierarchy, and emotional resonance.',
    lucius: 'You are Lucius, the architecture critic. Critique for structural soundness, accessibility, and code craft.',
    joker:  'You are Joker, the copy critic. Critique for narrative voice, headline punch, and content clarity.',
  }[persona];

  const sys = [
    personaPrompt,
    '',
    'You will be given an HTML artifact. Score it on 5 dimensions, each 0–10:',
    '- clarity:   message is immediately readable',
    '- hierarchy: visual order guides the eye correctly',
    '- craft:     typographic + spacing precision',
    '- brandFit:  matches the brief\'s intended tone',
    '- emotion:   evokes the intended feeling',
    '',
    'Return STRICT JSON, no commentary, matching:',
    '{ "scores": { "clarity": <n>, "hierarchy": <n>, "craft": <n>, "brandFit": <n>, "emotion": <n> }, "notes": ["short bullet", ...] }',
    'Notes must be 3–6 short, actionable bullets.',
  ].join('\n');

  const text = await callModelText(
    [
      { role: 'system', content: sys },
      { role: 'user',   content: `Brief: ${brief.brief}\n\nArtifact (HTML, truncated):\n${html.slice(0, 12_000)}` },
    ],
    { temperature: 0.2, max_tokens: 1200 },
  ) || '{}';
  try {
    const json = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    const s = json.scores || {};
    return {
      scores: {
        clarity:   clamp10(s.clarity),
        hierarchy: clamp10(s.hierarchy),
        craft:     clamp10(s.craft),
        brandFit:  clamp10(s.brandFit),
        emotion:   clamp10(s.emotion),
      },
      notes: Array.isArray(json.notes) ? json.notes.slice(0, 8) : [],
    };
  } catch (err) {
    logger.warn('canvas/critique: JSON parse failed', { err: (err as Error).message });
    return {
      scores: { clarity: 5, hierarchy: 5, craft: 5, brandFit: 5, emotion: 5 },
      notes:  ['Critique parser failed — defaulted to 5/10 across the board.', text.slice(0, 200)],
    };
  }
}

function clamp10(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 5;
  return Math.max(0, Math.min(10, Math.round(v * 10) / 10));
}

/** Collapse whitespace and cap free text for a single tidy log line. */
function truncForLog(s: string, n = 120): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function mergeCritiques(...rs: CritiqueResult[]): CritiqueResult {
  const avg = (k: keyof CritiqueResult['scores']) =>
    Math.round((rs.reduce((s, r) => s + r.scores[k], 0) / rs.length) * 10) / 10;
  const notes = Array.from(new Set(rs.flatMap(r => r.notes)));
  return {
    scores: {
      clarity:   avg('clarity'),
      hierarchy: avg('hierarchy'),
      craft:     avg('craft'),
      brandFit:  avg('brandFit'),
      emotion:   avg('emotion'),
    },
    notes,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// PUBLIC API — §5 of the ASAGI brief
// ──────────────────────────────────────────────────────────────────────────

export interface GenerateOpts {
  projectId?: string;
  agent?:     'asia' | 'friday' | 'jarvis';
  /** Skip the interactive discovery prompt and go straight to generation. */
  autoDirection?: boolean;
}

export async function* generate(
  brief: DesignBrief,
  opts: GenerateOpts = {},
): AsyncIterable<CanvasEvent> {
  let project = opts.projectId ? getProject(opts.projectId) : undefined;
  if (!project) project = createProject(brief);
  // Reusing an existing project (e.g. a direction-override re-run): refresh the
  // stored brief so history labels and standalone critique() don't go stale.
  else updateProject(project.id, { brief });

  yield { type: 'project.start', payload: { projectId: project.id, briefId: project.briefId } };
  logger.info(`canvas/generate: start — surface=${brief.surface || '?'} audience=${brief.audience || '?'}`, { projectId: project.id });

  // Phase 1: discovery (UI surface picks one; the engine also accepts whatever
  // partial brief came in and skips ahead if direction is already chosen).
  if (!brief.surface || !brief.audience || !brief.tone) {
    yield { type: 'discovery.form.show', payload: DISCOVERY_FORM };
  }

  // Phase 2: direction picker
  yield { type: 'direction.form.show', payload: DIRECTIONS };

  // Phase 3: pick a default direction if caller didn't lock one — UI can call
  // /api/canvas/generate again with `direction` set to override.
  const direction = pickDefaultDirection(brief);
  setDirection(project.id, direction);
  logger.info(`canvas/generate: direction=${direction.id}`, { projectId: project.id });

  const todos = buildTodos(brief);
  yield { type: 'todo.update', payload: todos };

  yield {
    type:    'tool.call',
    payload: { name: 'llm.complete', args: { direction: direction.id, model: canvasModel() } },
  };

  // Phase 4: actually generate — stream tokens so the UI shows live progress
  // instead of a multi-minute silent gap. Each delta is re-emitted as a `chunk`
  // event; the client renders a live char + elapsed meter from these.
  let html = '';
  const t0 = Date.now();
  logger.info(`canvas/generate: llm.complete start — model=${canvasModel()}`);
  const isGame = brief.kind === 'game';
  try {
    const sys = isGame ? gameSystemPromptFor(brief) : systemPromptFor(brief, direction);
    let raw = '';
    for await (const delta of streamModelText(
      [
        { role: 'system', content: sys },
        { role: 'user',   content: isGame ? 'Build the game now. Return only the HTML document.' : 'Design now. Return only the HTML document.' },
      ],
      { temperature: isGame ? 0.7 : 0.65, max_tokens: isGame ? 32000 : 16000 },
    )) {
      raw += delta;
      yield { type: 'chunk', payload: { text: delta } };
    }
    html = extractHtml(raw);
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn('canvas/generate: model call failed', { err: msg });
    yield { type: 'error', payload: { message: `Generation failed: ${msg}` } };
    return;
  }

  // Reject stub/empty output (the "blank page with ..." failure) — fail loudly
  // rather than persist a blank artifact the iframe renders as a white page.
  if (looksLikeStub(html)) {
    logger.warn(`canvas/generate: stub artifact rejected — ${html.length} chars · model=${canvasModel()}`);
    yield { type: 'error', payload: { message: `Model "${canvasModel()}" returned an empty/stub artifact (${html.length} chars). This usually means a reasoning model consumed its token budget — set CANVAS_MODEL to a non-reasoning HTML generator (e.g. google/gemini-3.5-flash).` } };
    return;
  }

  const ms = Date.now() - t0;
  logger.info(`canvas/generate: llm.complete ok — ${ms}ms · ${html.length} chars`);
  yield { type: 'tool.call', payload: { name: 'llm.complete', ms, ok: true, chars: html.length } };

  const artifact: Artifact = {
    id:        randomUUID(),
    projectId: project.id,
    type:      'html',
    title:     brief.brief.slice(0, 80),
    content:   html,
    createdAt: Date.now(),
  };
  attachArtifact(project.id, artifact);
  logger.info(`canvas/generate: artifact emitted — ${artifact.id}`);

  // Persist HTML to disk so /api/canvas/artifact/:id can serve it raw.
  try {
    const dir = path.join(CANVAS_ROOT, project.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${artifact.id}.html`), html);
  } catch (err) {
    logger.warn('canvas/generate: artifact persist failed', { err: (err as Error).message });
  }

  yield { type: 'artifact.emit', payload: artifact };

  // Phase 5: self-critique.
  for (const t of todos) {
    if (t.id === 't5') t.status = 'in_progress';
    else if (['t1', 't2', 't3', 't4'].includes(t.id)) t.status = 'completed';
  }
  yield { type: 'todo.update', payload: todos };

  // Critique is a blocking (non-streamed) call — bracket it with tool.call
  // start/end markers so the activity log + stream meter show it's alive
  // rather than a silent 5–15s gap. Games skip it: the design critique scores
  // brand-fit/emotion, which is meaningless for a playable game.
  if (!isGame) {
    yield { type: 'tool.call', payload: { name: 'llm.critique', args: { persona: 'asia' } } };
    const tc = Date.now();
    try {
      const c = await callModelForCritique(html, brief, 'asia');
      setArtifactCritique(artifact.id, c);
      yield { type: 'tool.call', payload: { name: 'llm.critique', ms: Date.now() - tc, ok: true } };
      yield { type: 'critique.result', payload: c };
      logger.info('canvas/generate: critique done');
    } catch (err) {
      yield { type: 'tool.call', payload: { name: 'llm.critique', ms: Date.now() - tc, ok: false } };
      logger.warn('canvas/generate: critique failed', { err: (err as Error).message });
    }
  }

  for (const t of todos) {
    if (t.id === 't5' || t.id === 't6') t.status = 'completed';
  }
  yield { type: 'todo.update', payload: todos };
  // Persist the terminal status — the store otherwise leaves every project
  // stuck at 'building', so history badges never reflect completion.
  updateProject(project.id, { status: 'complete' });
  logger.info(`canvas/generate: project complete — ${project.id}`);
  yield { type: 'project.complete', payload: { projectId: project.id } };
}

export async function critique(
  artifactId: string,
  opts: { multiAgent?: boolean } = {},
): Promise<CritiqueResult> {
  const a = getArtifact(artifactId);
  if (!a) throw new Error(`unknown artifact: ${artifactId}`);
  const p = findProjectByArtifact(artifactId);
  if (!p) throw new Error(`no project for artifact: ${artifactId}`);

  const html = a.content;
  if (!opts.multiAgent) {
    const r = await callModelForCritique(html, p.brief, 'asia');
    setArtifactCritique(artifactId, r);
    return r;
  }

  const [asia, lucius, joker] = await Promise.all([
    callModelForCritique(html, p.brief, 'asia'),
    callModelForCritique(html, p.brief, 'lucius'),
    callModelForCritique(html, p.brief, 'joker'),
  ]);
  const merged = mergeCritiques(asia, lucius, joker);
  merged.multiAgent = { asia, lucius, joker };
  setArtifactCritique(artifactId, merged);
  return merged;
}

export async function* iterate(
  artifactId: string,
  instruction: string,
): AsyncIterable<CanvasEvent> {
  const a = getArtifact(artifactId);
  if (!a) {
    yield { type: 'error', payload: { message: `unknown artifact: ${artifactId}` } };
    return;
  }
  const p = findProjectByArtifact(artifactId);
  if (!p) {
    yield { type: 'error', payload: { message: `no project for artifact: ${artifactId}` } };
    return;
  }

  yield { type: 'project.start', payload: { projectId: p.id, briefId: p.briefId } };
  logger.info(`canvas/iterate: start — ${truncForLog(instruction)}`, { artifactId });
  yield { type: 'tool.call',     payload: { name: 'llm.iterate', args: { instruction } } };

  const direction = p.direction || pickDefaultDirection(p.brief);
  const sys = [
    systemPromptFor(p.brief, direction),
    '',
    'You are iterating on an existing artifact. Modify only what the instruction requests; keep everything else identical. Return the FULL updated HTML document.',
  ].join('\n');

  const t0 = Date.now();
  let html = '';
  try {
    let raw = '';
    for await (const delta of streamModelText(
      [
        { role: 'system', content: sys },
        { role: 'user',   content: `Existing artifact:\n${a.content}\n\nChange request:\n${instruction}\n\nReturn the full updated HTML.` },
      ],
      { temperature: 0.55, max_tokens: 16000 },
    )) {
      raw += delta;
      yield { type: 'chunk', payload: { text: delta } };
    }
    html = extractHtml(raw);
  } catch (err) {
    yield { type: 'error', payload: { message: `Iteration failed: ${(err as Error).message}` } };
    return;
  }

  if (looksLikeStub(html)) {
    logger.warn(`canvas/iterate: stub artifact rejected — ${html.length} chars · model=${canvasModel()}`);
    yield { type: 'error', payload: { message: `Model "${canvasModel()}" returned an empty/stub artifact (${html.length} chars) — set CANVAS_MODEL to a non-reasoning HTML generator (e.g. google/gemini-3.5-flash).` } };
    return;
  }

  const ms = Date.now() - t0;
  yield { type: 'tool.call', payload: { name: 'llm.iterate', ms, ok: true, chars: html.length } };
  logger.info(`canvas/iterate: llm.iterate ok — ${ms}ms`);

  const next: Artifact = {
    id:        randomUUID(),
    projectId: p.id,
    type:      'html',
    title:     `${a.title || 'Artifact'} — iter`,
    content:   html,
    createdAt: Date.now(),
  };
  attachArtifact(p.id, next);
  logger.info(`canvas/iterate: artifact emitted — ${next.id}`);
  try {
    const dir = path.join(CANVAS_ROOT, p.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${next.id}.html`), html);
  } catch { /* best-effort */ }

  yield { type: 'artifact.emit', payload: next };
  // Persist terminal status like generate() does — without this an iterated
  // project's history badge stays stuck at whatever it was (commonly 'building').
  updateProject(p.id, { status: 'complete' });
  logger.info(`canvas/iterate: project complete — ${p.id}`);
  yield { type: 'project.complete', payload: { projectId: p.id } };
}

export interface ExportResult {
  url:   string;     // dashboard-relative URL for download
  bytes: number;
  path:  string;     // absolute server-side path
}

export async function exportArtifact(
  artifactId: string,
  format: 'html' | 'pdf' | 'pptx' | 'zip' | 'mp4',
): Promise<ExportResult> {
  const a = getArtifact(artifactId);
  if (!a) throw new Error(`unknown artifact: ${artifactId}`);
  const p = findProjectByArtifact(artifactId);
  if (!p) throw new Error(`no project for artifact: ${artifactId}`);

  const dir = path.join(CANVAS_ROOT, p.id);
  fs.mkdirSync(dir, { recursive: true });

  if (format === 'html') {
    const fp = path.join(dir, `${a.id}.html`);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, a.content);
    return { url: `/api/canvas/artifact/${a.id}/file?format=html`, bytes: fs.statSync(fp).size, path: fp };
  }

  if (format === 'zip') {
    // Tiny "zip" — just write a folder bundle and stat the html. Real zipping
    // can come later via archiver; v1 keeps the dep surface small.
    const fp = path.join(dir, `${a.id}.html`);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, a.content);
    return { url: `/api/canvas/artifact/${a.id}/file?format=html`, bytes: fs.statSync(fp).size, path: fp };
  }

  // PDF / PPTX / MP4 are deferred to Phase 5 of the brief (huashu-design has
  // real exporters in huashu-design/scripts/export_deck_*.mjs that we'll wire
  // once huashu-design is installed as an opt-in skill).
  throw new Error(`Export to ${format} not yet implemented in v1 — install the huashu-design skill (opt-in) to enable PDF/PPTX/MP4 export.`);
}

// Convenience for routes — load a generated HTML file off disk.
export function readArtifactFile(artifactId: string): { content: string; type: string } | undefined {
  const a = getArtifact(artifactId);
  if (!a) return undefined;
  return { content: a.content, type: 'text/html; charset=utf-8' };
}
