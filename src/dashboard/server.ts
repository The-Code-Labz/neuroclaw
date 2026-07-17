import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logAnalytics, recoverOrphanAgentTasks, recoverStuckDoingTasks } from '../db';
import { registerApiRoutes } from './routes';
import { tokenMatches } from './auth';
import { registerOpenAiCompatRoutes } from './openai-compat-routes';
import { handleMcpRequest } from './mcp-route';
import { ensureCodexMcpRegistered } from '../system/codex-config-writer';
import { syncSkillExports } from '../skills/exporters';
import { startDiscordNotifier } from '../system/discord-notifier';
import { startDiscordBotManager } from '../integrations/discord-bot';
import { startConfigWatcher } from '../system/config-watcher';
import { markBootHealthy, isBootUnproven } from '../system/self-update';
import { startCleanupScheduler } from '../system/cleanup';
import { checkStandardsFreshness } from '../standards/freshness';
import { initStandardsHookRegistration } from '../standards/hook-registration';
import { startSessionCleanupScheduler, startAnalyticsRetentionCleanup } from '../system/session-cleanup';
import { startBackupScheduler } from '../system/db-backup';
import { startCatalogRefresh } from '../system/model-catalog';
import { seedDefaultAreas } from '../db';
import { startDreamScheduler } from '../memory/dream-cycle';
import { startHeartbeatScheduler } from '../system/heartbeat';
import { startSentinel } from '../system/sentinel';
import { startStaleRunSweeper } from '../system/stale-run-sweeper';
import { startRunDelivery } from '../system/run-delivery';
import { startRunContinuation } from '../system/run-continuation';
import { startSubtaskContinuation } from '../system/subtask-continuation';
import { startLogAnalyzer } from '../system/log-analyzer';
import { startTaskHealthMonitor } from '../system/task-health';
import { startCronScheduler } from '../system/cron-scheduler';
import { startJobWorker } from '../system/job-worker';
import { assertKbEmbeddingHealthy, assertMemoryEmbeddingHealthy } from '../kb/kb-embeddings';
import { startTaskWatchdog } from '../system/task-watchdog';
import { startStephanieScheduler } from '../system/stephanie';
import { startTaskArchivist } from '../system/task-archivist';
import { startHandoffRecoverySweep } from '../system/handoff-recovery';
import { startHandoffArchivist } from '../system/handoff-archivist';
import { startCurator } from '../system/curator';
import { probeAll as probeMcpServers } from '../mcp/mcp-registry';
import { validateRegistryShapes } from '../tools/registry';
import { startProviderHealthPolling } from '../infra/provider-health';
import { startGrokUsageWarmer } from '../infra/grok-usage';
import { initAntigravityModel } from '../providers/antigravity';
import { attachTerminalWs } from './terminal-ws';
import { initBrokerStorage, resolveAllSecretsFromBroker } from '../broker/bootstrap';
import { inngestServeHandler } from '../system/inngest-serve';
import { verifyHookSecret, resolveClaudeHook, reapInteractiveSessions } from '../providers/claude-interactive';
import { startCookieSyncServer } from './cookie-sync-server';

// Track server start time for uptime analytics
const SERVER_START_TIME = Date.now();

// ── Dashboard process singleton guard ────────────────────────────────────────
// Kills any existing dashboard processes before starting to prevent duplicates.
const PIDFILE = '/tmp/neuroclaw-dashboard.pid';

function killExistingDashboard(): void {
  try {
    // Method 1: Kill by PID file
    if (fs.existsSync(PIDFILE)) {
      const oldPid = parseInt(fs.readFileSync(PIDFILE, 'utf-8').trim(), 10);
      if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 'SIGTERM');
          logger.info(`dashboard: killed previous process (PID ${oldPid})`);
        } catch {
          // Process may already be dead
        }
      }
    }
    
    // Method 2: Force-kill anything on our port (fallback)
    try {
      execSync(`fuser -k ${config.dashboard.port}/tcp 2>/dev/null || true`, { stdio: 'ignore' });
    } catch {
      // fuser not available or no process on port
    }
    
  } catch (err) {
    logger.warn('dashboard: cleanup error', { err: (err as Error).message });
  }
}

function writePidFile(): void {
  try {
    fs.writeFileSync(PIDFILE, String(process.pid));
  } catch (err) {
    logger.warn('dashboard: failed to write PID file', { err: (err as Error).message });
  }
}

