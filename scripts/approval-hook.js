#!/usr/bin/env node
'use strict';

/**
 * NeuroClaw PreToolUse approval hook
 *
 * Claude Code pipes a JSON object to stdin describing the tool call that is
 * about to run.  This script either auto-approves safe/read-only operations
 * or submits the call to the NeuroClaw dashboard approval queue and polls
 * until a decision is made.
 *
 * Exit codes:
 *   0  – approved (stdout: {"decision":"approve"})
 *   2  – blocked  (stdout: {"decision":"block","reason":"..."})
 *
 * Fail-open: any unexpected error or timeout → approve + log to stderr.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the project .env file from the repo root (same dir as package.json). */
function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const raw = fs.readFileSync(envPath, 'utf8');
    const result = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val  = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
    return result;
  } catch (_) {
    return {};
  }
}

const dotEnvVars = loadDotEnv();

function getEnv(key, fallback) {
  return process.env[key] || dotEnvVars[key] || fallback;
}

const DASHBOARD_PORT  = getEnv('DASHBOARD_PORT',  '3141');
const DASHBOARD_TOKEN = getEnv('DASHBOARD_TOKEN', 'change-me');

// Polling configuration
const POLL_INTERVAL_MS = 1500;          // 1.5 s between polls
const MAX_WAIT_MS      = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Safe-pattern definitions
// ---------------------------------------------------------------------------

/**
 * Returns true if this tool call should be auto-approved without queuing.
 *
 * Patterns are deliberately conservative: if in doubt the call goes to the
 * queue.
 */
function isSafe(toolName, toolInput) {
  // These tools are inherently read-only
  if (toolName === 'Read')      return true;
  if (toolName === 'WebFetch')  return true;
  if (toolName === 'WebSearch') return true;

  // For Bash we inspect the command string
  if (toolName === 'Bash') {
    const cmd = (toolInput && typeof toolInput.command === 'string')
      ? toolInput.command.trim()
      : '';

    if (!cmd) return false; // empty command – let it queue (shouldn't happen)

    // --- git read-only sub-commands ---
    if (/^git\s+(status|log|diff|show|branch)(\s|$)/.test(cmd)) return true;

    // --- filesystem inspection ---
    if (/^(ls|find|grep|cat|head|tail|wc)(\s|$)/.test(cmd)) return true;

    // --- npm / node tooling (read/compile, no side effects) ---
    if (/^npm\s+run\s/.test(cmd))         return true;
    if (/^npx\s+tsc(\s|$)/.test(cmd))     return true;

    // --- basic shell introspection ---
    if (/^node\s+--version(\s|$)/.test(cmd)) return true;
    if (/^which\s/.test(cmd))               return true;
    if (/^echo(\s|$)/.test(cmd))            return true;

    // --- curl (all methods — agents need to POST to APIs) ---
    if (/^curl(\s|$)/.test(cmd)) return true;

    // --- python / pip (pydantic agents, scripts) ---
    if (/^python3?(\s|$)/.test(cmd)) return true;
    if (/^pip3?(\s|$)/.test(cmd))    return true;

    // --- node / tsx script execution ---
    if (/^node(\s|$)/.test(cmd)) return true;
    if (/^tsx(\s|$)/.test(cmd))  return true;

    return false;
  }

  // Unknown tool – send to queue
  return false;
}

// ---------------------------------------------------------------------------
// HTTP helpers (pure Node core, no dependencies)
// ---------------------------------------------------------------------------

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const reqOptions = {
      hostname: '127.0.0.1',
      port:     parseInt(DASHBOARD_PORT, 10),
      path:     options.path,
      method:   options.method || 'GET',
      headers: {
        'Content-Type':        'application/json',
        'x-dashboard-token':   DASHBOARD_TOKEN,
        'Content-Length':      Buffer.byteLength(bodyStr),
        ...options.headers,
      },
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('HTTP request timed out'));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Read stdin
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write('[approval-hook] Failed to parse stdin JSON: ' + err.message + '\n');
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }

  const { tool_name, tool_input, session_id, agent_name } = payload;

  // 2. Check safe patterns — auto-approve immediately
  if (isSafe(tool_name, tool_input)) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }

  // 3. Submit to approval queue
  let approvalId;
  try {
    const response = await httpRequest(
      { path: '/api/approvals', method: 'POST' },
      { tool_name, tool_input, session_id, agent_name }
    );

    if (response.status === 201 || response.status === 200) {
      approvalId = response.body && (response.body.id || response.body.approval_id);
    }

    if (!approvalId) {
      process.stderr.write(
        '[approval-hook] Dashboard returned unexpected response ' +
        response.status + ': ' + JSON.stringify(response.body) + '\n'
      );
      // Fail open
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }
  } catch (err) {
    process.stderr.write('[approval-hook] Dashboard unreachable: ' + err.message + '\n');
    // Fail open — dashboard may not be running
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }

  // 4. Poll for decision
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    // Wait before polling (also covers the first poll — give the dashboard
    // a moment to persist the record)
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let pollResponse;
    try {
      pollResponse = await httpRequest(
        { path: '/api/approvals/' + approvalId, method: 'GET' }
      );
    } catch (err) {
      process.stderr.write('[approval-hook] Poll error: ' + err.message + '\n');
      // Transient network error — keep trying until deadline
      continue;
    }

    if (pollResponse.status !== 200) {
      // Record may not exist yet — keep polling
      continue;
    }

    const record = pollResponse.body;
    const status = record && (record.status || record.decision);

    if (status === 'approved') {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    if (status === 'denied') {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason:   'Denied via dashboard',
      }));
      process.exit(2);
    }

    // Any other status (pending, etc.) — keep polling
  }

  // 5. Timeout — fail open
  process.stderr.write(
    '[approval-hook] Approval timed out after 5 minutes for tool "' +
    tool_name + '" (id=' + approvalId + '). Auto-approving.\n'
  );
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write('[approval-hook] Unexpected error: ' + err.message + '\n');
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
});
