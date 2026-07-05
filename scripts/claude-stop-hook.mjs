#!/usr/bin/env node
// Claude Code hook → POST to NeuroClaw /api/claude-hook.
// Usage (from generated --settings):
//   node claude-stop-hook.mjs --event stop|tool|notification --session <id> --secret <s> --url <url>
import { readFileSync } from 'fs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : '';
}
const event   = arg('event');
const session = arg('session');
const secret  = arg('secret');
const url     = arg('url');

let stdin = '';
try { stdin = readFileSync(0, 'utf-8'); } catch { /* no stdin */ }
let hook = {};
try { hook = JSON.parse(stdin || '{}'); } catch { /* ignore */ }

let text = '';
let tool = '';
let count = 0;   // # of assistant text blocks in the transcript — monotonic per turn.

function readTranscript(tp) {
  let t = '', n = 0;
  try {
    for (const line of readFileSync(tp, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant') {
        for (const b of (ev.message?.content || [])) {
          if (b && b.type === 'text') { t = b.text; n++; }
        }
      }
    }
  } catch { /* transcript unreadable */ }
  return { text: t, count: n };
}

if (event === 'stop') {
  // The Stop hook can fire a few ms before Claude flushes the assistant message
  // to the transcript JSONL — reading immediately would see count:0/empty text.
  // Re-read until the count stabilizes (two equal non-zero reads) or ~3s elapses,
  // so we always POST the completed turn's final message.
  const tp = hook.transcript_path;
  if (tp) {
    let prev = -1;
    for (let i = 0; i < 16; i++) {
      const r = readTranscript(tp);
      text = r.text; count = r.count;
      if (count > 0 && count === prev) break;   // stable, flushed
      prev = count;
      await new Promise((res) => setTimeout(res, 200));
    }
  }
} else if (event === 'tool') {
  tool = hook.tool_name || '';
} else if (event === 'notification') {
  text = hook.message || '';
}

// `count` lets the server ignore a stale Stop that fires before the new turn's
// assistant message is appended (it carries the OLD count) — the provider only
// resolves a turn when count exceeds the last resolved count.
const body = JSON.stringify({ sessionId: session, secret, event, text, tool, count });
try {
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
} catch { /* dashboard down — hook is best-effort */ }