function cleanupPidFile(): void {
  try {
    if (fs.existsSync(PIDFILE)) {
      const storedPid = parseInt(fs.readFileSync(PIDFILE, 'utf-8').trim(), 10);
      if (storedPid === process.pid) {
        fs.unlinkSync(PIDFILE);
      }
    }
  } catch {
    // Ignore cleanup errors on exit
  }
}

// Kill existing instances before we start
killExistingDashboard();

// Brief delay to let OS release the port
const startupDelay = process.env.DASHBOARD_NO_DELAY ? 0 : 500;
setTimeout(() => {
  writePidFile();
  startServer();
}, startupDelay);

// Cleanup PID file on exit and track shutdown analytics
process.on('exit', cleanupPidFile);
process.on('SIGINT', () => {
  const uptimeMs = Date.now() - SERVER_START_TIME;
  try { logAnalytics('server_shutdown', { reason: 'SIGINT', uptimeMs }); } catch { /* db may be closed */ }
  cleanupPidFile();
  process.exit(0);
});
process.on('SIGTERM', () => {
  const uptimeMs = Date.now() - SERVER_START_TIME;
  try { logAnalytics('server_shutdown', { reason: 'SIGTERM', uptimeMs }); } catch { /* db may be closed */ }
  cleanupPidFile();
  process.exit(0);
});

// Keep the server alive if a stray uncaught exception slips through (e.g.
// unhandled stream errors from child processes). Log and track in analytics.
process.on('uncaughtException', (err) => {
  logger.error('dashboard: uncaughtException — server kept alive', { message: err.message, stack: err.stack?.slice(0, 800) });
  try { logAnalytics('server_error', { type: 'uncaughtException', message: err.message, stack: err.stack?.slice(0, 500) }); } catch { /* ignore */ }
  // Self-update canary Layer B: while a post-update boot is unproven, a startup
  // throw must actually CRASH (not limp along half-initialized) so the CJS
  // ExecStartPre pre-check can count the failed attempt and auto-revert.
  try {
    if (isBootUnproven()) {
      logger.error('dashboard: uncaughtException during unproven post-update boot — exiting to trigger canary revert');
      process.exit(1);
    }
  } catch { /* never let the guard itself keep us from the normal keep-alive */ }
});
process.on('unhandledRejection', (reason) => {
  logger.error('dashboard: unhandledRejection — server kept alive', { reason: String(reason).slice(0, 400) });
  try { logAnalytics('server_error', { type: 'unhandledRejection', reason: String(reason).slice(0, 400) }); } catch { /* ignore */ }
});

