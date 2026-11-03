#!/usr/bin/env node
// Agent HQ v3 server. Zero dependencies, binds 127.0.0.1 only.
//   GET /            the office            GET /state     full state (first load)
//   GET /events      Server-Sent Events: only what changed (bots by id, counts, feed…)
//   GET /timeline    GET /stats    GET /api/health    GET /api/settings
//   POST /api/mute {muted}   POST /api/open {botId}   (same-origin JSON only)
// Files are read incrementally by byte offset; fs.watch (debounced) triggers refreshes,
// plus a 5 s heartbeat for time-based rules (stuck after 10 min, idle Codex threads).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { createEngine } = require('./core');

const HQ = path.join(os.homedir(), '.agent-hq');
const HOST = '127.0.0.1';
const PORT = +process.env.AGENT_HQ_PORT || 7777;
const PID_FILE = path.join(HQ, process.env.AGENT_HQ_PORT ? `server-${PORT}.pid` : 'server.pid');
const SETTINGS = path.join(HQ, 'settings.json');
const ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
const log = (...a) => console.log(new Date().toISOString(), ...a);

const engine = createEngine();
let settings = { muted: false };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch (e) {}
const saveSettings = () => { try { fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch (e) {} };

// ---------- Windows toast (built-in PowerShell + WinRT, no modules) ----------
const TOAST_PS = `
$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t=[Security.SecurityElement]::Escape($env:HQ_TOAST_TITLE); $b=[Security.SecurityElement]::Escape($env:HQ_TOAST_BODY)
$x=New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><audio silent='true'/></toast>")
$app='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;
const TOAST_ENC = Buffer.from(TOAST_PS, 'utf16le').toString('base64');
const toastLog = [];
function toast(title, body) {
  toastLog.push({ t: Date.now(), title, body }); if (toastLog.length > 50) toastLog.shift();
  if (settings.muted || process.platform !== 'win32' || process.env.AGENT_HQ_NO_TOAST) return;
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', TOAST_ENC],
      { env: { ...process.env, HQ_TOAST_TITLE: String(title).slice(0, 120), HQ_TOAST_BODY: String(body).slice(0, 240) }, windowsHide: true, stdio: 'ignore' })
      .on('error', () => {});
  } catch (e) {}
}

// ---------- state, diffs and the event stream ----------
let state = null, seq = 0, prevStatus = null;
const lastJSON = { bots: new Map(), top: {} };
const TOP = ['teams', 'counts', 'waiting', 'stuck', 'finished', 'totals', 'feed', 'stuckAfterMin', 'today'];
const clients = new Set();
let tickStats = { n: 0, ms: 0, maxMs: 0 };

function tick(reason) {
  const t0 = process.hrtime.bigint();
  let st;
  try { st = engine.tick(); } catch (e) { log('tick error', e.stack || e); return; }
  // toasts on transitions into waiting / stuck
  const cur = new Map();
  for (const b of st.bots) for (const r of b.robots) cur.set(r.key, { r, b });
  if (prevStatus) for (const [k, { r }] of cur) {
    const was = prevStatus.get(k);
    if ((r.status === 'waiting' || r.status === 'stuck') && was !== r.status && Date.now() - (lastToast.get(k) || 0) > 60000) {
      lastToast.set(k, Date.now());
      if (r.status === 'waiting') toast(`${r.label} is waiting on you`, r.waitingMsg || 'Needs your permission');
      else toast(`${r.label} looks stuck`, `No new line for ${st.stuckAfterMin}+ min. Last step: ${r.step}`);
    }
  }
  prevStatus = new Map([...cur].map(([k, v]) => [k, v.r.status]));
  // diff against what clients already have
  const patch = { bots: [], removed: [] };
  const seen = new Set();
  for (const b of st.bots) {
    const j = JSON.stringify(b); seen.add(b.id);
    if (lastJSON.bots.get(b.id) !== j) { lastJSON.bots.set(b.id, j); patch.bots.push(b); }
  }
  for (const id of [...lastJSON.bots.keys()]) if (!seen.has(id)) { lastJSON.bots.delete(id); patch.removed.push(id); }
  for (const k of TOP) { const j = JSON.stringify(st[k]); if (lastJSON.top[k] !== j) { lastJSON.top[k] = j; patch[k] = st[k]; } }
  const changed = patch.bots.length || patch.removed.length || TOP.some(k => k in patch);
  state = st;
  if (changed) {
    const base = seq; seq++;
    state.seq = seq;
    const msg = `data: ${JSON.stringify({ ...patch, seq, base, now: st.now })}\n\n`;
    for (const c of clients) { try { c.write(msg); } catch (e) {} }
  } else state.seq = seq;
  try { engine.persistStats(false); } catch (e) { log('stats error', e.message); }
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  tickStats.n++; tickStats.ms += dt; tickStats.maxMs = Math.max(tickStats.maxMs, dt); tickStats.last = reason;
}
const lastToast = new Map();
let tickTimer = null;
function scheduleTick(reason) { if (tickTimer) return; tickTimer = setTimeout(() => { tickTimer = null; tick(reason); }, 250); }

// ---------- file watching (debounced) ----------
const watchers = [];
function watch(dir, opts, onName) {
  try {
    const w = fs.watch(dir, opts, (ev, name) => { try { onName(name ? String(name) : ''); } catch (e) {} });
    w.on('error', () => { try { w.close(); } catch (e) {} const i = watchers.indexOf(w); if (i >= 0) watchers.splice(i, 1); });
    watchers.push(w); return true;
  } catch (e) { return false; }
}
function setupWatchers() {
  for (const w of watchers.splice(0)) try { w.close(); } catch (e) {}
  watch(HQ, {}, n => { if (/^events-|^roster\.json$|^prices\.json$/.test(n)) scheduleTick('hq:' + n); });
  watch(path.join(os.homedir(), '.claude', 'projects'), { recursive: true }, n => { if (n.endsWith('.jsonl')) scheduleTick('claude'); });
  const cx = path.join(engine.CODEX, 'sessions');
  watch(cx, { recursive: true }, n => { if (/rollout-.*\.jsonl$/.test(n)) { engine.addCodexFile(path.join(cx, n)); scheduleTick('codex'); } });
  watch(path.join(engine.CODEX, 'archived_sessions'), {}, n => { if (/^rollout-/.test(n)) { engine.addCodexFile(path.join(engine.CODEX, 'archived_sessions', n)); scheduleTick('codex-archive'); } });
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { ...SEC, 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, cb) {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch (e) { cb(null); } });
}
function openFolder(botId) {
  const bot = (engine.roster().bots || []).find(b => (b.id || b.name) === botId);
  if (!bot || !(bot.folders || []).length) return { code: 404, body: { error: 'not a roster bot with a folder' } };
  const dir = path.resolve(engine.expand(bot.folders[0]));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { code: 404, body: { error: 'folder not found', dir } };
  if (!process.env.AGENT_HQ_DRYRUN_OPEN) {
    try { spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref(); } catch (e) {}
  }
  return { code: 200, body: { ok: true, opened: dir } };
}
const cpu0 = { t: Date.now(), u: process.cpuUsage() };

const server = http.createServer((req, res) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'forbidden host' });
  const url = req.url.split('?')[0];

  if (req.method === 'POST') {
    if (!ORIGINS.includes(req.headers.origin) || !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 403, { error: 'forbidden origin' });
    return readBody(req, body => {
      if (!body) return send(res, 400, { error: 'bad json' });
      if (url === '/api/mute') { settings.muted = !!body.muted; saveSettings(); return send(res, 200, settings); }
      if (url === '/api/open') { const r = openFolder(String(body.botId || '')); return send(res, r.code, r.body); }
      return send(res, 404, { error: 'not found' });
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });

  try {
    if (url === '/events') {
      res.writeHead(200, { ...SEC, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ seq, version: 3 })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url === '/state') { if (!state) tick('first'); return send(res, 200, { ...state, seq, muted: settings.muted }); }
    if (url === '/timeline') return send(res, 200, engine.timeline());
    if (url === '/stats') return send(res, 200, engine.stats(7));
    if (url === '/api/health') {
      const u = process.cpuUsage(cpu0.u), el = (Date.now() - cpu0.t) * 1000;
      return send(res, 200, { ok: true, pid: process.pid, port: PORT, version: 3, hq: HQ, clients: clients.size, watchers: watchers.length,
        cpuPercentSinceStart: +(100 * (u.user + u.system) / el).toFixed(3), rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
        heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1), ticks: tickStats.n, avgTickMs: tickStats.n ? +(tickStats.ms / tickStats.n).toFixed(2) : 0, maxTickMs: +tickStats.maxMs.toFixed(1) });
    }
    if (url === '/api/settings') return send(res, 200, settings);
    if (url === '/api/toasts') return send(res, 200, toastLog);
  } catch (e) { log('request error', url, e.stack || e); return send(res, 500, { error: String(e.message || e) }); }

  let file = null;
  if (url === '/' || url === '/index.html') file = path.join(__dirname, 'web', 'index.html');
  else { const m = /^\/vendor\/([\w.-]+\.(?:js|txt|md))$/.exec(url); if (m) file = path.join(__dirname, 'vendor', m[1]); }
  if (!file) { const m = /^\/web\/([\w.-]+\.(?:js|css))$/.exec(url); if (m) file = path.join(__dirname, 'web', m[1]); }
  if (!file) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => err ? send(res, 404, { error: 'not found' }) : send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' }));
});

function cleanup() { try { if (+fs.readFileSync(PID_FILE, 'utf8') === process.pid) fs.unlinkSync(PID_FILE); } catch (e) {} }
server.on('error', e => {
  if (e.code === 'EADDRINUSE') log(`port ${PORT} busy: Agent HQ is probably already running`);
  else log(e);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});
server.listen(PORT, HOST, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  log(`Agent HQ v3 at http://${HOST}:${PORT}/ (pid ${process.pid})`);
  engine.scanCodex();
  tick('start');
  setupWatchers();
  setInterval(() => tick('heartbeat'), 5000);                                   // time-based rules
  setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch (e) {} } }, 25000);
  setInterval(() => { if (watchers.length < 3) setupWatchers(); }, 60000);       // folders created later (e.g. first Codex run)
});
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { try { engine.persistStats(true); } catch (e) {} cleanup(); process.exit(0); });
process.on('uncaughtException', e => log('uncaught', e.stack || e));