function startServer(): void {
  // TODO [Discord bot]: Replace or augment this server with a Discord.js client
  // TODO [MCP bridge]: Mount an MCP server alongside Hono for IDE tool integration
  // TODO [LiveKit]: Initialise a LiveKit room server connection here

  const app = new Hono<{ Bindings: HttpBindings }>();

  // Singleton guard for MCP probe interval
  let mcpProbeTimer: NodeJS.Timeout | null = null;

// Public PWA assets — no auth required
app.get('/manifest.json', (c) => {
  return c.json({
    name: 'NeuroClaw',
    short_name: 'NeuroClaw',
    description: 'AI Command OS',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#000814',
    theme_color: '#00b7ff',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
});

const NEUROCLAW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#00e0ff"/>
      <stop offset="55%" stop-color="#4da8ff"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
    <radialGradient id="bg" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#0a1a2e"/>
      <stop offset="100%" stop-color="#050a12"/>
    </radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.8" result="blur"/>
      <feColorMatrix in="blur" type="matrix"
        values="0 0 0 0 0
                0 0.72 0.95 0 0
                0 0 1 0 0
                0 0 0 1.6 0" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="dotglow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <!-- Background -->
  <rect width="100" height="100" rx="20" fill="url(#bg)"/>
  <!-- Subtle cyan border -->
  <rect x="1.5" y="1.5" width="97" height="97" rx="19" fill="none" stroke="#00b7ff" stroke-width="1" opacity="0.22"/>
  <!-- Three claw slashes -->
  <g filter="url(#glow)" fill="none" stroke="url(#cg)" stroke-linecap="round" stroke-width="7.5">
    <line x1="24" y1="21" x2="32" y2="81"/>
    <line x1="44.5" y1="18" x2="52.5" y2="82"/>
    <line x1="65" y1="21" x2="72" y2="81"/>
  </g>
  <!-- Terminal node dots — top of each slash -->
  <g filter="url(#dotglow)">
    <circle cx="24" cy="21" r="4.5" fill="#00e0ff"/>
    <circle cx="44.5" cy="18" r="4.5" fill="#00e0ff"/>
    <circle cx="65" cy="21" r="4.5" fill="#00e0ff"/>
  </g>
  <!-- Tiny connecting bar at top for the "claw" silhouette -->
  <line x1="24" y1="21" x2="65" y2="21" stroke="#00b7ff" stroke-width="1.2" opacity="0.35" stroke-linecap="round"/>
</svg>`;

app.get('/favicon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(NEUROCLAW_SVG);
});

app.get('/icon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(NEUROCLAW_SVG);
});

// Service-worker cache version, derived ONCE at boot from the built entry-chunk hashes
// of BOTH dashboard v2 and v4 (dist/index.html → index-<hash>.js). Because that hash
// changes on every frontend rebuild, the SW cache name changes too — so `activate`
// purges every stale chunk on the next load after ANY deploy. This is the permanent fix
// for "PWA keeps running old code": a byte-identical sw.js never re-activated, so
// cache-first JS chunks lingered forever. Falls back to a boot timestamp if the built
// HTML can't be read (dev / no-build).
function hashFromDashboardDist(distDir: string): string | null {
  try {
    const html = fs.readFileSync(
      path.resolve(process.cwd(), `src/dashboard/${distDir}/dist/index.html`),
      'utf-8',
    );
    const m = html.match(/index-([A-Za-z0-9_-]+)\.js/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const SW_CACHE_VERSION: string = (() => {
  const v2Hash = hashFromDashboardDist('v2') ?? 'none';
  const v4Hash = hashFromDashboardDist('v4') ?? 'none';
  // Combine both hashes so a v4-only rebuild still busts the cache.
  if (v2Hash !== 'none' || v4Hash !== 'none') return `${v2Hash}-${v4Hash}`;
  return 'boot-' + Date.now();
})();

app.get('/sw.js', (c) => {
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  // Cache name is tied to the built entry hash (SW_CACHE_VERSION) so 'activate' purges
  // every old cache on each deploy automatically. SHELL holds ONLY static assets.
  // '/chat-mode' is intentionally NOT precached: it is a navigation document whose HTML
  // is generated per-request (the server injects the auth token into it), so caching it
  // cache-first served a stale, broken shell after deploys.
  return c.body(`const CACHE='neuroclaw-${SW_CACHE_VERSION}-dash';const SHELL=['/manifest.json','/chat-mode-manifest.json','/icon.svg','/favicon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([clients.claim(),caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))]));});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname.endsWith('.jsx'))return;
// Navigation documents (e.g. /chat-mode): network-first so a fresh, token-injected HTML
// shell always wins; fall back to cache only when offline. Never serve a stale document.
if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||new Response('',{status:503}))));return;}
// Static assets: cache-first.
e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).catch(()=>new Response('',{status:503}))));});`);
});

app.get('/chat-mode-manifest.json', (c) => {
  return c.json({
    name: 'NeuroClaw Chat',
    short_name: 'NC Chat',
    description: 'Talk to your AI agents',
    start_url: '/chat-mode',
    scope: '/chat-mode',
    display: 'standalone',
    background_color: '#1a1814',
    theme_color: '#d97b5e',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
});

// ── Dashboard auth helpers ───────────────────────────────────────────────────
// The HttpOnly cookie is the single source of truth for browser auth. `Secure`
// is added only when the request arrived over HTTPS (a public reverse proxy sets
// x-forwarded-proto) so local http://localhost dev keeps working. The token is
// NEVER placed in a URL — it lives only in this cookie after a one-time login.
function setAuthCookie(c: Context): void {
  const https = c.req.header('x-forwarded-proto') === 'https';
  c.header(
    'Set-Cookie',
    `dashboard-token=${config.dashboard.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${https ? '; Secure' : ''}`
  );
}

// Only same-origin dashboard paths may be used as a post-login redirect target.
// Everything else (protocol-relative //evil.com, backslash tricks, absolute URLs,
// encoded variants) falls back to /dashboard to prevent open-redirect / reflected XSS.
function safeNext(raw: string | undefined): string {
  const allow = ['/dashboard', '/chat-mode'];
  try {
    const dec = decodeURIComponent(raw ?? '');
    const u = new URL(dec, 'http://placeholder.invalid');
    if (u.origin === 'http://placeholder.invalid' && allow.includes(u.pathname)) {
      return u.pathname;
    }
  } catch { /* malformed → default below */ }
  return '/dashboard';
}

// Minimal per-IP throttle for the unauthenticated /api/login endpoint. Constant-time
// compare kills the timing oracle; this blunts online brute-force of a weak token.
const _loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = _loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    _loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > LOGIN_MAX_ATTEMPTS;
}

// Login page — unguarded. Takes the dashboard token once, validates it server-side,
// and sets the HttpOnly cookie. No token ever appears in a URL. `next` is allowlisted
// server-side (safeNext) AND the page hardcodes the redirect target, so nothing
// user-controlled is reflected into the DOM.
const LOGIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>NeuroClaw — Sign in</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:radial-gradient(1200px 600px at 50% -10%,#1a2233,#0b0e14);color:#e6edf3}
  .card{width:min(92vw,380px);background:#0f141c;border:1px solid #222c3a;border-radius:16px;padding:28px 26px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  h1{font-size:20px;margin:0 0 4px;letter-spacing:.5px}
  p{margin:0 0 18px;color:#8b98a9;font-size:13px}
  label{display:block;font-size:12px;color:#8b98a9;margin:0 0 6px}
  input{width:100%;padding:11px 12px;background:#0b0e14;border:1px solid #2a3546;border-radius:10px;color:#e6edf3;font-size:14px;outline:none}
  input:focus{border-color:#3b82f6}
  button{width:100%;margin-top:16px;padding:11px;background:#2563eb;color:#fff;border:0;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .err{margin-top:12px;color:#f87171;font-size:13px;min-height:18px}
</style></head><body>
<form class="card" id="f" autocomplete="off">
  <h1>NeuroClaw</h1>
  <p>Enter your dashboard token to continue.</p>
  <label for="t">Dashboard token</label>
  <input id="t" type="password" autocomplete="current-password" autofocus placeholder="••••••••••••••••" />
  <button id="b" type="submit">Sign in</button>
  <div class="err" id="e"></div>
</form>
<script>
  var f=document.getElementById('f'),t=document.getElementById('t'),b=document.getElementById('b'),e=document.getElementById('e');
  f.addEventListener('submit', async function(ev){
    ev.preventDefault(); e.textContent=''; b.disabled=true;
    try{
      var r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({token:t.value})});
      if(r.ok){ var d=await r.json(); location.replace(d.next||'/dashboard'); return; }
      e.textContent = r.status===429 ? 'Too many attempts. Wait a minute and try again.' : 'Invalid token.';
    }catch(_){ e.textContent='Network error. Try again.'; }
    b.disabled=false;
  });
</script></body></html>`;

app.get('/login', (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return c.html(LOGIN_HTML);
});

// Token guard for /chat-mode — same pattern as /dashboard
app.use('/chat-mode', async (c, next) => {
  const cookie = c.req.header('cookie') ?? '';
  const cookieToken = /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookie)?.[1];
  const token = c.req.query('token') || cookieToken || '';
  if (!tokenMatches(token, config.dashboard.token)) {
    return c.redirect('/login?next=' + encodeURIComponent('/chat-mode'));
  }
  await next();
});

app.get('/chat-mode', (c) => {
  try {
    let html = fs.readFileSync(
      path.resolve(process.cwd(), 'src/dashboard/chat-mode.html'),
      'utf-8'
    );
    // Inject token into the HTML so the PWA has it even when launched standalone
    // (without ?token= in the URL). The HttpOnly cookie handles server-side auth,
    // but the client-side JS needs the token for API calls.
    html = html.replace(
      "const TOKEN = _tokenFromUrl || localStorage.getItem('nclaw-token') || '';",
      `const _serverInjectedToken = '${config.dashboard.token}';\nconst TOKEN = _tokenFromUrl || localStorage.getItem('nclaw-token') || _serverInjectedToken;`
    );
    setAuthCookie(c);
    return c.html(html);
  } catch (err) {
    return c.text(`Chat Mode not found: ${(err as Error).message}`, 500);
  }
});

// Token guard for /dashboard — accepts ?token query OR persistent cookie
app.use('/dashboard', async (c, next) => {
  const cookie = c.req.header('cookie') ?? '';
  const cookieToken = /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookie)?.[1];
  const token = c.req.query('token') || cookieToken || '';
  if (!tokenMatches(token, config.dashboard.token)) {
    return c.redirect('/login?next=' + encodeURIComponent('/dashboard'));
  }
  await next();
});

// ── Main Dashboard (v2 - React + Babel via CDN) ──────────────────────────
const V2_ROOT = path.resolve(process.cwd(), 'src/dashboard/v2');

app.get('/dashboard', (c) => {
  try {
    // Prefer the Vite-built production bundle (dist/index.html) when available.
    // Fall back to the raw JSX + Babel dev version otherwise.
    const distHtml = path.join(V2_ROOT, 'dist', 'index.html');
    const devHtml  = path.join(V2_ROOT, 'NeuroClaw.html');
    const useBuilt = fs.existsSync(distHtml);

    let html = fs.readFileSync(useBuilt ? distHtml : devHtml, 'utf-8');
    if (!useBuilt) {
      // Inject <base> so relative script srcs (src/icons.jsx, etc) resolve under /dashboard/.
      // Not needed for the built version — Vite bakes /dashboard/ base into asset paths.
      html = html.replace('<head>', '<head>\n<base href="/dashboard/">');
    }
    // Set a long-lived cookie so PWA launches and cookie-only clients stay auth'd
    setAuthCookie(c);
    return c.html(html);
  } catch (err) {
    return c.text(`Dashboard not found: ${(err as Error).message}`, 500);
  }
});

// Built dashboard assets (from `npm run build:dashboard`) — served with immutable,
// long-lived caching. Hashed filenames (e.g. index-abc123.js) guarantee cache-bust
// on every new build. Registered BEFORE the token-guarded /dashboard route so the
// browser can fetch assets without needing to re-auth.
const V2_DIST = path.join(V2_ROOT, 'dist');
app.use('/dashboard/assets/*', serveStatic({
  root: path.join(V2_DIST),
  rewriteRequestPath: (p) => p.replace(/^\/dashboard/, ''),
  onFound: (_fp, c) => {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

// Static assets for dashboard — JSX source files (dev fallback, no Vite build)
app.use('/dashboard/*', serveStatic({
  root: 'src/dashboard/v2',
  rewriteRequestPath: (p) => p.replace(/^\/dashboard/, ''),
  onFound: (filepath, c) => {
    if (filepath.endsWith('.jsx')) {
      // 5-minute cache for JSX in dev — eliminates redundant re-downloads on every
      // refresh while keeping iteration fast. Hard-refresh (Ctrl+Shift+R) bypasses.
      c.header('Cache-Control', 'public, max-age=300');
      c.header('Content-Type',  'application/javascript; charset=utf-8');
    }
  },
}));

// Built dashboard v4 assets — served with immutable caching, no auth required.
const V4_ROOT = path.resolve(process.cwd(), 'src/dashboard/v4');
const V4_DIST = path.join(V4_ROOT, 'dist');
app.use('/dashboard-v4/assets/*', serveStatic({
  root: V4_DIST,
  rewriteRequestPath: (p) => p.replace(/^\/dashboard-v4/, ''),
  onFound: (_fp, c) => {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

// Legacy /dashboard-v2 redirect for any old bookmarks
app.get('/dashboard-v2', (c) => c.redirect(`/dashboard?token=${c.req.query('token') || ''}`));
app.get('/dashboard-v2/*', (c) => {
  const subpath = c.req.path.replace('/dashboard-v2', '/dashboard');
  return c.redirect(subpath);
});

// Token guard for /dashboard-v4 — accepts ?token query OR persistent cookie
app.use('/dashboard-v4', async (c, next) => {
  const cookie = c.req.header('cookie') ?? '';
  const cookieToken = /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookie)?.[1];
  const token = c.req.query('token') || cookieToken || '';
  if (!tokenMatches(token, config.dashboard.token)) {
    return c.redirect('/login?next=' + encodeURIComponent('/dashboard-v4'));
  }
  await next();
});

// Main Dashboard v4 (React + Vite build)
app.get('/dashboard-v4', (c) => {
  try {
    const distHtml = path.join(V4_DIST, 'index.html');
    if (!fs.existsSync(distHtml)) {
      return c.text('Dashboard v4 has not been built. Run npm run build:dashboard:v4', 500);
    }
    setAuthCookie(c);
    return c.html(fs.readFileSync(distHtml, 'utf-8'));
  } catch (err) {
    return c.text(`Dashboard v4 not found: ${(err as Error).message}`, 500);
  }
});

// Serve uploaded agent avatars + agent-sent chat images
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(path.join(UPLOADS_DIR, 'avatars'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'chat'),    { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'images'),  { recursive: true });
app.get('/uploads/*', (c) => {
  const rel = c.req.path.replace(/^\/uploads\//, '');
  const abs = path.join(UPLOADS_DIR, rel);
  if (!abs.startsWith(UPLOADS_DIR) || !fs.existsSync(abs)) return c.notFound();
  const ext = path.extname(abs).toLowerCase();
  const mime: Record<string, string> = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp' };
  c.header('Content-Type', mime[ext] ?? 'application/octet-stream');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(fs.readFileSync(abs) as unknown as ReadableStream);
});

// Public audio file serving — no auth token (URLs are UUID-based, unguessable).
// Must be registered BEFORE registerApiRoutes to stay outside the /api/* auth middleware.
const AUDIO_TMP_DIR = path.resolve(process.cwd(), 'tmp', 'audio');
app.get('/api/audio/file/:filename', (c) => {
  const filename = c.req.param('filename');
  // Allow only <uuid>.mp3 — reject anything with path separators or unexpected chars.
  if (!/^[a-zA-Z0-9_-]+\.mp3$/.test(filename)) return c.notFound();
  const abs = path.join(AUDIO_TMP_DIR, filename);
  if (!abs.startsWith(AUDIO_TMP_DIR) || !fs.existsSync(abs)) return c.notFound();
  c.header('Content-Type', 'audio/mpeg');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(fs.readFileSync(abs) as unknown as ReadableStream);
});

// Inngest durable-execution webhook — no dashboard token (the Inngest server
// authenticates via INNGEST_SIGNING_KEY). Must be registered BEFORE
// registerApiRoutes so it stays outside the /api/* token middleware, and handles
// PUT (sync/register), POST (execute function), and GET (introspect).
app.all('/api/inngest', inngestServeHandler);

// Claude interactive hook callback — no dashboard token (authed by per-session
// secret embedded in the generated --settings hook command). Registered before
// registerApiRoutes so it stays outside the /api/* token middleware.
app.post('/api/claude-hook', async (c) => {
  let body: { sessionId?: string; secret?: string; event?: string; text?: string; tool?: string; count?: number };
  try { body = await c.req.json(); } catch { return c.json({ ok: false }, 400); }
  if (!body.sessionId || !body.secret || !verifyHookSecret(body.sessionId, body.secret)) {
    return c.json({ ok: false }, 401);
  }
  const handled = resolveClaudeHook(body.sessionId, body.event ?? '', { text: body.text, tool: body.tool, count: body.count });
  return c.json({ ok: handled });
});

// Login endpoint — unguarded, registered BEFORE registerApiRoutes so it stays
// outside the /api/* auth middleware. Validates the token (constant-time) and sets
// the HttpOnly cookie; per-IP throttled. Returns a server-validated `next` target
// so the client can never be redirected off-origin.
app.post('/api/login', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    (c.env as HttpBindings)?.incoming?.socket?.remoteAddress ||
    'unknown';
  if (loginRateLimited(ip)) {
    return c.json({ ok: false, error: 'Too many attempts' }, 429);
  }
  let body: { token?: string; next?: string };
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid request' }, 400); }
  if (!tokenMatches(body.token, config.dashboard.token)) {
    logger.warn(`dashboard: failed login attempt from ${ip}`);
    return c.json({ ok: false, error: 'Invalid token' }, 401);
  }
  setAuthCookie(c);
  return c.json({ ok: true, next: safeNext(body.next) });
});

// Logout — clears the auth cookie.
app.get('/logout', (c) => {
  c.header('Set-Cookie', 'dashboard-token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  return c.redirect('/login');
});

registerApiRoutes(app);
registerOpenAiCompatRoutes(app);

// Streamable-HTTP MCP endpoint for external runtimes (Codex/Gemini CLI, etc).
// Both POST (RPC requests) and GET (SSE response stream) are handled by the
// same transport on the same path.
app.all('/mcp', handleMcpRequest);

// Redirect root → dashboard. No token in the URL — the /dashboard guard falls
// through to /login when there's no valid cookie, so anonymous visitors get the
// login page, never the token.
app.get('/', (c) => c.redirect('/dashboard'));

const httpServer = serve({ fetch: app.fetch, port: config.dashboard.port, hostname: config.dashboard.host }, (info) => {
  if (!process.env.DASHBOARD_TOKEN || config.dashboard.token === 'change-me' || config.dashboard.token.length < 16) {
    logger.warn('⚠️  dashboard: DASHBOARD_TOKEN is unset, default ("change-me"), or weak (<16 chars). Set a strong token in .env BEFORE exposing this server behind a reverse proxy.');
  }
  if (config.dashboard.host !== '127.0.0.1' && config.dashboard.host !== 'localhost') {
    logger.warn(`⚠️  dashboard: bound to non-loopback host ${config.dashboard.host} — reachable beyond this machine. Ensure this is a VPN/NetBird IP, NOT 0.0.0.0. Login token still required.`);
  }
  // Never echo the token. Sign in via the login page using your DASHBOARD_TOKEN.
  logger.info(`dashboard: listening → http://localhost:${info.port}/  (sign in with your DASHBOARD_TOKEN)`);
  
  // Track server startup in analytics
  logAnalytics('server_started', {
    port: info.port,
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
  });

  // Self-update canary: HTTP is listening AND migrations have run (via the
  // getDb() in logAnalytics above) — this boot is healthy. Clear any pending
  // update marker so the next boot won't auto-revert. Best-effort, non-gating.
  try { markBootHealthy(); } catch { /* ignore */ }

  attachTerminalWs(httpServer as unknown as import('http').Server);
  logger.info(`dashboard: MCP HTTP  → http://localhost:${info.port}/mcp`);
  // Resolve broker-managed API keys (background VoidAI key, Venice key) BEFORE
  // the model-catalog refresh. refreshVenice() reads config.venice.enabled,
  // which depends on the broker-injected VENICE_API_KEY — so startCatalogRefresh()
  // is chained after key resolution rather than racing it. The .finally()
  // guarantees the catalog still refreshes if the broker chain fails, so a
  // broker hiccup never blocks catalog refresh for the other providers.
  initBrokerStorage()
    .then(() => resolveAllSecretsFromBroker())
    .then(() => {
      // Broker has now injected INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY into
      // process.env. The Inngest client snapshotted env at construction (before
      // this resolved), so re-sync it now — otherwise inngest.send() has no key.
      void import('../system/inngest-client').then(({ refreshInngestEnv }) => refreshInngestEnv());
      // OpenArt: prime the "configured" flag from the LIVE broker RT presence
      // (never snapshotted into process.env — the RT rotates). config.openart.enabled
      // and the Studio health check delegate to openartConfigured().
      void import('../infra/openart-auth').then(({ primeOpenArtConfigured }) => primeOpenArtConfigured());
      // Higgsfield: same live-RT prime (rotating refresh token, never snapshotted).
      void import('../infra/higgsfield-auth').then(({ primeHiggsfieldConfigured }) => primeHiggsfieldConfigured());
    })
    .catch((err: unknown) => logger.warn('broker: startup key resolution failed', { err: (err as Error).message }))
    .finally(() => startCatalogRefresh());

  assertKbEmbeddingHealthy(); // fail loud if KB_ENABLED && embeddings off/mismatched (no-op when KB off)
  assertMemoryEmbeddingHealthy(); // fail loud if MEMORY_BACKEND=supabase && embeddings off/mismatched (no-op on sqlite)
  validateRegistryShapes(); // warn on schema/shape drift (tools validating differently per plane)
  startProviderHealthPolling(); // WS2: usage-window → soft cooldown bridge
  startGrokUsageWarmer(); // keep Grok CLI usage cache hot (cold PTY drive > panel's 10s fetch timeout)
  startConfigWatcher();
  startCleanupScheduler();
  checkStandardsFreshness();
  startSessionCleanupScheduler();
  startAnalyticsRetentionCleanup(); // Prune old analytics/spend data (90/180 days)
  startBackupScheduler(); // Auto-backup database daily, keep last 7
  if (config.claudeInteractive.enabled) {
    void reapInteractiveSessions();                                  // boot orphan sweep
    setInterval(() => { void reapInteractiveSessions(); }, 5 * 60_000);
    logger.info('claude-interactive: reaper started (5-min interval, boot orphan sweep done)');
  }
  seedDefaultAreas();
  startDreamScheduler();
  startHeartbeatScheduler();
  startSentinel();
  startRunDelivery();      // v3.x: deliver finished background runs to their origin surface
  startRunContinuation();  // v3.x: fire follow-up agent turn after a background run completes
  startSubtaskContinuation(); // proactively continue when fire-and-forget sub-agents finish
  startStaleRunSweeper();  // v3.2: flip mid-flight runs to 'dropped' if heartbeat goes silent
  startLogAnalyzer();
  startTaskHealthMonitor();
  startStephanieScheduler();
  startCronScheduler();
  startTaskArchivist();
  startHandoffArchivist();
  startCurator();
  const stuck = recoverStuckDoingTasks();
  if (stuck > 0) logger.info(`startup: reset ${stuck} task(s) stuck in 'doing' back to 'todo'`);
  const orphans = recoverOrphanAgentTasks();
  if (orphans > 0) logger.info(`startup: re-enqueued ${orphans} orphaned agent task(s)`);
  const handoffs = startHandoffRecoverySweep();
  if (handoffs > 0) logger.info(`startup: recovered ${handoffs} stale synchronous hand-off(s)`);
  // Tasks stranded in 'review' — the holdout verdict fires via a non-durable
  // setImmediate, so a restart mid-review leaves them with nothing to advance
  // them. At boot every review task is stranded (minAge=0); re-fire the verdict.
  void import('../system/task-manager').then(({ recoverStuckReviewTasks }) => {
    const reviews = recoverStuckReviewTasks(0);
    if (reviews > 0) logger.info(`startup: re-fired holdout verdict for ${reviews} stranded 'review' task(s)`);
  }).catch((err: unknown) => logger.warn('startup: review recovery failed', { err: (err as Error).message }));
  startJobWorker();
  startTaskWatchdog();
  // Idempotently register our MCP server in ~/.codex/config.toml so Codex
  // sessions can discover NeuroClaw tools.
  ensureCodexMcpRegistered({ url: `http://127.0.0.1:${info.port}/mcp` })
    .catch((err: unknown) => logger.warn('dashboard: codex MCP registration failed', { err: (err as Error).message }));
  syncSkillExports({ refresh: true })
    .catch((err: unknown) => logger.warn('dashboard: skill export sync failed', { err: (err as Error).message }));
  // Write the configured antigravity model to settings.json once at startup
  // so all agy spawns use the right model without per-call writes or races.
  initAntigravityModel();
  // Idempotently register the indexed-standards hook in Claude Code settings.
  initStandardsHookRegistration();
  // Multi-bot Discord manager — reads `discord_bots` table, spawns one
  // gateway client per enabled row, polls every 30s for adds/removes.
  startDiscordBotManager()
    .catch((err: unknown) => logger.warn('dashboard: discord-bot manager failed to start', { err: (err as Error).message }));
  // Dashboard notification → Discord mirror (needs a bot running).
  startDiscordNotifier();
  startCookieSyncServer(); // direct port, bypasses Cloudflare CORS injection
  // MCP server registry — probe every enabled server once on boot, then
  // periodically refresh so the dashboard sees up-to-date status. Probe
  // failures are logged but never propagate.
  probeMcpServers(true).catch((err: unknown) => logger.warn('dashboard: mcp registry initial probe failed', { err: (err as Error).message }));
    if (!mcpProbeTimer) {
      mcpProbeTimer = setInterval(() => {
        // Refresh Canva's OAuth token before the tools/list probe — a stale
        // bearer would otherwise flip the row to status='error' every ~1h
        // (Canva's typical access-token lifetime) until someone notices.
        // No-op when unconfigured or the token is still fresh (5min skew).
        import('../mcp/canva-oauth')
          .then((m) => m.ensureFreshCanvaToken())
          .catch((err: unknown) => logger.warn('dashboard: canva token refresh tick failed', { err: (err as Error).message }))
          .finally(() => {
            probeMcpServers(false).catch((err: unknown) => logger.warn('dashboard: mcp registry probe tick failed', { err: (err as Error).message }));
          });
      }, 60_000);
    }
  });
} // end startServer
